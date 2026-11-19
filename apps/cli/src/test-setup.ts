/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CLI_BINARY_TARGETS,
  PROCESS_CUSTODY_TARGET_ARCHES,
  execOrThrow,
  resolveCurrentBinaryTarget,
  resolveProcessCustodyRuntimeExecutableName,
  prepareProcessCustodyRuntime,
  isProcessCustodyRuntimeCurrent,
  isPublishedNativeArtifactCurrent,
  recordPublishedNativeArtifact,
  readProcessCustodyRuntimeInputIdentity,
  resolveProcessCustodyTargetExecutableRelativePath,
  stageProcessCustodyTargetRuntimes,
  type RunCommand,
} from '@happier-dev/cli-common/componentArtifacts'

import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs'
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs'
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs'
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

/** The per-Session holder the iroh-native builder stages beside its addon (required by Agent launches). */
export function resolveSessionHolderSourcePath(projectRoot: string): string {
  const platform = process.platform
  return join(resolveRepoRoot(projectRoot), 'packages', 'iroh-native', 'native',
    `happier-session-holder.${platform}-${process.arch}${platform === 'win32' ? '.exe' : ''}`)
}

type SessionTargetHolderArch = 'x64' | 'arm64'

type SessionHolderBuilder = Readonly<{
  buildSessionHolder(options: Readonly<{ packageDir: string; runCommand: RunCommand }>): Promise<string>
  readSessionHolderInputIdentity(options: Readonly<{ packageDir: string }>): string
  SESSION_TARGET_HOLDER_RUST_TARGETS: Readonly<Record<SessionTargetHolderArch, string>>
  resolveSessionTargetHolderArtifactName(arch: SessionTargetHolderArch): string
  readSessionTargetHolderInputIdentity(options: Readonly<{ packageDir: string; arch: SessionTargetHolderArch }>): string
  buildSessionTargetHolders(options: Readonly<{ packageDir: string; arches: readonly SessionTargetHolderArch[]; runCommand: RunCommand;
    prepareTargetToolchain(): void }>): Promise<string[]>
}>

/** The builder is this checkout's code owner; it builds the selected repository's holder. */
async function loadSessionHolderBuilder(): Promise<SessionHolderBuilder> {
  return await import(pathToFileURL(fileURLToPath(new URL('../../../packages/iroh-native/scripts/build-node-addon.mjs', import.meta.url))).href) as SessionHolderBuilder
}

function sessionHolderPublication(projectRoot: string) {
  return {
    executablePath: resolveSessionHolderSourcePath(projectRoot),
    identityPath: join(projectRoot, '.project', 'tmp', 'session-holder-publication.json'),
    packageDir: join(resolveRepoRoot(projectRoot), 'packages', 'iroh-native'),
  }
}

async function isSessionHolderCurrent(projectRoot: string, builder: SessionHolderBuilder): Promise<boolean> {
  const { executablePath, identityPath, packageDir } = sessionHolderPublication(projectRoot)
  return await isPublishedNativeArtifactCurrent({ identityPath, executablePath, executable: process.platform !== 'win32',
    inputIdentity: builder.readSessionHolderInputIdentity({ packageDir }) })
}

/**
 * The Session target holders (Linux musl, every target architecture: any Machine can drive a container of either)
 * that the managed target bootstrap places. Same holder sources, same readiness rule, each keyed on its own target.
 */
function sessionTargetHolderPublications(projectRoot: string, builder: SessionHolderBuilder) {
  const { packageDir } = sessionHolderPublication(projectRoot)
  return (Object.keys(builder.SESSION_TARGET_HOLDER_RUST_TARGETS) as SessionTargetHolderArch[]).map(arch => ({ arch,
    executablePath: join(packageDir, 'native', builder.resolveSessionTargetHolderArtifactName(arch)),
    identityPath: join(projectRoot, '.project', 'tmp', `session-target-holder-${arch}-publication.json`),
    inputIdentity: builder.readSessionTargetHolderInputIdentity({ packageDir, arch }) }))
}

