import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Per-process temp dirs created by `vitestSetup.ts` for each forked test worker. Workers are
// often terminated without running exit hooks, so the global setup also sweeps dirs whose owner
// process is gone. Liveness, not mtime, decides: a concurrent run in another checkout shares tmpdir.
export type TestProcessTempDirKind = 'home' | 'bin'

const DIR_PREFIX_BY_KIND: Record<TestProcessTempDirKind, string> = {
  home: 'happier-dev-test-',
  bin: 'happier-dev-test-bin-',
}

const OWNED_DIR_PATTERN = /^happier-dev-test-(?:bin-)?(\d+)$/

export function resolveTestProcessTempDir(
  kind: TestProcessTempDirKind,
  pid = process.pid,
  baseDir = tmpdir(),
): string {
  return join(baseDir, `${DIR_PREFIX_BY_KIND[kind]}${pid}`)
}

export function removeTestProcessTempDirsOnExit(dirs: readonly string[]): void {
  process.once('exit', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves the owner is gone; EPERM and probe failures keep the dir.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM'
}

export function sweepOrphanedTestProcessTempDirs(baseDir = tmpdir()): void {
  for (const name of readdirSync(baseDir)) {
    const ownerPid = name.match(OWNED_DIR_PATTERN)?.[1]
    if (!ownerPid) continue
    if (isProcessAlive(Number(ownerPid))) continue
    try {
      rmSync(join(baseDir, name), { recursive: true, force: true })
    } catch (error) {
      // A shared tmpdir can hold another user's orphaned dir; leave it rather than abort the run.
      if (!isPermissionError(error)) throw error
    }
  }
}
