/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { ensureBuildArtifactsReadyOnce } from './testSetupBuildCoordinator'

function resolveCliProjectRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return resolve(__dirname, '..')
}

function resolveDistEntrypointPath(projectRoot: string): string {
  return join(projectRoot, 'dist', 'index.mjs')
}

function resolveBuildLockPath(projectRoot: string): string {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  return join(tmpdir(), `happier-cli-vitest-build-lock-${hash}`)
}

function resolveSharedDepsLockPath(projectRoot: string): string {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  return join(tmpdir(), `happier-cli-vitest-shared-deps-lock-${hash}`)
}

function resolveBundledProtocolDistMarkers(projectRoot: string): string[] {
  const protocolDistDir = join(projectRoot, 'node_modules', '@happier-dev', 'protocol', 'dist')
  return [
    join(protocolDistDir, 'sessionFork.js'),
    join(protocolDistDir, 'features', 'payload', 'isRecord.js'),
  ]
}

async function ensureSharedDepsBuiltOnce(projectRoot: string): Promise<void> {
  const markers = resolveBundledProtocolDistMarkers(projectRoot)
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveSharedDepsLockPath(projectRoot),
    markerPaths: markers,
    lockLabel: 'CLI shared deps build',
    runBuild: () => {
      const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
      const buildResult = spawnSync(yarnCommand, ['-s', 'build:shared'], {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      if (buildResult.error) {
        throw new Error(`CLI test globalSetup failed to run build:shared: ${buildResult.error.message}`)
      }

      if ((buildResult.status ?? 1) !== 0) {
        const exitCode = typeof buildResult.status === 'number' ? buildResult.status : 'unknown'
        const stdout = typeof buildResult.stdout === 'string' ? buildResult.stdout.trim() : ''
        const stderr = typeof buildResult.stderr === 'string' ? buildResult.stderr.trim() : ''
        const details = [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
          .filter(Boolean)
          .join('\n\n')

        throw new Error(
          `CLI test globalSetup build:shared failed (exit ${exitCode})${details ? `\n\n${details}` : ''}`,
        )
      }
    },
  })
}

async function ensureDistBuiltOnce(projectRoot: string): Promise<void> {
  const distEntrypoint = resolveDistEntrypointPath(projectRoot)
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveBuildLockPath(projectRoot),
    markerPaths: [distEntrypoint],
    lockLabel: 'CLI dist build',
    runBuild: () => {
      const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
      const buildResult = spawnSync(yarnCommand, ['build'], {
        cwd: projectRoot,
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

      if (!existsSync(distEntrypoint)) {
        throw new Error(`CLI test globalSetup build completed, but dist entrypoint is missing: ${distEntrypoint}`)
      }
    },
  })
}

export async function setup() {
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

  const projectRoot = resolveCliProjectRoot()
  await ensureSharedDepsBuiltOnce(projectRoot)
  await ensureDistBuiltOnce(projectRoot)
}

export default async function globalSetup() {
  await setup()
}
