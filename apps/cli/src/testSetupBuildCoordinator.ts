import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'

type EnsureBuildArtifactsReadyOnceOptions = {
  lockPath: string
  markerPaths: readonly string[]
  lockLabel: string
  runBuild: () => Promise<void> | void
  timeoutMs?: number
  pollIntervalMs?: number
  staleAfterMs?: number
  isProcessAlive?: (pid: number) => boolean
}

type BuildLockMetadata = {
  pid: number
  createdAtMs: number
}

const DEFAULT_BUILD_LOCK_TIMEOUT_MS = readPositiveIntegerEnv('HAPPIER_CLI_TEST_BUILD_LOCK_TIMEOUT_MS', 240_000)
const DEFAULT_BUILD_LOCK_POLL_INTERVAL_MS = readPositiveIntegerEnv(
  'HAPPIER_CLI_TEST_BUILD_LOCK_POLL_INTERVAL_MS',
  250,
)
const DEFAULT_BUILD_LOCK_STALE_AFTER_MS = readPositiveIntegerEnv(
  'HAPPIER_CLI_TEST_BUILD_LOCK_STALE_AFTER_MS',
  60_000,
)

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (typeof raw !== 'string') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function buildMarkersExist(markerPaths: readonly string[]): boolean {
  return markerPaths.every((markerPath) => existsSync(markerPath))
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: string }).code
      if (code === 'EPERM') return true
      if (code === 'ESRCH') return false
    }
    throw error
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function serializeBuildLockMetadata(metadata: BuildLockMetadata): string {
  return `${JSON.stringify(metadata)}\n`
}

async function writeBuildLockMetadata(lockPath: string): Promise<void> {
  const metadata: BuildLockMetadata = {
    pid: process.pid,
    createdAtMs: Date.now(),
  }
  await fs.writeFile(lockPath, serializeBuildLockMetadata(metadata), 'utf8')
}

async function tryAcquireBuildLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, 'wx')
    try {
      await handle.writeFile(serializeBuildLockMetadata({ pid: process.pid, createdAtMs: Date.now() }), 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

function parseBuildLockMetadata(raw: string): BuildLockMetadata | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<BuildLockMetadata>
    const pid = parsed.pid
    const createdAtMs = parsed.createdAtMs
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null
    return {
      pid,
      createdAtMs,
    }
  } catch {
    return null
  }
}

async function reclaimStaleBuildLock(params: {
  lockPath: string
  staleAfterMs: number
  isProcessAlive: (pid: number) => boolean
}): Promise<boolean> {
  const { lockPath, staleAfterMs, isProcessAlive } = params

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(lockPath)
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }

  let raw = ''
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }

  const metadata = parseBuildLockMetadata(raw)
  if (metadata) {
    if (!isProcessAlive(metadata.pid)) {
      await fs.rm(lockPath, { force: true }).catch(() => undefined)
      return true
    }

    if (Date.now() - metadata.createdAtMs < staleAfterMs) return false

    await fs.rm(lockPath, { force: true }).catch(() => undefined)
    return true
  }

  if (Date.now() - stats.mtimeMs < staleAfterMs) return false

  await fs.rm(lockPath, { force: true }).catch(() => undefined)
  return true
}

export async function ensureBuildArtifactsReadyOnce(
  options: EnsureBuildArtifactsReadyOnceOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_LOCK_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BUILD_LOCK_POLL_INTERVAL_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_BUILD_LOCK_STALE_AFTER_MS
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const startedAt = Date.now()

  while (true) {
    if (buildMarkersExist(options.markerPaths)) return

    if (await tryAcquireBuildLock(options.lockPath)) {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      try {
        if (staleAfterMs > 0) {
          const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250))
          heartbeatTimer = setInterval(() => {
            void writeBuildLockMetadata(options.lockPath).catch(() => undefined)
          }, heartbeatIntervalMs)
          heartbeatTimer.unref?.()
        }

        if (buildMarkersExist(options.markerPaths)) return
        await options.runBuild()
        return
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        await fs.rm(options.lockPath, { force: true }).catch(() => undefined)
      }
    }

    if (await reclaimStaleBuildLock({ lockPath: options.lockPath, staleAfterMs, isProcessAlive })) {
      continue
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${options.lockLabel} lock: ${options.lockPath}`)
    }

    await sleep(pollIntervalMs)
  }
}
