/**
 * Cross-platform Happier CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happier.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happier.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happier.cmd` and `happier.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happier` command
 * 2. Shell directly executes `bin/happier.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happier.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happier` command  
 * 2. NPM wrapper (`happier.cmd`) calls `node bin/happier.mjs`
 * 3. `bin/happier.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happier CLI as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happier.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn(process.execPath, ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';
import { stripCliApiTokenEnvironment } from '@/auth/cliApiToken';
import { createRequire } from 'node:module';
import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import { buildMissingJavaScriptRuntimeMessage } from '@/packagedRuntime/js/buildMissingJavaScriptRuntimeMessage';
import { resolvePackagedRuntimeEntrypoint } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { parseOptionalBooleanEnv } from '@happier-dev/protocol';
import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '@happier-dev/cli-common/cliRuntimeSidecars';
import {
  copyCliNodeWorkspaceRuntimePackages,
  copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot,
  readCliNodeWorkspaceRuntimeIdentity,
} from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import {
  decidePinnedRunnerSnapshotPrune,
  type LiveRunnerSnapshotFingerprints,
} from './pinnedRunnerSnapshotPrune';
import {
  explainPinnedRunnerSnapshotUnreadiness,
  isPinnedRunnerSnapshotReady,
  listReadyPinnedRunnerSnapshots,
  PINNED_RUNNER_LAYOUT_VERSION,
  resolveNewestReadyPinnedRunnerSnapshot,
  resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity,
  type PinnedRunnerSnapshotLocation,
} from '@happier-dev/cli-common/pinnedRunnerSnapshot';

const STACK_RUNTIME_STATE_PATH_ENV = 'HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH';
const STACK_DIST_ENTRYPOINT_ENV = 'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT';
const DAEMON_DIST_CLOSURE_FINGERPRINT_ENV = 'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT';
const WORKSPACE_DIST_BUILD_LOCK_HELD_ENV = 'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD';
const RUNTIME_BACKED_SUBPROCESS_ENV = 'HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED';
const PINNED_RUNNER_DIST_DIR = '.runner-snapshots';
const PINNED_RUNNER_NO_WORKSPACE_RUNTIME_SHA256 = createHash('sha256')
  .update('happier:pinned-runner:no-workspace-runtime:v1')
  .digest('hex');

function getSubprocessRuntime(env: NodeJS.ProcessEnv = process.env): 'node' | 'bun' {
  const override = env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  if (override === 'node' || override === 'bun') return override;
  return isBun() ? 'bun' : 'node';
}

export function resolveTsxImportHookPath(): string | null {
  // `node --import tsx` resolves `tsx` relative to the current working directory.
  // Daemon-spawned sessions intentionally run in arbitrary `cwd`s (e.g. /Users/leeroy),
  // so we must use an absolute path to the tsx ESM register hook.
  try {
    const req = createRequire(import.meta.url);
    // Avoid package export maps by resolving package.json and building a file path.
    const pkgJsonPath = req.resolve('tsx/package.json');
    const pkgDir = dirname(pkgJsonPath);
    const hookPath = join(pkgDir, 'dist', 'esm', 'index.mjs');
    if (existsSync(hookPath)) return hookPath;
    return null;
  } catch {
    return null;
  }
}

export function toNodeImportSpecifier(importPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return pathToFileURL(importPath).href;
  }
  return importPath;
}

export function resolveTsxImportHookSpecifier(platform: NodeJS.Platform = process.platform): string | null {
  const hookPath = resolveTsxImportHookPath();
  if (!hookPath) {
    return null;
  }
  return toNodeImportSpecifier(hookPath, platform);
}

function resolveSubprocessEntrypoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return resolvePackagedRuntimeEntrypoint('index.mjs');
}

function resolveDevTsxFallbackEntrypoint(entrypoint: string): string {
  const distSegment = `${projectPath()}/dist/`;
  const normalized = entrypoint.replaceAll('\\', '/');
  if (normalized.startsWith(distSegment)) {
    return join(projectPath(), 'src', 'index.ts');
  }
  return join(projectPath(), 'src', 'index.ts');
}

function normalizePathSeparators(pathLike: string): string {
  return String(pathLike ?? '').replaceAll('\\', '/');
}

function resolveCurrentProcessSourceEntrypoint(): string | null {
  const scriptPath = String(process.argv[1] ?? '').trim();
  if (!scriptPath || !existsSync(scriptPath)) return null;
  const normalized = normalizePathSeparators(scriptPath);
  if (!normalized.endsWith('/src/index.ts')) return null;
  return scriptPath;
}

function resolveTsconfigPathForSourceEntrypoint(entrypoint: string): string {
  return join(dirname(dirname(entrypoint)), 'tsconfig.json');
}

export function resolveCliTsxTsconfigPath(): string {
  // The TSX loader resolves TS path aliases (`@/...`) using the tsconfig it finds.
  // Daemon-spawned subprocesses intentionally run in arbitrary `cwd`s, so TSX may
  // pick up the wrong tsconfig (or none) unless we provide an explicit path.
  //
  // TSX supports this via `TSX_TSCONFIG_PATH`, but we only want to set it for the
  // spawned subprocess, not mutate the parent process environment.
  return join(projectPath(), 'tsconfig.json');
}

function shouldAllowDevTsxFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = parseOptionalBooleanEnv(env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK);
  if (explicit !== null) return explicit;
  const isDevVariant = env.HAPPIER_VARIANT === 'dev';
  const hasStackContext = hasStackSubprocessContext(env);
  const hasDevSourceEntrypoint = existsSync(join(projectPath(), 'src', 'index.ts'));
  if (!isDevVariant && !hasStackContext && !hasDevSourceEntrypoint) return false;
  return true;
}

function hasStackSubprocessContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HAPPIER_STACK_REPO_DIR ||
      env.HAPPIER_STACK_CLI_ROOT_DIR ||
      env.HAPPIER_STACK_STACK
  );
}

function shouldPreferDevTsxSubprocess(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT === 'string' && env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT.trim().length > 0) {
    return false;
  }
  const explicitPreference = parseOptionalBooleanEnv(env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX);
  if (explicitPreference !== null) return explicitPreference;
  return env.HAPPIER_VARIANT === 'dev' || hasStackSubprocessContext(env);
}

export type HappyCliSubprocessRuntime = 'node' | 'bun' | 'binary';

export type HappyCliSubprocessLaunchOptions = Readonly<{
  preferWindowsPackagedBinary?: boolean;
  allowAdmittedDaemonStartupClosure?: boolean;
  runtimeDecision?: HappyCliSubprocessRuntimeDecision;
  liveRunnerSnapshotFingerprints?: LiveRunnerSnapshotFingerprints | null;
  environment?: NodeJS.ProcessEnv;
}>;

export type HappyCliSubprocessRuntimeDecision = Readonly<{
  runtime: 'node';
  argvPrefix: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type HappyCliSubprocessRuntimeInvocation = {
  runtime: Exclude<HappyCliSubprocessRuntime, 'binary'>;
  argv: string[];
  env?: Record<string, string>;
};

export type HappyCliSubprocessBinaryInvocation = {
  runtime: 'binary';
  filePath: string;
  argv: string[];
  env?: Record<string, string>;
};

export type HappyCliSubprocessInvocation =
  | HappyCliSubprocessRuntimeInvocation
  | HappyCliSubprocessBinaryInvocation;

export type HappyCliSubprocessLaunchSpec = {
  runtime: HappyCliSubprocessRuntime;
  filePath: string;
  args: string[];
  env?: Record<string, string>;
};

function isRuntimeExecutablePath(pathLike: string): boolean {
  const normalized = String(pathLike ?? '').trim().replaceAll('\\', '/');
  const base = normalized.split('/').at(-1)?.toLowerCase() ?? '';
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

function isCurrentProcessSelfContainedBinary(): boolean {
  const execPath = String(process.execPath ?? '').trim();
  if (!execPath) return false;
  return !isRuntimeExecutablePath(execPath);
}

function isCurrentProcessBundledBunExecutable(): boolean {
  const execPath = String(process.execPath ?? '').trim();
  if (!execPath) return false;
  const base = execPath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return base === 'bun' || base === 'bun.exe';
}

function resolveCurrentProcessBundledScriptPath(): string | null {
  const scriptPath = String(process.argv[1] ?? '').trim();
  if (!scriptPath) return null;
  if (isEmbeddedBunBundlePath(scriptPath)) return scriptPath;
  const normalized = scriptPath.replaceAll('\\', '/');
  if (!existsSync(scriptPath)) return null;
  const lowered = normalized.toLowerCase();
  const base = basename(lowered);
  if (base.includes('happier')) return scriptPath;
  if (base === 'index.mjs' && (lowered.includes('/@happier-dev/cli/') || lowered.includes('/happier/'))) {
    return scriptPath;
  }
  return null;
}

function buildCurrentProcessBinaryFallbackInvocation(args: string[]): HappyCliSubprocessInvocation | null {
  if (!isCurrentProcessSelfContainedBinary()) return null;
  return {
    runtime: 'bun',
    argv: [...args],
  };
}

function resolveSiblingWindowsPackagedBinary(entrypoint: string): string | null {
  if (process.platform !== 'win32') return null;
  const distDir = dirname(entrypoint);
  if (basename(distDir).toLowerCase() !== 'package-dist') return null;
  const binaryPath = join(dirname(distDir), 'happier.exe');
  return existsSync(binaryPath) ? binaryPath : null;
}

function shouldPreferWindowsPackagedBinary(options: HappyCliSubprocessLaunchOptions | undefined): boolean {
  if (!options?.preferWindowsPackagedBinary) return false;
  if (process.platform !== 'win32') return false;
  const enabled = parseOptionalBooleanEnv(process.env.HAPPIER_WINDOWS_SESSION_RUNNER_BINARY);
  return enabled !== false;
}

function buildWindowsPackagedBinaryInvocation(
  args: string[],
  entrypoint: string,
  options: HappyCliSubprocessLaunchOptions | undefined,
): HappyCliSubprocessInvocation | null {
  if (!shouldPreferWindowsPackagedBinary(options)) return null;
  const binaryPath = resolveSiblingWindowsPackagedBinary(entrypoint);
  if (!binaryPath) return null;
  return {
    runtime: 'binary',
    filePath: binaryPath,
    argv: [...args],
  };
}

function buildCurrentProcessBundledBunFallbackInvocation(
  args: string[],
): HappyCliSubprocessInvocation | null {
  // Bun virtual bundle paths are process-local on Windows and can fail when reused
  // by detached/background children. Fail closed and require a stable entrypoint.
  if (process.platform === 'win32') return null;
  const bundledScriptPath = resolveCurrentProcessBundledScriptPath();
  if (!bundledScriptPath) return null;
  if (isCurrentProcessSelfContainedBinary()) {
    return {
      runtime: 'bun',
      argv: [...args],
    };
  }
  if (isCurrentProcessBundledBunExecutable()) {
    return {
      runtime: 'bun',
      argv: [bundledScriptPath, ...args],
    };
  }
  return null;
}

function resolveSubprocessRuntimeExecutable(runtime: Exclude<HappyCliSubprocessRuntime, 'binary'>): string {
  // Prefer the currently-running runtime binary when possible. This avoids PATH
  // issues on Windows (and GUI-launched shells) where `node`/`bun` may not resolve.
  if (runtime === 'node') {
    const javaScriptRuntime = resolveJavaScriptRuntimeExecutable({
      isBunRuntime: isBun(),
    });
    if (!javaScriptRuntime) {
      throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Happier CLI subprocess'));
    }
    return javaScriptRuntime;
  }
  if (
    runtime === 'bun' &&
    (isBun() || isCurrentProcessSelfContainedBinary() || isCurrentProcessBundledBunExecutable())
  ) {
    return process.execPath;
  }
  return runtime;
}

function readInheritedNodeLaunchFlags(): string[] {
  const inherited = new Set<string>();
  for (const arg of process.execArgv) {
    if (arg === '--preserve-symlinks' || arg === '--preserve-symlinks-main') {
      inherited.add(arg);
    }
  }
  return [...inherited];
}

function readNonEmptyEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = String(env[name] ?? '').trim();
  return value ? value : null;
}

export function isRuntimeBackedHappyCliSubprocess(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseOptionalBooleanEnv(env[RUNTIME_BACKED_SUBPROCESS_ENV]) === true;
}

export class HappyCliImmutableRuntimeClosureError extends Error {
  readonly code = 'EIMMUTABLERUNNERCLOSURE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HappyCliImmutableRuntimeClosureError';
  }
}

/**
 * Roughly eight distinct conditions refuse an admitted closure and all raise this one error.
 * Append the condition the decision actually observed so an operator does not have to
 * re-derive it.
 */
