import { join } from 'path'
import { promises as fs } from 'fs'
import { execa, ExecaChildProcess, ExecaError } from 'execa'
import crypto from 'crypto'
import { QueueManager } from './queueManager'
import dependencyService from '../dependencyService'
import mirrorService from '../mirrorService'
import settingsService from '../settingsService'
import { DownloadItem } from '@shared/types'
import { DownloadStatus } from '@shared/types'
import { getAvailableDiskSpace, parseSizeToBytes, formatBytes } from './utils'

// Type for VRP config - adjust if needed elsewhere
interface VrpConfig {
  baseUri?: string
  password?: string
}

export class DownloadProcessor {
  private activeDownloads: Map<string, ExecaChildProcess> = new Map()
  private queueManager: QueueManager
  private vrpConfig: VrpConfig | null = null
  private debouncedEmitUpdate: () => void

  constructor(queueManager: QueueManager, debouncedEmitUpdate: () => void) {
    this.queueManager = queueManager
    this.debouncedEmitUpdate = debouncedEmitUpdate
  }

  public setVrpConfig(config: VrpConfig | null): void {
    this.vrpConfig = config
  }

  // Add getter for vrpConfig
  public getVrpConfig(): VrpConfig | null {
    return this.vrpConfig
  }

  // Centralized update method using QueueManager and emitting update
  private updateItemStatus(
    releaseName: string,
    status: DownloadStatus,
    progress: number,
    error?: string,
    speed?: string,
    eta?: string,
    extractProgress?: number
  ): void {
    const updates: Partial<DownloadItem> = { status, progress, error, speed, eta }
    if (extractProgress !== undefined) {
      updates.extractProgress = extractProgress
    } else if (status !== 'Extracting' && status !== 'Completed') {
      updates.extractProgress = undefined
    }
    const updated = this.queueManager.updateItem(releaseName, updates)
    if (updated) {
      this.debouncedEmitUpdate() // Use the passed-in emitter
    }
  }

