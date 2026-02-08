/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'

export function setup() {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  const skipBuild = (() => {
    const raw = process.env.HAPPIER_CLI_TEST_SKIP_BUILD
    if (typeof raw !== 'string') return false
    return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase())
  })()

  // Make sure to build the project before running tests (opt-out).
  // We rely on the dist files to spawn our CLI in some integration tests.
  if (skipBuild) return

  const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
  const buildResult = spawnSync(yarnCommand, ['build'], {
    stdio: 'pipe',
    encoding: 'utf8',
  })

  if (buildResult.error) {
    throw new Error(`CLI test globalSetup failed to run build: ${buildResult.error.message}`)
  }

  if ((buildResult.status ?? 1) !== 0) {
    const exitCode = typeof buildResult.status === 'number' ? buildResult.status : 'unknown'
    const stdout = typeof buildResult.stdout === 'string' ? buildResult.stdout.trim() : ''
    const stderr = typeof buildResult.stderr === 'string' ? buildResult.stderr.trim() : ''
    const details = [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
      .filter(Boolean)
      .join('\n\n')

    throw new Error(
      `CLI test globalSetup build failed (exit ${exitCode})${details ? `\n\n${details}` : ''}`,
    )
  }
}
