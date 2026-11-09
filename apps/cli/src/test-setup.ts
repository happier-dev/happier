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
  prepareProcessCustodyRuntime,
  type RunCommand,
} from '@happier-dev/cli-common/componentArtifacts'

import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs'
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs'
import { ensureBuildArtifactsReadyOnce } from './testSetupBuildCoordinator'
import { isCliTestBuildSkipped } from '../scripts/vitestPreparation.mjs'

export type CliTestBuildMode = 'none' | 'full'

type CliTestSetupDependencies = {
  platform: NodeJS.Platform
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
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'pnpm-lock.yaml')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) {
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

function spawnPnpmSync(args: readonly string[], cwd: string, env = process.env) {
  const invocation = resolvePnpmCommandInvocation(args, { npmExecPath: env.npm_execpath })
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
  // Native/source-only preparation imports this module too. Load the compiled
  // dist owners only for a consumer that actually needs the compiled payload.
  const inputOwnerUrl = new URL('../../stack/scripts/utils/proc/cli_runtime_inputs.mjs', import.meta.url).href
  const readinessOwnerUrl = new URL('../../stack/scripts/utils/proc/pm.mjs', import.meta.url).href
  const [{ readHappyCliRuntimeInputFreshness }, { isCliDistFreshForInputs }] = await Promise.all([
    import(inputOwnerUrl) as Promise<typeof import('../../stack/scripts/utils/proc/cli_runtime_inputs.mjs')>,
    import(readinessOwnerUrl) as Promise<typeof import('../../stack/scripts/utils/proc/pm.mjs')>,
  ])
  const distEntrypoint = resolveDistEntrypointPath(projectRoot)
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveBuildLockPath(projectRoot),
    markerPaths: [distEntrypoint],
    lockLabel: 'CLI dist build',
    isReady: async () => isCliDistFreshForInputs(
      distEntrypoint,
      await readHappyCliRuntimeInputFreshness(projectRoot),
    ),
    runBuild: ({ heldLockValue }) => {
      const buildResult = spawnPnpmSync(
        ['run', 'build'],
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

export function resolveNativeCustodyTarget(projectRoot: string) {
  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS })
  const executablePath = join(projectRoot, 'tools', 'unpacked', resolveProcessCustodyRuntimeExecutableName(target))
  return { target, executablePath }
}

export async function prepareNativeCustody(projectRoot: string, runCommand: RunCommand = execOrThrow): Promise<void> {
  const { target } = resolveNativeCustodyTarget(projectRoot)
  await prepareProcessCustodyRuntime({
    repoRoot: resolveRepoRoot(projectRoot), payloadDir: projectRoot, target, runCommand,
  })
}

export async function setup(options: CliTestSetupOptions = {}) {
  // Extend test timeout for integration tests
  process.env.VITEST_POOL_TIMEOUT = '60000'

  const dependencies: CliTestSetupDependencies = {
    platform: process.platform,
    resolveProjectRoot: resolveCliProjectRoot,
    ensureDistBuiltOnce,
    runCommand: execOrThrow,
    ...options.dependencies,
  }

  const buildMode = isCliTestBuildSkipped() ? 'none' : options.buildMode ?? 'full'
  const projectRoot = dependencies.resolveProjectRoot()

  // POSIX public dispatch prepares current native source before charging the
  // test payload. Windows has no such preflight; full/artifact setup retains
  // its existing producer phase. Source collection itself must not compile.
  if (buildMode === 'none' && dependencies.platform !== 'win32') {
    const { executablePath } = resolveNativeCustodyTarget(projectRoot)
    if (!existsSync(executablePath)) {
      throw new Error(`CLI source tests require public native preparation: ${executablePath}`)
    }
  } else {
    await prepareNativeCustody(projectRoot, dependencies.runCommand)
  }
  if (buildMode === 'none') return

  if (buildMode === 'full') {
    // Public validation prepares workspace dependencies before admission.
    // A cold/stale dist still goes through build's canonical prebuild; current
    // artifacts must not start another workspace publisher inside the reader.
    await dependencies.ensureDistBuiltOnce(projectRoot)
  }
}

export default async function globalSetup() {
  await setup()
}
