import { existsSync } from 'node:fs'

import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs'

type BuildLockContext = Readonly<{
  heldLockValue: string
}>

type EnsureBuildArtifactsReadyOnceOptions = {
  lockPath: string
  markerPaths: readonly string[]
  lockLabel: string
  runBuild: (context: BuildLockContext) => Promise<void> | void
  isReady?: () => boolean | Promise<boolean>
  timeoutMs?: number
  pollIntervalMs?: number
  staleAfterMs?: number
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

async function buildArtifactsAreReady(
  markerPaths: readonly string[],
  isReady?: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (isReady) return await isReady()
  return buildMarkersExist(markerPaths)
}

export async function ensureBuildArtifactsReadyOnce(
  options: EnsureBuildArtifactsReadyOnceOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_LOCK_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BUILD_LOCK_POLL_INTERVAL_MS
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_BUILD_LOCK_STALE_AFTER_MS

  await withWorkspaceBundleLock(
    async ({ heldLockValue }) => {
      // Existing outputs are trustworthy only while the canonical publication lock is held.
      if (await buildArtifactsAreReady(options.markerPaths, options.isReady)) return

      await options.runBuild({ heldLockValue })
      if (!(await buildArtifactsAreReady(options.markerPaths, options.isReady))) {
        throw new Error(`CLI ${options.lockLabel} build completed, but required outputs are still not ready`)
      }
    },
    {
      lockPath: options.lockPath,
      heldLockValue: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs,
      errorLabel: `${options.lockLabel} lock`,
    },
  )
}