function describeImmutableClosureRefusal(summary: string, refusal: string | null): string {
  return refusal ? `${summary}\nThe admitted closure was refused because ${refusal}` : summary;
}

function resolveStackRuntimeStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = readNonEmptyEnv(STACK_RUNTIME_STATE_PATH_ENV, env);
  if (explicit) return explicit;

  const stackEnvFile = readNonEmptyEnv('HAPPIER_STACK_ENV_FILE', env);
  if (stackEnvFile) return join(dirname(stackEnvFile), 'stack.runtime.json');

  const homeDir = readNonEmptyEnv('HAPPIER_HOME_DIR', env) ?? readNonEmptyEnv('HAPPIER_STACK_CLI_HOME_DIR', env);
  if (homeDir && basename(homeDir) === 'cli') {
    return join(dirname(homeDir), 'stack.runtime.json');
  }

  const storageDir = readNonEmptyEnv('HAPPIER_STACK_STORAGE_DIR', env);
  const stackName = readNonEmptyEnv('HAPPIER_STACK_STACK', env);
  if (storageDir && stackName) return join(storageDir, stackName, 'stack.runtime.json');

  return null;
}

function readRuntimeStateDistClosureFingerprint(env: NodeJS.ProcessEnv = process.env): string | null {
  const runtimeStatePath = resolveStackRuntimeStatePath(env);
  if (!runtimeStatePath) return null;
  try {
    const runtimeState = JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as {
      daemon?: { distClosureFingerprint?: unknown };
    };
    const fingerprint = String(runtimeState?.daemon?.distClosureFingerprint ?? '').trim();
    return fingerprint ? fingerprint : null;
  } catch {
    return null;
  }
}

