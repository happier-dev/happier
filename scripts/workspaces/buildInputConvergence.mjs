import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readCachedFileDigest } from '../../apps/stack/scripts/utils/fs/cached_file_digest.mjs';
import { createHash } from 'node:crypto';
import { readDependencyPublicationState, resolveDependencyInstallRoot, waitForDependencyRefresh } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { buildInputDependencyIdentityMatches } from '../../packages/cli-common/sourceRuntimeDependencies.mjs';
import cliDistBuildManifest from '../../packages/cli-common/cliDistBuildManifest.cjs';
import { packageNameOfSpecifier, readWorkspacePackages } from '../../packages/cli-common/sourceRuntimeEntries.mjs';
export { buildInputDependencyIdentityMatches } from '../../packages/cli-common/sourceRuntimeDependencies.mjs';

export async function readBuildInputDependencies({ sourceDir, env = process.env }) {
  return await readDependencyPublicationState({ installDir: resolveDependencyInstallRoot(sourceDir), env });
}

/** Reject a result that consumed an install while its writer was running. */
export async function assertBuildInputDependencies({ sourceDir, env = process.env, state }) {
  const current = await readBuildInputDependencies({ sourceDir, env });
  if (!buildInputDependencyIdentityMatches(state, current) || state.generation !== current.generation) {
    throw new BuildInputDriftError('[build] dependencies changed while producing the artifact; discard it and rerun the phase');
  }
}

/**
 * Captures link external packages to the installed tree. Wait for an active
 * writer at startup, then check dependency publication without holding readers.
 * @template T
 * @param {{ sourceDir: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} input
 * @param {(env: NodeJS.ProcessEnv, publication: { state: Awaited<ReturnType<typeof readDependencyPublicationState>>, assertCurrent: () => Promise<void> }) => Promise<T>} consume
 */
export async function withBuildInputDependencies({ sourceDir, env = process.env, signal }, consume) {
  const installDir = resolveDependencyInstallRoot(sourceDir);
  await waitForDependencyRefresh({ installDir, env, signal });
  const state = await readBuildInputDependencies({ sourceDir, env });
  let checkedAtPublication = false;
  const assertCurrent = async () => {
    await assertBuildInputDependencies({ sourceDir, env, state });
    checkedAtPublication = true;
  };
  const result = await consume(env, { state, assertCurrent });
  if (!checkedAtPublication) await assertCurrent();
  return result;
}