  public cancelDownload(
    releaseName: string,
    finalStatus: 'Cancelled' | 'Error' = 'Cancelled',
    errorMsg?: string
  ): void {
    const rcloneProcess = this.activeDownloads.get(releaseName)
    if (rcloneProcess) {
      console.log(`[DownProc] Cancelling download for ${releaseName}...`)
      try {
        rcloneProcess.kill('SIGTERM')
        console.log(`[DownProc] Cancelled download for ${releaseName}.`)
      } catch (cancelError) {
        console.error(`[DownProc] Error cancelling download for ${releaseName}:`, cancelError)
      }
      this.activeDownloads.delete(releaseName)
    } else {
      console.log(`[DownProc] No active download found for ${releaseName} to cancel.`)
    }

    // QueueManager handles the status update logic now
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      const updates: Partial<DownloadItem> = { pid: undefined }
      if (!(item.status === 'Error' && finalStatus === 'Cancelled')) {
        updates.status = finalStatus
      }
      if (finalStatus === 'Cancelled') {
        updates.progress = 0
      }
      if (finalStatus === 'Error') {
        updates.error = errorMsg || item.error
      } else {
        updates.error = undefined
      }

      const updated = this.queueManager.updateItem(releaseName, updates)
      if (updated) {
        console.log(
          `[DownProc] Updated status for ${releaseName} to ${finalStatus} via QueueManager.`
        )
        this.debouncedEmitUpdate() // Ensure UI update on cancel
      } else {
        console.warn(`[DownProc] Failed to update item ${releaseName} during cancellation.`)
      }
    } else {
      console.warn(`[DownProc] Item ${releaseName} not found in queue during cancellation.`)
    }
    // The main service will handle resetting isProcessing and calling processQueue
  }

  public async startDownload(
    item: DownloadItem
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Starting download for ${item.releaseName}...`)

    if (!this.vrpConfig?.baseUri || !this.vrpConfig?.password) {
      console.error('[DownProc] Missing VRP baseUri or password.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Missing VRP configuration')
      return { success: false, startExtraction: false }
    }

    const rclonePath = dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    const downloadPath = join(item.downloadPath, item.releaseName)
    this.queueManager.updateItem(item.releaseName, { downloadPath: downloadPath })

    try {
      await fs.mkdir(downloadPath, { recursive: true })
    } catch (mkdirError: unknown) {
      let errorMsg = `Failed to create directory ${downloadPath}`
      if (mkdirError instanceof Error) {
        errorMsg = `Failed to create directory: ${mkdirError.message}`
      }
      console.error(`[DownProc] Failed to create download directory ${downloadPath}:`, mkdirError)
      this.updateItemStatus(item.releaseName, 'Error', 0, errorMsg.substring(0, 500))
      return { success: false, startExtraction: false }
    }

    // Check available disk space before starting download
    console.log(`[DownProc] Checking available disk space for ${item.releaseName}...`)
    const availableSpace = await getAvailableDiskSpace(item.downloadPath)
    const gameSizeBytes = item.size ? parseSizeToBytes(item.size) : 0
    const requiredSpace = gameSizeBytes * 2 // Double the game size for download + extraction

    if (availableSpace === null) {
      console.warn(`[DownProc] Could not determine available disk space for ${item.releaseName}`)
    } else if (requiredSpace > 0 && availableSpace < requiredSpace) {
      const errorMsg = `Insufficient disk space. Required: ${formatBytes(requiredSpace)}, Available: ${formatBytes(availableSpace)}`
      console.error(`[DownProc] ${errorMsg} for ${item.releaseName}`)
      this.updateItemStatus(item.releaseName, 'Error', 0, errorMsg)
      return { success: false, startExtraction: false }
    } else if (requiredSpace > 0) {
      console.log(
        `[DownProc] Disk space check passed for ${item.releaseName}. Game size: ${item.size}, Available: ${formatBytes(availableSpace)}, Required: ${formatBytes(requiredSpace)}`
      )
    } else {
      console.warn(
        `[DownProc] Could not determine game size for ${item.releaseName}, skipping disk space check`
      )
    }

    this.updateItemStatus(item.releaseName, 'Downloading', 0)

    // Check if there's an active mirror to use
    const activeMirror = await mirrorService.getActiveMirror()

    if (activeMirror) {
      console.log(`[DownProc] Using active mirror: ${activeMirror.name}`)

      const configFilePath = mirrorService.getActiveMirrorConfigPath()
      const remoteName = mirrorService.getActiveMirrorRemoteName()

      if (!configFilePath || !remoteName) {
        console.warn(
          '[DownProc] Failed to get mirror config file path, falling back to public endpoint'
        )
      } else {
        try {
          console.log(`[DownProc] Using rclone copy with mirror: ${activeMirror.name}`)
          return await this.startRcloneCopy(item, downloadPath, {
            configFilePath,
            remoteName
          })
        } catch (mirrorError: unknown) {
          console.error(
            `[DownProc] Mirror download failed for ${item.releaseName}, falling back to public endpoint:`,
            mirrorError
          )
        }
      }
    }

    // Fall back to public endpoint using rclone copy
    console.log(`[DownProc] Using rclone copy for public endpoint: ${item.releaseName}`)
    return await this.startRcloneCopy(item, downloadPath)
  }

  // Download using rclone copy with progress tracking
  private async startRcloneCopy(
    item: DownloadItem,
    downloadPath: string,
    mirrorConfig?: { configFilePath: string; remoteName: string }
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Starting rclone copy for ${item.releaseName}...`)

    if (!this.vrpConfig?.baseUri || !this.vrpConfig?.password) {
      console.error('[DownProc] Missing VRP baseUri or password.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Missing VRP configuration')
      return { success: false, startExtraction: false }
    }

    const rclonePath = dependencyService.getRclonePath()
    if (!rclonePath) {
      console.error('[DownProc] Rclone path not found.')
      this.updateItemStatus(item.releaseName, 'Error', 0, 'Rclone dependency not found')
      return { success: false, startExtraction: false }
    }

    try {
      let rcloneArgs: string[]

      if (mirrorConfig) {
        // Use mirror configuration
        const source = `${mirrorConfig.remoteName}:/Quest Games/${item.releaseName}`
        console.log(`[DownProc] rclone copy source (mirror): ${source}`)

        rcloneArgs = [
          'copy',
          source,
          downloadPath,
          '--config',
          mirrorConfig.configFilePath,
          '--no-check-certificate',
          '--tpslimit',
          '1.0',
          '--tpslimit-burst',
          '3',
          '--progress',
          '--stats',
          '1s',
          '--stats-one-line'
        ]
      } else {
        // Use public endpoint configuration
        const gameNameHash = crypto
          .createHash('md5')
          .update(item.releaseName + '\n')
          .digest('hex')
        const source = `:http:/${gameNameHash}`

        const nullConfigPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
        console.log(`[DownProc] rclone copy source (public): ${source}`)

        rcloneArgs = [
          'copy',
          source,
          downloadPath,
          '--config',
          nullConfigPath,
          '--http-url',
          this.vrpConfig.baseUri,
          '--no-check-certificate',
          '--tpslimit',
          '1.0',
          '--tpslimit-burst',
          '3',
          '--progress',
          '--stats',
          '1s',
          '--stats-one-line'
        ]
      }

      // Apply bandwidth limit if configured
      const downloadSpeedLimit = settingsService.getDownloadSpeedLimit()
      if (downloadSpeedLimit > 0) {
        rcloneArgs.push('--bwlimit', `${downloadSpeedLimit}k`)
      }

      console.log(`[DownProc] Running: rclone ${rcloneArgs.join(' ')}`)

      const rcloneProcess = execa(rclonePath, rcloneArgs, {
        all: true,
        buffer: false,
        windowsHide: true
      })

      // Store the process for cancellation
      this.activeDownloads.set(item.releaseName, rcloneProcess)

      // Parse rclone progress output
      if (rcloneProcess.all) {
        rcloneProcess.all.on('data', (data: Buffer) => {
          const output = data.toString()

          // Parse rclone stats-one-line output
          // Example: "Transferred: 50.000 MiB / 100.000 MiB, 50%, 10.000 MiB/s, ETA 5s"
          const progressMatch = output.match(/Transferred:.*?(\d+)%/)
          const speedMatch = output.match(/(\d+\.?\d*\s*[KMGT]?i?B\/s)/)
          const etaMatch = output.match(/ETA\s+(\S+)/)

          if (progressMatch) {
            const progress = parseInt(progressMatch[1], 10)
            const speed = speedMatch ? speedMatch[1] : undefined
            const eta = etaMatch ? etaMatch[1] : undefined

            this.updateItemStatus(
              item.releaseName,
              'Downloading',
              progress,
              undefined,
              speed,
              eta
            )
          }
        })
      }

      // Wait for rclone to complete
      await rcloneProcess

      // Clean up
      this.activeDownloads.delete(item.releaseName)
      this.queueManager.updateItem(item.releaseName, { pid: undefined })

      // Verify final state
      const finalItemState = this.queueManager.findItem(item.releaseName)
      if (!finalItemState || finalItemState.status !== 'Downloading') {
        console.log(
          `[DownProc] rclone copy finished but status is ${finalItemState?.status} for ${item.releaseName}`
        )
        return { success: false, startExtraction: false, finalState: finalItemState }
      }

      console.log(`[DownProc] rclone copy completed successfully for ${item.releaseName}`)
      return { success: true, startExtraction: true, finalState: finalItemState }
    } catch (error: unknown) {
      const isExecaError = (err: unknown): err is ExecaError =>
        typeof err === 'object' && err !== null && 'shortMessage' in err

      const currentItemState = this.queueManager.findItem(item.releaseName)
      const statusBeforeCatch = currentItemState?.status ?? 'Unknown'

      console.error(`[DownProc] rclone copy error for ${item.releaseName}:`, error)

      // Clean up
      this.activeDownloads.delete(item.releaseName)
      this.queueManager.updateItem(item.releaseName, { pid: undefined })

      // Handle cancellation (SIGTERM = exit code 143)
      if (isExecaError(error) && (error.exitCode === 143 || error.isCanceled)) {
        console.log(`[DownProc] Download cancelled for ${item.releaseName}`)
        return { success: false, startExtraction: false, finalState: currentItemState }
      }

      // Handle other errors
      let errorMessage = 'Download failed.'
      if (isExecaError(error)) {
        errorMessage = error.shortMessage || error.message
      } else if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = String(error)
      }
      errorMessage = errorMessage.substring(0, 500)

      if (statusBeforeCatch !== 'Cancelled' && statusBeforeCatch !== 'Error') {
        this.updateItemStatus(
          item.releaseName,
          'Error',
          currentItemState?.progress ?? 0,
          errorMessage
        )
      }

      return {
        success: false,
        startExtraction: false,
        finalState: this.queueManager.findItem(item.releaseName)
      }
    }
  }

  // Method to pause a download
  public pauseDownload(releaseName: string): void {
    console.log(`[DownProc] Pausing download for ${releaseName}...`)

    const rcloneProcess = this.activeDownloads.get(releaseName)
    if (rcloneProcess) {
      try {
        rcloneProcess.kill('SIGTERM')
        console.log(`[DownProc] Stopped rclone process for ${releaseName}.`)
      } catch (cancelError) {
        console.error(`[DownProc] Error pausing download for ${releaseName}:`, cancelError)
      }
      this.activeDownloads.delete(releaseName)
    } else {
      console.log(`[DownProc] No active download found for ${releaseName} to pause.`)
    }

    // Update status to Paused
    const item = this.queueManager.findItem(releaseName)
    if (item) {
      const updated = this.queueManager.updateItem(releaseName, {
        status: 'Paused' as DownloadStatus,
        pid: undefined
      })
      if (updated) {
        console.log(`[DownProc] Updated status for ${releaseName} to Paused.`)
        this.debouncedEmitUpdate()
      }
    }
  }

  // Method to resume a paused download
  public async resumeDownload(
    item: DownloadItem
  ): Promise<{ success: boolean; startExtraction: boolean; finalState?: DownloadItem }> {
    console.log(`[DownProc] Resuming download for ${item.releaseName}...`)

    // Update status back to Downloading
    // rclone copy will automatically skip already-downloaded files
    this.updateItemStatus(item.releaseName, 'Downloading', item.progress ?? 0)

    return await this.startDownload(item)
  }

  // Method to check if a download is active
  public isDownloadActive(releaseName: string): boolean {
    return this.activeDownloads.has(releaseName)
  }
}
