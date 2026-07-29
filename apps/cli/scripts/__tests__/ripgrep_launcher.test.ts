import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  resolvePackagedRipgrepBinaryPath,
} = require('../ripgrep_runtime_paths.cjs') as {
  resolvePackagedRipgrepBinaryPath(toolsDir: string, platform?: NodeJS.Platform): string
}

type LauncherRun = SpawnSyncReturns<string>

function runLauncher(argv: string[]): LauncherRun {
  return spawnSync(process.execPath, [join(__dirname, '../ripgrep_launcher.cjs'), ...argv], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

describe('ripgrep launcher behavior', () => {
  it('selects the packaged Windows executable when the native addon is unavailable', () => {
    expect(resolvePackagedRipgrepBinaryPath('C:\\happier\\tools\\unpacked', 'win32'))
      .toBe(join('C:\\happier\\tools\\unpacked', 'rg.exe'))
  })

  it('exits with an error when JSON argv is missing', () => {
    const result = runLauncher([])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing arguments: expected JSON-encoded argv')
  })

  it('exits with an error when JSON argv is invalid', () => {
    const result = runLauncher(['{not-json}'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Failed to parse arguments:')
  })

  it('handles --version invocation without throwing', () => {
    const result = runLauncher([JSON.stringify(['--version'])])

    expect(result.status).toBe(0)
    expect(result.error).toBeUndefined()
    expect(`${result.stdout}${result.stderr}`).not.toContain('Missing arguments: expected JSON-encoded argv')
  })
})
