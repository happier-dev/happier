import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import {
  createWindowsProtectedAclBoundary,
  type WindowsProtectedAclBoundary,
  type WindowsProtectedAclCommandResult,
  type WindowsProtectedAclCommandRunner,
  type WindowsProtectedPathKind,
} from '@happier-dev/cli-common/fs/windowsProtectedAcl';

export type ProtectedLocalStateKind = WindowsProtectedPathKind;
export type WindowsProtectedLocalStateCommandResult = WindowsProtectedAclCommandResult;
export type WindowsProtectedLocalStateCommandRunner = WindowsProtectedAclCommandRunner;
export type WindowsProtectedLocalStateAclBoundary = WindowsProtectedAclBoundary;
export const createWindowsProtectedLocalStateAclBoundary = createWindowsProtectedAclBoundary;

export type ProtectedLocalStateOptions = Readonly<{
  platform?: NodeJS.Platform;
  expectedUid?: number;
  windowsAclBoundary?: WindowsProtectedLocalStateAclBoundary;
}>;

let defaultWindowsAclBoundary: WindowsProtectedLocalStateAclBoundary | null = null;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function resolvePlatform(options: ProtectedLocalStateOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function resolveWindowsAclBoundary(
  options: ProtectedLocalStateOptions,
): WindowsProtectedLocalStateAclBoundary {
  if (options.windowsAclBoundary) return options.windowsAclBoundary;
  defaultWindowsAclBoundary ??= createWindowsProtectedLocalStateAclBoundary();
  return defaultWindowsAclBoundary;
}

function resolveExpectedUid(options: ProtectedLocalStateOptions): number {
  if (options.expectedUid !== undefined) return options.expectedUid;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('POSIX protected local state requires a current process UID');
  }
  return uid;
}

function validateStats(params: Readonly<{
  stats: Awaited<ReturnType<typeof lstat>>;
  kind: ProtectedLocalStateKind;
  platform: NodeJS.Platform;
  expectedUid?: number;
}>): void {
  if (params.stats.isSymbolicLink()) {
    throw new Error('Protected local state must not be a symbolic link');
  }
  if (params.kind === 'directory' ? !params.stats.isDirectory() : !params.stats.isFile()) {
    throw new Error(`Protected local state must be a regular ${params.kind}`);
  }
  if (params.platform !== 'win32') {
    if (Number(params.stats.uid) !== params.expectedUid) {
      throw new Error('Protected local state has an unexpected owner UID');
    }
    const forbiddenBits = params.kind === 'directory' ? 0o077 : 0o077;
    if ((Number(params.stats.mode) & forbiddenBits) !== 0) {
      throw new Error('Protected local state has unsafe group/world permissions');
    }
  }
}

async function fsyncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertProtectedPath(
  path: string,
  kind: ProtectedLocalStateKind,
  options: ProtectedLocalStateOptions,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const platform = resolvePlatform(options);
  const stats = await lstat(path);
  validateStats({
    stats,
    kind,
    platform,
    expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
  });
  if (platform === 'win32') {
    await resolveWindowsAclBoundary(options).verify({ path, kind });
  }
  return stats;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function ensureProtectedLocalStateDirectory(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  const existed = await pathExists(path);
  if (!existed) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (resolvePlatform(options) === 'win32') {
      await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind: 'directory' });
    } else {
      await chmod(path, 0o700);
    }
  }
  await assertProtectedPath(path, 'directory', options);
  if (!existed) {
    await fsyncDirectory(dirname(path), resolvePlatform(options));
  }
}

export async function createProtectedLocalStateDirectory(
  pathPrefix: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const path = await mkdtemp(pathPrefix);
  try {
    if (resolvePlatform(options) === 'win32') {
      await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind: 'directory' });
    } else {
      await chmod(path, 0o700);
    }
    await assertProtectedPath(path, 'directory', options);
    await fsyncDirectory(dirname(path), resolvePlatform(options));
    return path;
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createProtectedLocalStateFileExclusive(
  path: string,
  contents: string | Uint8Array,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await ensureProtectedLocalStateDirectory(dirname(path), options);
  const platform = resolvePlatform(options);
  const flags = platform === 'win32'
    ? 'wx'
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    const stats = await handle.stat();
    validateStats({
      stats,
      kind: 'file',
      platform,
      expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
    });
    if (platform === 'win32') {
      // The file is still empty here. Apply and verify its restrictive DACL
      // before any protected bytes become observable through the path.
      await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind: 'file' });
    }
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  try {
    await assertProtectedPath(path, 'file', options);
    await fsyncDirectory(dirname(path), platform);
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const platform = resolvePlatform(options);
  const before = await assertProtectedPath(path, 'file', options);
  const flags = platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    validateStats({
      stats: opened,
      kind: 'file',
      platform,
      expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
    });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Protected local state changed during no-follow open');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Reads a one-time protected payload and removes its directory entry before
 * returning it. Callers still need an idempotent durable receipt for
 * crash-before-removal recovery; local file deletion is not a transaction.
 */
export async function consumeProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const contents = await readProtectedLocalStateFile(path, options);
  await removeProtectedLocalStateFile(path, options);
  return contents;
}

export async function writeProtectedLocalStateFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await ensureProtectedLocalStateDirectory(dirname(path), options);
  if (await pathExists(path)) {
    await assertProtectedPath(path, 'file', options);
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await createProtectedLocalStateFileExclusive(temporaryPath, contents, options);
    await rename(temporaryPath, path);
    published = true;
    await assertProtectedPath(path, 'file', options);
    await fsyncDirectory(dirname(path), resolvePlatform(options));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (published) {
      await rm(path, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function removeProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await assertProtectedPath(path, 'file', options);
  await rm(path);
  await fsyncDirectory(dirname(path), resolvePlatform(options));
}

export async function listProtectedLocalStateDirectory(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<readonly string[]> {
  await assertProtectedPath(path, 'directory', options);
  return readdir(path);
}
