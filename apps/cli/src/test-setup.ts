/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs'
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs'
import { ensureBuildArtifactsReadyOnce } from './testSetupBuildCoordinator'

export type CliTestBuildMode = 'shared-only' | 'full'

type CliTestSetupDependencies = {
  resolveProjectRoot: () => string
  ensureSharedDepsBuiltOnce: (projectRoot: string) => Promise<void>
  ensureDistBuiltOnce: (projectRoot: string) => Promise<void>
}

type CliTestSetupOptions = {
  buildMode?: CliTestBuildMode
  dependencies?: Partial<CliTestSetupDependencies>
}

function resolveCliProjectRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return resolve(__dirname, '..')
}

function resolveRepoRoot(projectRoot: string): string {
  let dir = resolve(projectRoot)
  for (let index = 0; index < 5; index += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'yarn.lock'))) {
      return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return resolve(projectRoot, '..', '..')
}

function resolveDistEntrypointPath(projectRoot: string): string {
  return join(projectRoot, 'dist', 'index.mjs')
}

function resolveBuildLockPath(projectRoot: string): string {
  return join(resolveRepoRoot(projectRoot), '.project', 'tmp', 'cli-dist-build.lock')
}

function resolveSharedDepsLockPath(projectRoot: string): string {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  return join(tmpdir(), `happier-cli-vitest-shared-deps-lock-${hash}`)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resolveBundledProtocolPackageDir(projectRoot: string): string {
  return join(projectRoot, 'node_modules', '@happier-dev', 'protocol')
}

function resolveProtocolSourcePackageJsonPath(projectRoot: string): string {
  return resolve(projectRoot, '..', '..', 'packages', 'protocol', 'package.json')
}

function resolveExternalProtocolRuntimeDependencyNames(projectRoot: string): string[] {
  const packageJsonPath = resolveProtocolSourcePackageJsonPath(projectRoot)
  if (!existsSync(packageJsonPath)) return []

  const packageJson = readJson(packageJsonPath) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  const externalDependencyNames = new Set<string>()

  for (const fields of [packageJson.dependencies, packageJson.optionalDependencies]) {
    if (!fields) continue
    for (const dependencyName of Object.keys(fields)) {
      if (dependencyName.startsWith('@happier-dev/')) continue
      externalDependencyNames.add(dependencyName)
    }
  }

  return [...externalDependencyNames]
}

function resolveBundledProtocolReadyMarkers(projectRoot: string): string[] {
  const protocolPackageDir = resolveBundledProtocolPackageDir(projectRoot)
  const protocolDistDir = join(protocolPackageDir, 'dist')
  const runtimeDependencyMarkers = resolveExternalProtocolRuntimeDependencyNames(projectRoot).map((dependencyName) =>
    join(protocolPackageDir, 'node_modules', ...dependencyName.split('/'), 'package.json'),
  )

  return [
    join(protocolDistDir, 'sessions', 'fork.js'),
    join(protocolDistDir, 'features', 'payload', 'isRecord.js'),
    ...runtimeDependencyMarkers,
  ]
}

function spawnYarnSync(args: readonly string[], cwd: string, env = process.env) {
  const invocation = resolveYarnCommandInvocation(args)
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  })
}

async function ensureSharedDepsBuiltOnce(projectRoot: string): Promise<void> {
  const markers = resolveBundledProtocolReadyMarkers(projectRoot)
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveSharedDepsLockPath(projectRoot),
    markerPaths: markers,
    lockLabel: 'CLI shared deps build',
    // The shared-deps build already validates the full workspace bundle set. For test setup,
    // we only need a concrete completion signal that is stable under concurrent rebuilds.
    runBuild: ({ heldLockValue }) => {
      const buildResult = spawnYarnSync(
        ['-s', 'build:shared'],
        projectRoot,
        createWorkspaceChildBuildEnv({ heldLockValue }),
      )

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
    runBuild: ({ heldLockValue }) => {
      const buildResult = spawnYarnSync(
        ['build'],
        projectRoot,
        createWorkspaceChildBuildEnv({ heldLockValue }),
      )

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

function readSkipBuildOverride(): boolean {
  const raw = process.env.HAPPIER_CLI_TEST_SKIP_BUILD
  if (typeof raw !== 'string') return false
  return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase())
}

export async function setup(options: CliTestSetupOptions = {}) {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  const skipBuild = readSkipBuildOverride()

  // Allow global opt-out for low-level setup tests and targeted local debugging.
  if (skipBuild) return

  const dependencies: CliTestSetupDependencies = {
    resolveProjectRoot: resolveCliProjectRoot,
    ensureSharedDepsBuiltOnce,
    ensureDistBuiltOnce,
    ...options.dependencies,
  }

  const buildMode = options.buildMode ?? 'full'
  const projectRoot = dependencies.resolveProjectRoot()

  await dependencies.ensureSharedDepsBuiltOnce(projectRoot)

  if (buildMode === 'full') {
    await dependencies.ensureDistBuiltOnce(projectRoot)
  }
}

export default async function globalSetup() {
  await setup()
}
