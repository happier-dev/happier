import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

type LauncherRun = SpawnSyncReturns<string>
const require = createRequire(import.meta.url)

const fixtureRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runLauncher(argv: string[], launcherPath = join(__dirname, '../ripgrep_launcher.cjs'), env = process.env): LauncherRun {
  return spawnSync(process.execPath, [launcherPath, ...argv], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  })
}

function createPackagedLauncherFixture(): { launcherPath: string; toolsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'happier-ripgrep-launcher-'))
  fixtureRoots.push(root)
  const scriptsDir = join(root, 'scripts')
  const toolsDir = join(root, 'tools', 'unpacked')
  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(toolsDir, { recursive: true })
  cpSync(join(__dirname, '../ripgrep_launcher.cjs'), join(scriptsDir, 'ripgrep_launcher.cjs'))
  cpSync(join(__dirname, '../childProcessOptions.cjs'), join(scriptsDir, 'childProcessOptions.cjs'))
  cpSync(join(__dirname, '../ripgrep_runtime_paths.cjs'), join(scriptsDir, 'ripgrep_runtime_paths.cjs'))
  return { launcherPath: join(scriptsDir, 'ripgrep_launcher.cjs'), toolsDir }
}

describe('ripgrep launcher behavior', () => {
  it('reports missing native ripgrep distinctly instead of simulating an empty successful search', () => {
    const launcher = require(join(__dirname, '../ripgrep_launcher.cjs')) as { main: (argv: string[]) => number }
    // These are native filesystem/process lookup boundaries, not launcher domain logic.
    vi.spyOn(require('fs') as typeof import('node:fs'), 'existsSync').mockReturnValue(false)
    vi.spyOn(require('child_process') as typeof import('node:child_process'), 'execFileSync').mockImplementation(() => {
      throw new Error('fixture: no system ripgrep')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(launcher.main([JSON.stringify(['needle'])])).toBe(127)
    expect(launcher.main([JSON.stringify(['--version'])])).toBe(127)
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

  it.skipIf(process.platform === 'win32')('uses the packaged binary without an addon or system PATH and preserves argv, output, and exit code', () => {
    const fixture = createPackagedLauncherFixture()
    const binaryPath = join(fixture.toolsDir, 'rg')
    writeFileSync(binaryPath, `#!/bin/sh
printf 'stdout:%s\\n' "$*"
printf 'stderr:%s\\n' "$*" >&2
exit 7
`)
    chmodSync(binaryPath, 0o755)

    const result = runLauncher(
      [JSON.stringify(['needle with spaces', '--glob', '*.ts'])],
      fixture.launcherPath,
      { ...process.env, PATH: '' },
    )

    expect(result.status).toBe(7)
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('stdout:needle with spaces --glob *.ts')
    expect(result.stderr).toContain('stderr:needle with spaces --glob *.ts')
    expect(result.stderr).not.toMatch(/native addon|system ripgrep|packaged ripgrep binary/i)
  })

  it.skipIf(process.platform === 'win32')('exits unsuccessfully when the packaged binary is terminated by a signal', () => {
    const fixture = createPackagedLauncherFixture()
    const binaryPath = join(fixture.toolsDir, 'rg')
    writeFileSync(binaryPath, '#!/bin/sh\nkill -TERM $$\n')
    chmodSync(binaryPath, 0o755)

    const result = runLauncher(
      [JSON.stringify(['--version'])],
      fixture.launcherPath,
      { ...process.env, PATH: '' },
    )

    expect(result.status).toBe(1)
  })

  it('resolves the Windows packaged executable name', () => {
    const fixture = createPackagedLauncherFixture()
    const binaryPath = join(fixture.toolsDir, 'rg.exe')
    writeFileSync(binaryPath, 'windows rg fixture')

    const launcher = require(fixture.launcherPath) as {
      resolvePackagedRipgrepPath: (toolsDir: string, platform: NodeJS.Platform) => string | null
    }

    expect(launcher.resolvePackagedRipgrepPath(fixture.toolsDir, 'win32')).toBe(binaryPath)
  })

  it.skipIf(process.platform === 'win32')('preserves the system fallback when the packaged binary is absent', () => {
    const fixture = createPackagedLauncherFixture()
    const binDir = join(fixture.toolsDir, '..', '..', 'bin')
    const binaryPath = join(binDir, 'rg')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(binaryPath, '#!/bin/sh\nprintf \'system-ripgrep\\n\'\n')
    chmodSync(binaryPath, 0o755)

    const result = runLauncher(
      [JSON.stringify(['--version'])],
      fixture.launcherPath,
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('system-ripgrep')
    expect(result.stderr).toContain(`Using system ripgrep: ${binaryPath}`)
  })
})