async function staleSessionTargetHolders(projectRoot: string, builder: SessionHolderBuilder) {
  const stale = []
  for (const publication of sessionTargetHolderPublications(projectRoot, builder)) {
    if (!await isPublishedNativeArtifactCurrent({ ...publication, executable: true })) stale.push(publication)
  }
  return stale
}

async function processCustodyTargetPublications(projectRoot: string) {
  const repoRoot = resolveRepoRoot(projectRoot)
  return await Promise.all(PROCESS_CUSTODY_TARGET_ARCHES.map(async arch => ({
    executablePath: join(projectRoot, resolveProcessCustodyTargetExecutableRelativePath(arch)),
    identityPath: join(projectRoot, '.project', 'tmp', `process-custody-target-${arch}-publication.json`),
    inputIdentity: await readProcessCustodyRuntimeInputIdentity(repoRoot,
      resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS, platform: 'linux', arch })),
  })))
}

async function staleProcessCustodyTargets(projectRoot: string) {
  const stale = []
  for (const publication of await processCustodyTargetPublications(projectRoot)) {
    if (!await isPublishedNativeArtifactCurrent({ ...publication, executable: true })) stale.push(publication)
  }
  return stale
}

/**
 * Session target artifacts (the musl holders and the target custody helpers) are
 * read only by placed-Session (container) tests; a preparation for a selection
 * without them prepares this Machine's own artifacts only.
 */
export type NativeCustodyPreparationOptions = Readonly<{
  sessionTargets?: boolean
  log?: (line: string) => void
}>