function resolveStackDistEntrypoint(defaultEntrypoint: string, env: NodeJS.ProcessEnv = process.env): string {
  return readNonEmptyEnv(STACK_DIST_ENTRYPOINT_ENV, env) ?? defaultEntrypoint;
}

function isRelativePathInsideRoot(relativePath: string): boolean {
  return Boolean(
    relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith('../') &&
      !relativePath.startsWith('..\\') &&
      !relativePath.startsWith('/') &&
      !relativePath.startsWith('\\'),
  );
}

function copyDirectoryContents(sourceDir: string, targetDir: string, options: { skipNames?: ReadonlySet<string> } = {}): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (options.skipNames?.has(entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath, options);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function copyRuntimeAsset(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return;
  if (statSync(sourcePath).isDirectory()) {
    copyDirectoryContents(sourcePath, targetPath);
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function copyCliRuntimeAssetsToPinnedSnapshot(runtimeRoot: string, snapshotRoot: string): void {
  for (const relativePath of CLI_RUNTIME_SIDECAR_ENTRIES) {
    copyRuntimeAsset(
      join(runtimeRoot, 'scripts', ...relativePath),
      join(snapshotRoot, 'scripts', ...relativePath),
    );
  }
  copyRuntimeAsset(
    join(runtimeRoot, 'tools', 'unpacked'),
    join(snapshotRoot, 'tools', 'unpacked'),
  );
}

function resolvePinnedSnapshotLocation(input: Readonly<{
  entrypoint: string;
  fingerprint: string;
  runtimeAssetSha256: string;
  workspaceRuntimeIdentity: string;
  env: NodeJS.ProcessEnv;
}>): PinnedRunnerSnapshotLocation | null {
  if (
    !/^[a-f0-9]{16}$/u.test(input.fingerprint)
    || !/^[a-f0-9]{64}$/u.test(input.runtimeAssetSha256)
    || !/^[a-f0-9]{64}$/u.test(input.workspaceRuntimeIdentity)
  ) {
    return null;
  }
  const entrypoint = input.entrypoint;
  const distRoot = dirname(entrypoint);
  const entrypointRelativePath = relative(distRoot, entrypoint);
  if (!isRelativePathInsideRoot(entrypointRelativePath)) return null;

  const runtimeRoot = dirname(distRoot);
  const snapshotsDir = resolvePinnedRunnerSnapshotsDir(input.entrypoint, input.env);
  if (!snapshotsDir) return null;
  const snapshotIdentity = [
    input.fingerprint,
    input.runtimeAssetSha256,
    input.workspaceRuntimeIdentity,
    PINNED_RUNNER_LAYOUT_VERSION,
  ].join('-');
  const snapshotRoot = join(snapshotsDir, snapshotIdentity);
  return {
    snapshotsDir,
    snapshotIdentity,
    snapshotRoot,
    snapshotEntrypoint: join(snapshotRoot, 'package-dist', entrypointRelativePath),
    fingerprint: input.fingerprint,
    runtimeAssetIdentity: input.runtimeAssetSha256,
    workspaceRuntimeIdentity: input.workspaceRuntimeIdentity,
  };
}

function resolvePinnedRunnerSnapshotsDir(
  entrypoint: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const distRoot = dirname(entrypoint);
  if (!isRuntimeBackedHappyCliSubprocess(env)) {
    return join(dirname(distRoot), PINNED_RUNNER_DIST_DIR);
  }

  const cliHomeDir = readNonEmptyEnv('HAPPIER_HOME_DIR', env);
  if (cliHomeDir) return join(cliHomeDir, PINNED_RUNNER_DIST_DIR);

  const runtimeStatePath = readNonEmptyEnv(STACK_RUNTIME_STATE_PATH_ENV, env);
  if (runtimeStatePath) {
    return join(dirname(runtimeStatePath), 'cli', PINNED_RUNNER_DIST_DIR);
  }

  return null;
}

function readReadyPinnedSnapshotLocations(
  entrypoint: string,
  fingerprint: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<Readonly<{ location: PinnedRunnerSnapshotLocation; mtimeMs: number }>> {
  const snapshotsDir = resolvePinnedRunnerSnapshotsDir(entrypoint, env);
  if (!snapshotsDir) return [];
  return listReadyPinnedRunnerSnapshots(entrypoint, { fingerprint, snapshotsDir });
}

function resolveCurrentPinnedSnapshotLocation(
  entrypoint: string,
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
  workspaceRuntimeIdentityOverride = '',
): PinnedRunnerSnapshotLocation | null {
  const manifest = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
  if (!manifest.ok || manifest.fingerprint !== fingerprint) return null;
  const runtimeRoot = dirname(dirname(entrypoint));
  const runtimeAssetSha256 = resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity({
    entrypoint,
    runtimeRoot,
    manifest: manifest.manifest ?? {},
  });
  if (!runtimeAssetSha256) return null;
  const workspaceRuntimeIdentity = String(
    workspaceRuntimeIdentityOverride
      || manifest.manifest?.workspaceRuntimeIdentity
      || PINNED_RUNNER_NO_WORKSPACE_RUNTIME_SHA256,
  ).trim().toLowerCase();
  return resolvePinnedSnapshotLocation({
    entrypoint,
    fingerprint,
    runtimeAssetSha256,
    workspaceRuntimeIdentity,
    env,
  });
}

function resolveReadyPinnedSnapshotLocation(
  entrypoint: string,
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
): PinnedRunnerSnapshotLocation | null {
  if (!/^[a-f0-9]{16}$/u.test(fingerprint)) return null;
  const currentManifest = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
  if (currentManifest.ok && currentManifest.fingerprint === fingerprint) {
    const current = resolveCurrentPinnedSnapshotLocation(entrypoint, fingerprint, env);
    return current && isPinnedRunnerSnapshotReady(current) ? current : null;
  }

  const candidates = readReadyPinnedSnapshotLocations(entrypoint, fingerprint, env);
  return candidates.length === 1 ? candidates[0]!.location : null;
}

function resolveNewestReadyPinnedSnapshotLocation(
  entrypoint: string,
  env: NodeJS.ProcessEnv = process.env,
): PinnedRunnerSnapshotLocation | null {
  const snapshotsDir = resolvePinnedRunnerSnapshotsDir(entrypoint, env);
  if (!snapshotsDir) return null;
  return resolveNewestReadyPinnedRunnerSnapshot(entrypoint, { snapshotsDir });
}

let warnedOnceAboutUnreliableSnapshotLiveness = false;

function prunePinnedRunnerSnapshots(
  snapshotsDir: string,
  keepFingerprint: string,
  live: LiveRunnerSnapshotFingerprints | null | undefined,
  keepCount = 8,
): void {
  try {
    if (!existsSync(snapshotsDir)) return;
    const entries = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const fullPath = join(snapshotsDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(statSync(fullPath).mtimeMs) || 0;
        } catch {
          mtimeMs = 0;
        }
        return { name: entry.name, fullPath, mtimeMs };
      });
    const decision = decidePinnedRunnerSnapshotPrune({
      entries,
      keepFingerprint,
      live,
      keepCount,
    });
    if (decision.skipped && !warnedOnceAboutUnreliableSnapshotLiveness) {
      warnedOnceAboutUnreliableSnapshotLiveness = true;
      logger.warn(
        '[SPAWN HAPPIER CLI] Skipping pinned runner snapshot pruning because live-runner identity is unavailable or inconclusive.',
      );
    }
    const fullPathByName = new Map(entries.map((entry) => [entry.name, entry.fullPath]));
    for (const name of decision.deletable) {
      const fullPath = fullPathByName.get(name);
      if (fullPath) rmSync(fullPath, { recursive: true, force: true });
    }
  } catch (error) {
    logger.debug(`[SPAWN HAPPIER CLI] Could not prune pinned dist runner snapshots: ${String(error)}`);
  }
}

/**
 * Apply pinned-runner retention once daemon startup has authoritatively reattached live sessions.
 * This also bounds snapshot growth on daemon-only machines that never launch a session.
 */
export function pruneHappyCliRunnerSnapshots(
  live: LiveRunnerSnapshotFingerprints,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const daemonFingerprint = readNonEmptyEnv(DAEMON_DIST_CLOSURE_FINGERPRINT_ENV, environment);
  if (!daemonFingerprint) return;

  const distEntrypoint = resolveStackDistEntrypoint(resolveSubprocessEntrypoint(), environment);
  const location = resolveReadyPinnedSnapshotLocation(
    distEntrypoint,
    daemonFingerprint,
    environment,
  );
  if (!location) return;
  prunePinnedRunnerSnapshots(location.snapshotsDir, location.snapshotIdentity, live);
}

/**
 * Every refusal below reaches the operator as one typed immutable-closure error. Carry the
 * reason out with the decision so a precisely knowable condition — such as an artifact whose
 * plugin manifests declare resource files the payload does not contain — is named rather than
 * having to be re-derived by replicating this function offline.
 */
type PinnedSnapshotPreparation = Readonly<{
  entrypoint: string | null;
  refusal: string | null;
}>;

function copyCliDistToPinnedSnapshot(
  entrypoint: string,
  fingerprint: string,
  live: LiveRunnerSnapshotFingerprints | null | undefined,
  env: NodeJS.ProcessEnv,
): PinnedSnapshotPreparation {
  const distRoot = dirname(entrypoint);
  const sourceRepoRoot = !isRuntimeBackedHappyCliSubprocess(env)
    ? readNonEmptyEnv('HAPPIER_STACK_REPO_DIR', env)
    : '';
  let sourceWorkspaceRuntime = null;
  if (sourceRepoRoot) {
    try {
      sourceWorkspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: sourceRepoRoot });
    } catch {
      // Some source-mode invocations intentionally have no bundled workspace runtime.
      // Preserve their existing dist-only pinning path.
    }
  }
  const location = resolveCurrentPinnedSnapshotLocation(
    entrypoint,
    fingerprint,
    env,
    sourceWorkspaceRuntime?.fingerprint,
  );
  if (!location) {
    return { entrypoint: null, refusal: 'no pinned runner snapshot location could be resolved' };
  }
  const runtimeRoot = dirname(distRoot);
  const {
    snapshotsDir,
    snapshotIdentity,
    snapshotRoot,
    snapshotEntrypoint,
  } = location;
  if (isPinnedRunnerSnapshotReady(location)) {
    prunePinnedRunnerSnapshots(snapshotsDir, snapshotIdentity, live);
    return { entrypoint: snapshotEntrypoint, refusal: null };
  }

  const tmpRoot = join(snapshotsDir, `.${snapshotIdentity}.${process.pid}.${Date.now()}.tmp`);
  let publishedSnapshot = false;
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    copyDirectoryContents(
      distRoot,
      join(tmpRoot, 'package-dist'),
      { skipNames: new Set([PINNED_RUNNER_DIST_DIR]) },
    );
    copyCliRuntimeAssetsToPinnedSnapshot(runtimeRoot, tmpRoot);
    const distManifest = cliDistBuildManifest.readCliDistBuildManifest(entrypoint);
    let expectedWorkspaceRuntimeIdentity = String(
      distManifest.manifest?.workspaceRuntimeIdentity ?? '',
    ).trim().toLowerCase();
    if (isRuntimeBackedHappyCliSubprocess(env)) {
      if (expectedWorkspaceRuntimeIdentity) {
        const workspaceRuntimePackages = distManifest.manifest?.workspaceRuntimePackages;
        if (!Array.isArray(workspaceRuntimePackages)) {
          throw new Error('CLI dist publication is missing its workspace runtime package membership');
        }
        copyCliNodeWorkspaceRuntimePackagesFromRuntimeRoot({
          runtimeRoot,
          payloadDir: tmpRoot,
          packageNames: workspaceRuntimePackages,
          expectedWorkspaceRuntimeIdentity,
        });
      }
    } else {
      if (sourceRepoRoot && sourceWorkspaceRuntime) {
        expectedWorkspaceRuntimeIdentity = sourceWorkspaceRuntime.fingerprint;
        cliDistBuildManifest.writeCliDistWorkspaceRuntimeIdentity({
          entrypoint: join(tmpRoot, 'package-dist', relative(distRoot, entrypoint)),
          workspaceRuntimeIdentity: expectedWorkspaceRuntimeIdentity,
          workspaceRuntimePackages: sourceWorkspaceRuntime.packageNames,
        });
        if (!/^[a-f0-9]{64}$/u.test(expectedWorkspaceRuntimeIdentity)) {
          throw new Error('CLI dist publication is missing its workspace runtime identity');
        }
        copyCliNodeWorkspaceRuntimePackages({
          repoRoot: sourceRepoRoot,
          payloadDir: tmpRoot,
          expectedWorkspaceRuntimeIdentity,
        });
      } else if (sourceRepoRoot && expectedWorkspaceRuntimeIdentity) {
        throw new Error('CLI source workspace runtime is unavailable for pinning');
      }
    }
    writeFileSync(join(tmpRoot, '.fingerprint'), `${fingerprint}\n`, 'utf8');
    writeFileSync(
      join(tmpRoot, '.workspace-runtime-identity'),
      `${location.workspaceRuntimeIdentity}\n`,
      'utf8',
    );
    try {
      renameSync(tmpRoot, snapshotRoot);
      publishedSnapshot = true;
    } catch {
      if (!isPinnedRunnerSnapshotReady(location)) {
        throw new Error(`pinned dist snapshot was not ready: ${snapshotRoot}`);
      }
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    // Read the reason before the unready snapshot is removed: afterwards nothing on disk can
    // still explain why it was refused.
    const refusal = explainPinnedRunnerSnapshotUnreadiness(location);
    if (!refusal) {
      prunePinnedRunnerSnapshots(snapshotsDir, snapshotIdentity, live);
      return { entrypoint: snapshotEntrypoint, refusal: null };
    }
    logger.warn(
      `[SPAWN HAPPIER CLI] Refused the prepared pinned dist runner closure ${snapshotIdentity}: `
      + refusal,
    );
    if (publishedSnapshot) {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
    return { entrypoint: null, refusal };
  } catch (error) {
    rmSync(tmpRoot, { recursive: true, force: true });
    const refusal = `preparing it failed: ${String(error)}`;
    logger.debug(`[SPAWN HAPPIER CLI] Could not prepare pinned dist runner closure: ${String(error)}`);
    return { entrypoint: null, refusal };
  }
}

/**
 * `refusal` explains why no admitted closure could be used, for the typed error the caller
 * raises. It is diagnostic only and never changes which invocation is selected.
 */
type StackDistInvocationOutcome = Readonly<{
  invocation: HappyCliSubprocessInvocation | null;
  refusal: string | null;
}>;

const NO_STACK_DIST_INVOCATION: StackDistInvocationOutcome = { invocation: null, refusal: null };

function runtimeBackedSnapshotProvenance(
  snapshotEntrypoint: string,
  fingerprint: string,
  runtimeBacked: boolean,
): Readonly<Record<string, string>> | undefined {
  if (!runtimeBacked) return undefined;
  return {
    [STACK_DIST_ENTRYPOINT_ENV]: snapshotEntrypoint,
    [DAEMON_DIST_CLOSURE_FINGERPRINT_ENV]: fingerprint,
  };
}

function buildCurrentStackDistSubprocessInvocation(
  args: string[],
  defaultEntrypoint: string,
  live: LiveRunnerSnapshotFingerprints | null | undefined,
  allowAdmittedDaemonStartupClosure: boolean,
  env: NodeJS.ProcessEnv = process.env,
): StackDistInvocationOutcome {
  if (!hasStackSubprocessContext(env)) return NO_STACK_DIST_INVOCATION;
  const runtimeBacked = isRuntimeBackedHappyCliSubprocess(env);
  const daemonFingerprint = readNonEmptyEnv(DAEMON_DIST_CLOSURE_FINGERPRINT_ENV, env);
  if (!daemonFingerprint) return NO_STACK_DIST_INVOCATION;
  const isInitialDaemonStartup = (
    allowAdmittedDaemonStartupClosure
    && args[0] === 'daemon'
    && args[1] === 'start-sync'
  );
  const inheritedExactPublicationLease = readNonEmptyEnv(WORKSPACE_DIST_BUILD_LOCK_HELD_ENV, env);
  if (!runtimeBacked) {
    const runtimeFingerprint = readRuntimeStateDistClosureFingerprint(env);
    if (
      (!runtimeFingerprint || runtimeFingerprint !== daemonFingerprint)
      && !isInitialDaemonStartup
    ) {
      return NO_STACK_DIST_INVOCATION;
    }
  }

  const distEntrypoint = resolveStackDistEntrypoint(defaultEntrypoint, env);
  const admittedSnapshot = resolveReadyPinnedSnapshotLocation(
    distEntrypoint,
    daemonFingerprint,
    env,
  );
  if (
    admittedSnapshot
  ) {
    prunePinnedRunnerSnapshots(
      admittedSnapshot.snapshotsDir,
      admittedSnapshot.snapshotIdentity,
      live,
    );
    const admittedSnapshotProvenance = runtimeBackedSnapshotProvenance(
      admittedSnapshot.snapshotEntrypoint,
      daemonFingerprint,
      runtimeBacked,
    );
    return {
      invocation: {
        runtime: 'node',
        argv: [
          ...readInheritedNodeLaunchFlags(),
          '--no-warnings',
          '--no-deprecation',
          admittedSnapshot.snapshotEntrypoint,
          ...args,
        ],
        ...(admittedSnapshotProvenance ? { env: admittedSnapshotProvenance } : {}),
      },
      refusal: null,
    };
  }

  const distManifest = cliDistBuildManifest.readCliDistBuildManifest(distEntrypoint);
  if (!distManifest.ok || !distManifest.fingerprint || distManifest.fingerprint !== daemonFingerprint) {
    return {
      invocation: null,
      refusal: `the dist build manifest at ${distEntrypoint} does not record admitted `
        + `fingerprint ${daemonFingerprint}`,
    };
  }
  const pinnedSnapshot = copyCliDistToPinnedSnapshot(
    distEntrypoint,
    distManifest.fingerprint,
    live,
    env,
  );
  const pinnedEntrypoint = pinnedSnapshot.entrypoint;
  if (!pinnedEntrypoint) {
    const refusal = pinnedSnapshot.refusal;
    // Stack holds the canonical publication lease while launching an exact admitted closure.
    // Under that lease, selecting another ready snapshot would silently replace the admitted
    // workspace/runtime identity. Let the caller fail with its typed immutable-closure error.
    if (!isInitialDaemonStartup || inheritedExactPublicationLease) {
      return { invocation: null, refusal };
    }
    const lastGreenSnapshot = resolveNewestReadyPinnedSnapshotLocation(distEntrypoint, env);
    if (!lastGreenSnapshot) return { invocation: null, refusal };
    logger.warn(
      '[SPAWN HAPPIER CLI] The admitted daemon closure is unavailable; '
      + `starting from the last ready immutable closure ${lastGreenSnapshot.fingerprint}.`,
    );
    prunePinnedRunnerSnapshots(
      lastGreenSnapshot.snapshotsDir,
      lastGreenSnapshot.snapshotIdentity,
      live,
    );
    return {
      invocation: {
        runtime: 'node',
        argv: [
          ...readInheritedNodeLaunchFlags(),
          '--no-warnings',
          '--no-deprecation',
          lastGreenSnapshot.snapshotEntrypoint,
          ...args,
        ],
        env: runtimeBackedSnapshotProvenance(
          lastGreenSnapshot.snapshotEntrypoint,
          lastGreenSnapshot.fingerprint,
          runtimeBacked,
        ) ?? {
          [DAEMON_DIST_CLOSURE_FINGERPRINT_ENV]: lastGreenSnapshot.fingerprint,
        },
      },
      refusal: null,
    };
  }

  const pinnedSnapshotProvenance = runtimeBackedSnapshotProvenance(
    pinnedEntrypoint,
    daemonFingerprint,
    runtimeBacked,
  );
  return {
    invocation: {
      runtime: 'node',
      argv: [
        ...readInheritedNodeLaunchFlags(),
        '--no-warnings',
        '--no-deprecation',
        pinnedEntrypoint,
        ...args,
      ],
      ...(pinnedSnapshotProvenance ? { env: pinnedSnapshotProvenance } : {}),
    },
    refusal: null,
  };
}

function readInheritedNodeSourceRuntimeFlags(): string[] {
  const normalizeModuleSpecifier = (value: string): string => {
    if (isAbsolute(value)) {
      return toNodeImportSpecifier(value);
    }
    if (/^\.\.?[\\/]/.test(value)) {
      return toNodeImportSpecifier(resolve(value));
    }
    return value;
  };
  const inherited: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (!arg) continue;
    if (arg === '--preserve-symlinks' || arg === '--preserve-symlinks-main') {
      inherited.push(arg);
      continue;
    }
    if (arg === '--import' || arg === '--loader') {
      const value = process.execArgv[index + 1];
      if (typeof value === 'string' && value.length > 0) {
        inherited.push(arg, normalizeModuleSpecifier(value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--import=') || arg.startsWith('--loader=')) {
      const separatorIndex = arg.indexOf('=');
      inherited.push(`${arg.slice(0, separatorIndex + 1)}${normalizeModuleSpecifier(arg.slice(separatorIndex + 1))}`);
    }
  }
  return inherited;
}

function buildCurrentProcessSourceInvocation(args: string[]): HappyCliSubprocessInvocation | null {
  if (typeof process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT === 'string' && process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT.trim().length > 0) {
    return null;
  }

  const sourceEntrypoint = resolveCurrentProcessSourceEntrypoint();
  if (!sourceEntrypoint) return null;

  const inheritedRuntimeFlags = readInheritedNodeSourceRuntimeFlags();
  const sourceTsconfigPath = resolveTsconfigPathForSourceEntrypoint(sourceEntrypoint);
  const runtimeFlags = inheritedRuntimeFlags.length > 0
    ? inheritedRuntimeFlags
    : (() => {
      const tsxHook = resolveTsxImportHookPath();
      if (!tsxHook) {
        return null;
      }
      return ['--import', tsxHook];
    })();
  if (!runtimeFlags) return null;

  return {
    runtime: 'node',
    argv: [
      ...runtimeFlags,
      '--no-warnings',
      '--no-deprecation',
      sourceEntrypoint,
      ...args,
    ],
    env: {
      TSX_TSCONFIG_PATH: sourceTsconfigPath,
    },
  };
}

function buildDevTsxSubprocessInvocation(args: string[], entrypoint: string): HappyCliSubprocessInvocation | null {
  const tsxEntrypoint = resolveDevTsxFallbackEntrypoint(entrypoint);
  if (!existsSync(tsxEntrypoint)) return null;
  const tsxHookSpecifier = resolveTsxImportHookSpecifier();
  if (!tsxHookSpecifier) {
    const errorMessage = `tsx is required for TSX fallback but could not be resolved from the cli package`;
    logger.debug(`[SPAWN HAPPIER CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  return {
    runtime: 'node',
    argv: ['--no-warnings', '--no-deprecation', '--import', tsxHookSpecifier, tsxEntrypoint, ...args],
    env: { TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
  };
}

export function buildHappyCliSubprocessInvocation(
  args: string[],
  options?: HappyCliSubprocessLaunchOptions,
): HappyCliSubprocessInvocation {
  if (options?.runtimeDecision) {
    return {
      runtime: options.runtimeDecision.runtime,
      argv: [...options.runtimeDecision.argvPrefix, ...args],
      ...(options.runtimeDecision.env ? { env: { ...options.runtimeDecision.env } } : {}),
    };
  }

  const environment = options?.environment ?? process.env;
  const runtime = getSubprocessRuntime(environment);
  const runtimeBacked = isRuntimeBackedHappyCliSubprocess(environment);
  if (runtime === 'node' && !runtimeBacked) {
    const currentProcessSourceInvocation = buildCurrentProcessSourceInvocation(args);
    if (currentProcessSourceInvocation) return currentProcessSourceInvocation;
  }

  const entrypoint = resolveSubprocessEntrypoint(environment);

  if (runtimeBacked || (runtime === 'node' && shouldPreferDevTsxSubprocess(environment))) {
    const explicitTsxPreference = parseOptionalBooleanEnv(environment.HAPPIER_CLI_SUBPROCESS_PREFER_TSX);
    let stackDistRefusal: string | null = null;
    if (explicitTsxPreference !== true) {
      const currentStackDist = buildCurrentStackDistSubprocessInvocation(
        args,
        entrypoint,
        options?.liveRunnerSnapshotFingerprints,
        options?.allowAdmittedDaemonStartupClosure === true,
        environment,
      );
      if (currentStackDist.invocation) return currentStackDist.invocation;
      stackDistRefusal = currentStackDist.refusal;
      if (
        options?.allowAdmittedDaemonStartupClosure === true
        && args[0] === 'daemon'
        && args[1] === 'start-sync'
        && readNonEmptyEnv(DAEMON_DIST_CLOSURE_FINGERPRINT_ENV, environment)
      ) {
        throw new HappyCliImmutableRuntimeClosureError(describeImmutableClosureRefusal(
          'Stack daemon startup could not prepare its admitted immutable dist closure.',
          stackDistRefusal,
        ));
      }
    }
    if (runtimeBacked) {
      throw new HappyCliImmutableRuntimeClosureError(describeImmutableClosureRefusal(
        'Runtime-backed Happier CLI runner requires its admitted immutable dist closure; mutable source fallback is disabled.',
        stackDistRefusal,
      ));
    }
    const tsxInvocation = buildDevTsxSubprocessInvocation(args, entrypoint);
    if (tsxInvocation) return tsxInvocation;
  }

  if (runtimeBacked) {
    throw new HappyCliImmutableRuntimeClosureError(
      'Runtime-backed Happier CLI runner could not resolve its admitted immutable dist closure.',
    );
  }

  if (runtime === 'node') {
    const windowsBinaryInvocation = buildWindowsPackagedBinaryInvocation(args, entrypoint, options);
    if (windowsBinaryInvocation) return windowsBinaryInvocation;
  }

  // Use the same Node.js flags that the wrapper script uses
  const inheritedNodeLaunchFlags = runtime === 'node' ? readInheritedNodeLaunchFlags() : [];
  const nodeArgs = [
    ...inheritedNodeLaunchFlags,
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const currentProcessBundledBunFallback = buildCurrentProcessBundledBunFallbackInvocation(args);
    if (currentProcessBundledBunFallback) {
      return currentProcessBundledBunFallback;
    }

    const currentProcessBinaryFallback = buildCurrentProcessBinaryFallbackInvocation(args);
    if (currentProcessBinaryFallback) {
      return currentProcessBinaryFallback;
    }

    const allowTsxFallback = shouldAllowDevTsxFallback(environment);
    if (runtime === 'node' && allowTsxFallback) {
      const tsxInvocation = buildDevTsxSubprocessInvocation(args, entrypoint);
      if (tsxInvocation) return tsxInvocation;
    }
    if (runtime === 'bun') {
      if (isCurrentProcessSelfContainedBinary()) {
        return { runtime: 'bun', argv: [...args] };
      }
      const bundledScriptPath = resolveCurrentProcessBundledScriptPath();
      if (bundledScriptPath) {
        return { runtime: 'bun', argv: [bundledScriptPath, ...args] };
      }
    }
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN HAPPIER CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  const argv = runtime === 'node' ? nodeArgs : [entrypoint, ...args];
  return { runtime, argv };
}

export function resolveHappyCliSubprocessRuntimeDecision(
  options?: Omit<HappyCliSubprocessLaunchOptions, 'runtimeDecision'>,
): HappyCliSubprocessRuntimeDecision | null {
  const environment = options?.environment ?? process.env;
  if (!isRuntimeBackedHappyCliSubprocess(environment)) return null;
  const invocation = buildHappyCliSubprocessInvocation([], options);
  if (invocation.runtime !== 'node') {
    throw new HappyCliImmutableRuntimeClosureError(
      'Runtime-backed Happier CLI runner did not resolve to the admitted Node.js closure.',
    );
  }
  return {
    runtime: 'node',
    argvPrefix: [...invocation.argv],
    ...(invocation.env ? { env: { ...invocation.env } } : {}),
  };
}

export function buildHappyCliSubprocessLaunchSpec(
  args: string[],
  options?: HappyCliSubprocessLaunchOptions,
): HappyCliSubprocessLaunchSpec {
  const invocation = buildHappyCliSubprocessInvocation(args, options);
  if (invocation.runtime === 'binary') {
    return {
      runtime: invocation.runtime,
      filePath: invocation.filePath,
      args: invocation.argv,
      env: invocation.env,
    };
  }
  return {
    runtime: invocation.runtime,
    filePath: resolveSubprocessRuntimeExecutable(invocation.runtime),
    args: invocation.argv,
    env: invocation.env,
  };
}

/**
 * Spawn the Happier CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/happier.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Happier CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHappyCLI(
  args: string[],
  options: SpawnOptions = {},
  launchOptions?: HappyCliSubprocessLaunchOptions,
): ChildProcess {
  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'happier' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'happier' here because other engineers are typically looking
  // for when "happier" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `happier ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPPIER CLI] Spawning: ${fullCommand} in ${directory}`);

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, launchOptions);
  const spawnOptions: SpawnOptions = {
    ...options,
    env: stripCliApiTokenEnvironment({
      ...(options.env ?? process.env),
      ...(launchSpec.env ?? {}),
    }),
  };
  return spawn(launchSpec.filePath, launchSpec.args, spawnOptions);
}
