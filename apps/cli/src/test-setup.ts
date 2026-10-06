/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLI_BINARY_TARGETS,
  execOrThrow,
  resolveCurrentBinaryTarget,
  resolveProcessCustodyRuntimeExecutableName,
  stageProcessCustodyRuntime,
  type RunCommand,
} from '@happier-dev/cli-common/componentArtifacts'

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs'
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs'
import { ensureBuildArtifactsReadyOnce } from './testSetupBuildCoordinator'

export type CliTestBuildMode = 'none' | 'full'

type CliTestSetupDependencies = {
  resolveProjectRoot: () => string
  ensureDistBuiltOnce: (projectRoot: string) => Promise<void>
  runCommand: RunCommand
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

async function ensureNativeCustodyReadyOnce(projectRoot: string, runCommand: RunCommand): Promise<void> {
  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS })
  const executablePath = join(projectRoot, 'tools', 'unpacked', resolveProcessCustodyRuntimeExecutableName(target))
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveBuildLockPath(projectRoot),
    markerPaths: [executablePath],
    lockLabel: 'CLI native process custody',
    runBuild: async () => {
      await stageProcessCustodyRuntime({
        repoRoot: resolveRepoRoot(projectRoot),
        payloadDir: projectRoot,
        target,
        runCommand,
      })
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

  const dependencies: CliTestSetupDependencies = {
    resolveProjectRoot: resolveCliProjectRoot,
    ensureDistBuiltOnce,
    runCommand: execOrThrow,
    ...options.dependencies,
  }

  const buildMode = options.buildMode ?? 'full'
  const projectRoot = dependencies.resolveProjectRoot()

  // Source tests exercise native confinement without publishing the full CLI
  // dist. Prepare that prerequisite through the same staging owner as releases.
  await ensureNativeCustodyReadyOnce(projectRoot, dependencies.runCommand)

  if (skipBuild || buildMode === 'none') return

  if (buildMode === 'full') {
    await dependencies.ensureDistBuiltOnce(projectRoot)
  }
}

export default async function globalSetup() {
  await setup()
}
