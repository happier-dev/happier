import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readCachedFileDigest } from '../../apps/stack/scripts/utils/fs/cached_file_digest.mjs';

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
      try { await cp(source, target, { verbatimSymlinks: true }); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
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
  return { files: [...currentPaths].filter(path => copied.has(path)).sort(), rereadPaths };
}

/**
 * Reuse installed external tools, but resolve first-party packages inside the
 * capture. Publishers must never write through a link into live node_modules.
 * @param {{ sourceDir: string, captureDir: string, workspaceDirs: string[] }} input
 */
export async function mountCapturedWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs }) {
  const workspaces = new Map();
  for (const dir of workspaceDirs) {
    const capturedDir = join(captureDir, dir);
    const metadata = JSON.parse(await readFile(join(capturedDir, 'package.json'), 'utf8'));
    if (typeof metadata.name === 'string' && metadata.name.startsWith('@happier-dev/')) workspaces.set(metadata.name, capturedDir);
  }
  for (const dir of ['', ...workspaceDirs]) {
    const sourceModules = join(sourceDir, dir, 'node_modules');
    const modules = join(captureDir, dir, 'node_modules');
    await mkdir(modules, { recursive: true });
    const names = await readdir(sourceModules).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names) {
      if (name === '@happier-dev') continue;
      const source = join(sourceModules, name);
      const target = join(modules, name);
      if (process.platform === 'win32' && !(await lstat(source)).isDirectory()) await cp(source, target, { verbatimSymlinks: true });
      else await symlink(source, target, process.platform === 'win32' ? 'junction' : undefined);
    }
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