/** Identity of an admitted input view, distinct from any emitted-code digest. */
export async function readBuildInputIdentity({ sourceDir, files, options = [] }) {
  const hash = createHash('sha256').update(JSON.stringify(options));
  for (const path of [...new Set(files)].sort()) {
    const absolute = join(sourceDir, path);
    const info = await lstat(absolute, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    hash.update(JSON.stringify([path, info ? String(info.mode) : null]));
    if (info?.isFile()) hash.update(await readCachedFileDigest(absolute, info));
    else if (info?.isSymbolicLink()) hash.update(await readlink(absolute));
  }
  return hash.digest('hex');
}

/**
 * Capture once, then refresh only members changed during that pass. The
 * trailing reads define the capture; later edits belong to the next demand.
 * There is deliberately no quiet-checkout fence after the trailing pass.
 * @param {{ sourceDir: string, captureDir: string, readPaths: () => Promise<string[]> | string[] }} input
 */
export async function captureBuildInputFiles({ sourceDir, captureDir, readPaths }) {
  const paths = async () => [...new Set(await readPaths())].sort().map(path => {
    const normalized = relative(sourceDir, join(sourceDir, path));
    if (!normalized || isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error(`[build] capture input escapes its source tree: ${path}`);
    }
    return normalized.split(sep).join('/');
  });
  /** @param {string} path */
  const observe = async path => await lstat(path, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  /** @type {Map<string, import('node:fs').BigIntStats>} */
  const copied = new Map();
  /** @param {string} path */
  const copy = async path => {
    const source = join(sourceDir, path);
    const target = join(captureDir, path);
    const info = await observe(source);
    if (!info) {
      await rm(target, { recursive: true, force: true }).catch(error => { if (error.code !== 'ENOTDIR') throw error; });
      copied.delete(path); return;
    }
    await mkdir(dirname(target), { recursive: true });
    if (info.isDirectory()) await mkdir(target, { recursive: true });
    else {
      await rm(target, { force: true });
      // Paths are already admitted and the destination was unlinked. For a
      // regular file, generic cp redundantly stats every ancestor on every
      // copy; large dependency captures amplify that into millions of calls.
      try {
        if (info.isFile()) await copyFile(source, target);
        else await cp(source, target, { verbatimSymlinks: true });
      }
      catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error)
          || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
        copied.delete(path);
        return;
      }
    }
    copied.set(path, info);
  };
  for (const path of await paths()) await copy(path);
  const currentPaths = new Set(await paths());
  const rereadPaths = [];
  for (const path of new Set([...copied.keys(), ...currentPaths])) {
    const before = copied.get(path);
    const after = currentPaths.has(path) ? await observe(join(sourceDir, path)) : null;
    if (!before && !after) continue;
    if (before?.isDirectory() && after?.isDirectory()) {
      if (before.mode !== after.mode) await chmod(join(captureDir, path), Number(after.mode & 0o777n));
      continue;
    }
    if (before && after && before.mode === after.mode) {
      if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs) continue;
      const target = join(captureDir, path);
      const captured = await observe(target);
      if (captured && after.isFile() && captured.isFile()
        && await readCachedFileDigest(join(sourceDir, path), after) === await readCachedFileDigest(target, captured)) continue;
      if (captured && after.isSymbolicLink() && captured.isSymbolicLink()
        && await readlink(join(sourceDir, path)) === await readlink(target)) continue;
    }
    rereadPaths.push(path);
    // Removal of a captured directory also retires its captured children.
    await rm(join(captureDir, path), { recursive: true, force: true }).catch(error => { if (error.code !== 'ENOTDIR') throw error; });
    await copy(path);
  }
  return { files: [...currentPaths].filter(path => copied.has(path)).sort(), rereadPaths,
    capturedAt: new Date().toISOString() };
}

/**
 * Share installed packages through a real modules directory. pnpm 12 rejects
 * linked modules/task-state directories; its mutable journal must stay local.
 * @param {{ sourceModules: string, targetModules: string, excludedNames?: string[] }} input
 */
export async function mountInstalledNodeModules({ sourceModules, targetModules, excludedNames = [] }) {
  await mkdir(targetModules, { recursive: true });
  // A capture may replace a source workspace alias with its captured sources.
  // Keep dependency links bound to the installed tree, not that movable alias.
  const installedModules = await realpath(sourceModules).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (installedModules === null) return;
  const entries = await readdir(installedModules, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.name === '.pnpm-task-run-state-v1' || excludedNames.includes(entry.name)) continue;
    const source = join(installedModules, entry.name);
    const target = join(targetModules, entry.name);
    const info = entry.isSymbolicLink() ? await stat(source) : entry;
    if (info.isDirectory()) await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    // Files such as .modules.yaml need no shared writes or Windows symlink privilege.
    else await copyFile(source, target);
  }
}

/**
 * Reuse installed tools, resolving captured first-party packages inside the
 * capture and tooling-only workspaces through their existing source owners.
 * Publishers must never write through a link into live node_modules.
 * @param {{ sourceDir: string, captureDir: string, workspaceDirs: string[], capturedFiles?: string[] }} input
 */
