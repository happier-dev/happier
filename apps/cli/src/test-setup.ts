/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CLI_BINARY_TARGETS,
  execOrThrow,
  resolveCurrentBinaryTarget,
  resolveProcessCustodyRuntimeExecutableName,
  stageProcessCustodyRuntime,
  type RunCommand,
} from '@happier-dev/cli-common/componentArtifacts'

import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs'
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs'
import { readBundledPluginPackageNames } from '../scripts/build-owned/bundledPluginMembership'
import { ensureBuildArtifactsReadyOnce, withCliTestBuildLock } from './testSetupBuildCoordinator'
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
  const distEntrypoint = resolveDistEntrypointPath(projectRoot)
  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveBuildLockPath(projectRoot),
    markerPaths: [distEntrypoint],
    lockLabel: 'CLI dist build',
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
  // Go owns source/module/build-cache currentness. An existing executable is
  // only an artifact-presence fact, never proof that current source was built.
  await withCliTestBuildLock({
    lockPath: resolveBuildLockPath(projectRoot),
    lockLabel: 'CLI native process custody',
  }, async () => {
    await stageProcessCustodyRuntime({
      repoRoot: resolveRepoRoot(projectRoot),
      payloadDir: projectRoot,
      target,
      runCommand,
    })
  })
}

async function ensureBundledPluginPublicationReady(projectRoot: string): Promise<void> {
  const repoRoot = resolveRepoRoot(projectRoot)
  const workspaceNames = readBundledPluginPackageNames(repoRoot)
  if (workspaceNames.length === 0) return

  // The JavaScript build owner owns preparation, currentness and publication
  // locks. Do not treat a leftover failure inventory as proof of readiness.
  const modulePath = join(repoRoot, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs')
  const owner = await import(pathToFileURL(modulePath).href) as {
    prepareBundledWorkspaceDependenciesForCli: (options: Readonly<{
      repoRoot: string
      env: NodeJS.ProcessEnv
      publicationMode: 'live'
      deferPluginBuildToGenerator: true
    }>) => Promise<unknown>
    publishBundledPluginArtifactsAfterWorkspaceBuild: (options: Readonly<{
      repoRoot: string
      workspaceNames: readonly string[]
      env: NodeJS.ProcessEnv
      publicationMode: 'live'
      bundledPluginArtifactPublication: Readonly<{ mode: 'write'; targetOwnedOnly: true }>
    }>) => Promise<boolean>
  }
  // Match the existing CLI preparation order: build the derived non-plugin
  // closure before the generator reads Agents compiler inputs. Plugin builds
  // remain deferred until their canonical publisher has serialized manifests.
  await owner.prepareBundledWorkspaceDependenciesForCli({
    repoRoot,
    env: process.env,
    publicationMode: 'live',
    deferPluginBuildToGenerator: true,
  })
  await owner.publishBundledPluginArtifactsAfterWorkspaceBuild({
    repoRoot,
    workspaceNames,
    env: process.env,
    publicationMode: 'live',
    // Source-test replicas own ignored manifests/runtime bytes, not tracked
    // host projections. The same bounded output scope is safe for local tests.
    bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
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

  await ensureBundledPluginPublicationReady(projectRoot)

  if (buildMode === 'full') {
    await dependencies.ensureDistBuiltOnce(projectRoot)
  }
}

export default async function globalSetup() {
  await setup()
}