function logNativeCustodyLine(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** One line per artifact, on by default: whether it was current or rebuilt, and how long that took. */
async function prepareLoggedArtifact(label: string, log: (line: string) => void, prepare: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now()
  const rebuilt = await prepare()
  log(`[native-custody] ${label} ${rebuilt ? 'rebuilt' : 'current'} ${Date.now() - startedAt}ms`)
}

/**
 * Single flight per artifact: a concurrent preparation of the same checkout
 * waits for the build in progress and then finds it current, instead of
 * queueing its own admitted build of the same inputs.
 */
async function withNativeArtifactPublication<T>(identityPath: string, work: () => Promise<T>): Promise<T> {
  return await withWorkspaceBundleLock(work, { lockPath: identityPath.replace(/\.json$/u, '.lock'), timeoutMs: null })
}

/**
 * The one CLI source native preparation: the Go process-custody helper and the
 * Rust Session holder. Each is ready only when built from the current sources
 * (recorded input identity + output digest), never because a file exists.
 */
export async function prepareNativeCustody(projectRoot: string, runCommand: RunCommand = execOrThrow,
  { sessionTargets = true, log = logNativeCustodyLine }: NativeCustodyPreparationOptions = {}): Promise<void> {
  const { target } = resolveNativeCustodyTarget(projectRoot)
  const repoRoot = resolveRepoRoot(projectRoot)
  await prepareLoggedArtifact(`process-custody ${target.os}-${target.arch}`, log, async () => {
    if (await isProcessCustodyRuntimeCurrent({ repoRoot, payloadDir: projectRoot, target })) return false
    await prepareProcessCustodyRuntime({ repoRoot, payloadDir: projectRoot, target, runCommand })
    return true
  })
  if (sessionTargets) {
    await prepareLoggedArtifact(`process-custody targets ${PROCESS_CUSTODY_TARGET_ARCHES.map(arch => `linux-${arch}`).join(',')}`, log, async () => {
      if (!(await staleProcessCustodyTargets(projectRoot)).length) return false
      const publications = await processCustodyTargetPublications(projectRoot)
      await stageProcessCustodyTargetRuntimes({ repoRoot, payloadDir: projectRoot, runCommand })
      const currentInputs = await processCustodyTargetPublications(projectRoot)
      for (const [index, publication] of publications.entries()) {
        if (currentInputs[index]?.inputIdentity !== publication.inputIdentity) {
          throw new Error('[native-custody] process custody sources changed during build; prepare again')
        }
        await recordPublishedNativeArtifact({ identityPath: publication.identityPath, inputIdentity: publication.inputIdentity,
          sha256: createHash('sha256').update(await readFile(publication.executablePath)).digest('hex') })
      }
      return true
    })
  }
  const builder = await loadSessionHolderBuilder()
  const { identityPath, packageDir } = sessionHolderPublication(projectRoot)
  await prepareLoggedArtifact(`session-holder ${process.platform}-${process.arch}`, log, () => withNativeArtifactPublication(identityPath, async () => {
    if (await isSessionHolderCurrent(projectRoot, builder)) return false
    const inputIdentity = builder.readSessionHolderInputIdentity({ packageDir })
    const artifact = await builder.buildSessionHolder({ packageDir, runCommand })
    if (builder.readSessionHolderInputIdentity({ packageDir }) !== inputIdentity) {
      throw new Error('[native-custody] Session holder sources changed during build; prepare again')
    }
    await recordPublishedNativeArtifact({ identityPath, inputIdentity,
      sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') })
    return true
  }))
  if (!sessionTargets) return
  for (const publication of sessionTargetHolderPublications(projectRoot, builder)) {
    await prepareLoggedArtifact(`session-holder target linux-${publication.arch}-musl`, log, () => withNativeArtifactPublication(publication.identityPath, async () => {
      const current = sessionTargetHolderPublications(projectRoot, builder).find(candidate => candidate.arch === publication.arch)!
      if (await isPublishedNativeArtifactCurrent({ ...current, executable: true })) return false
      // The target musl standard libraries are the Rust toolchain owner's (the preparation worker installs them).
      await builder.buildSessionTargetHolders({ packageDir, arches: [current.arch], runCommand,
        prepareTargetToolchain: () => undefined })
      if (builder.readSessionTargetHolderInputIdentity({ packageDir, arch: current.arch }) !== current.inputIdentity) {
        throw new Error('[native-custody] Session holder sources changed during build; prepare again')
      }
      await recordPublishedNativeArtifact({ identityPath: current.identityPath, inputIdentity: current.inputIdentity,
        sha256: createHash('sha256').update(await readFile(current.executablePath)).digest('hex') })
      return true
    }))
  }
}

/** Source collection never compiles: this Machine's native custody must already be current. */
export async function readStaleNativeCustody(projectRoot: string, { sessionTargets = false } = {}): Promise<string[]> {
  const { target, executablePath } = resolveNativeCustodyTarget(projectRoot)
  const stale: string[] = []
  if (!await isProcessCustodyRuntimeCurrent({ repoRoot: resolveRepoRoot(projectRoot), payloadDir: projectRoot, target })) stale.push(executablePath)
  const builder = await loadSessionHolderBuilder()
  if (!await isSessionHolderCurrent(projectRoot, builder)) stale.push(resolveSessionHolderSourcePath(projectRoot))
  if (sessionTargets) stale.push(...await readStaleSessionTargetArtifacts(projectRoot, builder))
  return stale
}

async function assertNativeCustodyCurrent(projectRoot: string): Promise<void> {
  const stale = await readStaleNativeCustody(projectRoot)
  if (stale.length) {
    throw new Error(`CLI source tests require public native preparation (missing or built from older sources): ${stale.join(', ')}`)
  }
}

/**
 * A placed-Session test reads the Session target artifacts. Preparation builds
 * them only for selections that include such a test, so the test refuses
 * artifacts that are missing or built from older sources rather than run them.
 */
async function readStaleSessionTargetArtifacts(projectRoot: string, builder: SessionHolderBuilder): Promise<string[]> {
  return [...(await staleProcessCustodyTargets(projectRoot)), ...(await staleSessionTargetHolders(projectRoot, builder))]
    .map(target => target.executablePath)
}

export async function assertSessionTargetArtifactsCurrent(projectRoot: string = resolveCliProjectRoot()): Promise<void> {
  const stale = await readStaleSessionTargetArtifacts(projectRoot, await loadSessionHolderBuilder())
  if (stale.length) {
    throw new Error(`Session target tests require native preparation of the target artifacts (missing or built from older sources): ${stale.join(', ')}`)
  }
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
    await assertNativeCustodyCurrent(projectRoot)
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