export async function mountCapturedWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs, capturedFiles = [] }) {
  const workspaces = new Map();
  for (const dir of workspaceDirs) {
    const capturedDir = join(captureDir, dir);
    const metadata = JSON.parse(await readFile(join(capturedDir, 'package.json'), 'utf8'));
    if (typeof metadata.name === 'string' && metadata.name.startsWith('@happier-dev/')) workspaces.set(metadata.name, capturedDir);
  }
  // Copied build tooling has workspace imports beyond the package build graph.
  // Reuse its installed source owners, just like other unrelated workspaces;
  // captured packages always take precedence over those live tooling links.
  if (capturedFiles.length) {
    const packages = await readWorkspacePackages(sourceDir);
    for (const file of capturedFiles) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const path = join(captureDir, file);
      if (!(await lstat(path)).isFile()) continue;
      for (const specifier of cliDistBuildManifest.extractModuleSpecifiers(await readFile(path, 'utf8'))) {
        const name = packageNameOfSpecifier(specifier);
        if (name.startsWith('@happier-dev/') && !workspaces.has(name) && packages.has(name)) {
          workspaces.set(name, packages.get(name).root);
        }
      }
    }
  }
  for (const dir of ['', ...workspaceDirs]) {
    const sourceModules = join(sourceDir, dir, 'node_modules');
    const modules = join(captureDir, dir, 'node_modules');
    await mountInstalledNodeModules({ sourceModules, targetModules: modules, excludedNames: ['@happier-dev'] });
    await mkdir(join(modules, '@happier-dev'), { recursive: true });
    const installedWorkspaces = await readdir(join(sourceModules, '@happier-dev')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of installedWorkspaces) if (!workspaces.has(`@happier-dev/${name}`)) {
      await symlink(join(sourceModules, '@happier-dev', name), join(modules, '@happier-dev', name), process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const [name, capturedDir] of workspaces) await symlink(capturedDir, join(modules, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
}

/** A successful phase consumed inputs that moved before its commit fence. */
export class BuildInputDriftError extends Error {
  /** @param {string} message @param {{ cause?: unknown, trailingPassExhausted?: boolean }} [options] */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'BuildInputDriftError';
    this.code = 'BUILD_INPUTS_CHANGED';
    this.trailingPassExhausted = options.trailingPassExhausted ?? false;
  }
}

/** A failed compiler/projection command is not evidence of input drift. */
export class WorkspacePackageBuildError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkspacePackageBuildError';
    // Preserve the process owner's existing timeout/exit diagnostic contract.
    this.code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : 'WORKSPACE_PACKAGE_BUILD_FAILED';
  }
}

/** @param {unknown} error @returns {error is BuildInputDriftError | WorkspacePackageBuildError} */
export function isTerminalBuildFailure(error) {
  return error instanceof WorkspacePackageBuildError
    || (error instanceof BuildInputDriftError && error.trailingPassExhausted);
}

/** Preserve terminal phase failures through the generator's existing IPC. */
/** @param {unknown} error */
export function serializeTerminalBuildFailure(error) {
  if (!isTerminalBuildFailure(error)) return null;
  return { buildFailure: {
    code: error instanceof BuildInputDriftError ? 'BUILD_INPUTS_CHANGED' : 'WORKSPACE_PACKAGE_BUILD_FAILED',
    message: error.message,
    ...(error instanceof BuildInputDriftError ? { trailingPassExhausted: true } : {}),
  } };
}

/** @param {unknown} value */
export function readTerminalBuildFailure(value) {
  if (!value || typeof value !== 'object' || !('buildFailure' in value)) return null;
  const failure = value.buildFailure;
  if (!failure || typeof failure !== 'object' || !('message' in failure) || typeof failure.message !== 'string'
    || !('code' in failure)) throw new Error('Invalid private build failure result');
  if (failure.code === 'WORKSPACE_PACKAGE_BUILD_FAILED') return new WorkspacePackageBuildError(new Error(failure.message));
  if (failure.code === 'BUILD_INPUTS_CHANGED' && 'trailingPassExhausted' in failure && failure.trailingPassExhausted === true) {
    return new BuildInputDriftError(failure.message, { trailingPassExhausted: true });
  }
  throw new Error('Invalid private build failure result');
}

/**
 * One initial pass and one trailing pass, shared by workspace preparation and
 * generator publication. An exhausted nested phase cannot restart this bound.
 * @template T
 * @param {{ run: (trailing: boolean) => Promise<T>, onTrailingPass?: (error: BuildInputDriftError) => void }} input
 * @returns {Promise<T>}
 */
export async function withSingleTrailingBuildPass(input) {
  for (const trailing of [false, true]) {
    try {
      return await input.run(trailing);
    } catch (error) {
      if (!(error instanceof BuildInputDriftError) || error.trailingPassExhausted) throw error;
      if (trailing) {
        throw new BuildInputDriftError(error.message, { cause: error, trailingPassExhausted: true });
      }
      input.onTrailingPass?.(error);
    }
  }
  throw new Error('Unreachable build convergence state');
}
