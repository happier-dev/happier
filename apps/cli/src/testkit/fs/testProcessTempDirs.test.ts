import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { withTempDirSync } from '@/testkit/fs/tempDir'
import {
  resolveTestProcessTempDir,
  sweepOrphanedTestProcessTempDirs,
} from '@/testkit/fs/testProcessTempDirs'

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (typeof child.pid !== 'number') throw new Error('failed to spawn probe process')
  return child.pid
}

describe('test process temp dirs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes per-process dirs whose owner process exited and keeps live or unrelated ones', () => {
    withTempDirSync('happier-cli-test-process-dirs-', (baseDir) => {
      const deadPid = exitedPid()
      const liveHome = resolveTestProcessTempDir('home', process.pid, baseDir)
      const liveBin = resolveTestProcessTempDir('bin', process.pid, baseDir)
      const deadHome = resolveTestProcessTempDir('home', deadPid, baseDir)
      const deadBin = resolveTestProcessTempDir('bin', deadPid, baseDir)
      const unrelated = join(baseDir, 'happier-cli-vitest-build-lock-123456')
      for (const dir of [liveHome, liveBin, deadHome, deadBin, unrelated]) {
        mkdirSync(join(dir, 'nested'), { recursive: true })
      }

      sweepOrphanedTestProcessTempDirs(baseDir)

      expect(existsSync(deadHome)).toBe(false)
      expect(existsSync(deadBin)).toBe(false)
      expect(readdirSync(baseDir).sort()).toEqual(
        [liveBin, liveHome, unrelated].map((dir) => dir.slice(baseDir.length + 1)).sort(),
      )
    })
  })

  // A shared tmpdir can hold a dead worker's dir that this user may not delete (another user's run).
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves undeletable orphaned dirs in place and keeps sweeping',
    () => {
      withTempDirSync('happier-cli-test-process-dirs-', (baseDir) => {
        const lockedHome = resolveTestProcessTempDir('home', exitedPid(), baseDir)
        const deadBin = resolveTestProcessTempDir('bin', exitedPid(), baseDir)
        const lockedDir = join(lockedHome, 'locked')
        mkdirSync(lockedDir, { recursive: true })
        writeFileSync(join(lockedDir, 'file'), '')
        mkdirSync(deadBin, { recursive: true })
        chmodSync(lockedDir, 0o500)
        try {
          expect(() => sweepOrphanedTestProcessTempDirs(baseDir)).not.toThrow()
          expect(existsSync(lockedHome)).toBe(true)
          expect(existsSync(deadBin)).toBe(false)
        } finally {
          chmodSync(lockedDir, 0o700)
        }
      })
    },
  )

  it('keeps dirs whose owner liveness probe fails for a reason other than ESRCH', () => {
    withTempDirSync('happier-cli-test-process-dirs-', (baseDir) => {
      const unverifiedHome = resolveTestProcessTempDir('home', 424242, baseDir)
      mkdirSync(unverifiedHome, { recursive: true })
      // process.kill is the OS process boundary; an EIO probe failure is not proof the owner exited.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('probe failed'), { code: 'EIO' })
      })

      sweepOrphanedTestProcessTempDirs(baseDir)

      expect(existsSync(unverifiedHome)).toBe(true)
    })
  })
})
