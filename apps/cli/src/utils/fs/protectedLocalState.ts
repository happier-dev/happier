import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import {
  createWindowsProtectedAclBoundary,
  createWindowsProtectedAclBoundarySync,
  type WindowsProtectedAclBoundary,
  type WindowsProtectedAclBoundarySync,
  type WindowsProtectedAclCommandResult,
  type WindowsProtectedAclCommandRunner,
  type WindowsProtectedPathKind,
} from '@happier-dev/cli-common/fs/windowsProtectedAcl';

export type ProtectedLocalStateKind = WindowsProtectedPathKind;
export type WindowsProtectedLocalStateCommandResult = WindowsProtectedAclCommandResult;
export type WindowsProtectedLocalStateCommandRunner = WindowsProtectedAclCommandRunner;
export type WindowsProtectedLocalStateAclBoundary = WindowsProtectedAclBoundary;
export type WindowsProtectedLocalStateAclBoundarySync = WindowsProtectedAclBoundarySync;
export const createWindowsProtectedLocalStateAclBoundary = createWindowsProtectedAclBoundary;
export const createWindowsProtectedLocalStateAclBoundarySync = createWindowsProtectedAclBoundarySync;

/**
 * Who owns the protected shape of a path that already exists when a call runs.
 *
 * - `admitted` (default): the path must already carry the protected shape. This
 *   call never repairs it, so a wrong shape surfaces the placement bug that
 *   produced it instead of being silently masked.
 * - `owned`: this call owns the path. A pre-existing path must still pass the
 *   identity checks — not a symbolic link, the expected kind, owned by this user
 *   on POSIX — after which the protected shape is re-applied rather than
 *   refused. Callers that create and maintain their own private state use this so
 *   a directory left looser by an older release, or a file this call is about to
 *   replace wholesale, cannot wedge them.
 */
export type ProtectedLocalStateAuthority = 'admitted' | 'owned';

export type ProtectedLocalStateOptions = Readonly<{
  platform?: NodeJS.Platform;
  expectedUid?: number;
  windowsAclBoundary?: WindowsProtectedLocalStateAclBoundary;
  windowsAclBoundarySync?: WindowsProtectedLocalStateAclBoundarySync;
  authority?: ProtectedLocalStateAuthority;
}>;

let defaultWindowsAclBoundary: WindowsProtectedLocalStateAclBoundary | null = null;
let defaultWindowsAclBoundarySync: WindowsProtectedLocalStateAclBoundarySync | null = null;

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

function resolveWindowsAclBoundarySync(
  options: ProtectedLocalStateOptions,
): WindowsProtectedLocalStateAclBoundarySync {
  if (options.windowsAclBoundarySync) return options.windowsAclBoundarySync;
  defaultWindowsAclBoundarySync ??= createWindowsProtectedLocalStateAclBoundarySync();
  return defaultWindowsAclBoundarySync;
}

function resolveExpectedUid(options: ProtectedLocalStateOptions): number {
  if (options.expectedUid !== undefined) return options.expectedUid;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('POSIX protected local state requires a current process UID');
  }
  return uid;
}

const FORBIDDEN_POSIX_BITS = 0o077;

function resolveAuthority(options: ProtectedLocalStateOptions): ProtectedLocalStateAuthority {
  return options.authority ?? 'admitted';
}

function validateStats(params: Readonly<{
  stats: Stats;
  kind: ProtectedLocalStateKind;
  platform: NodeJS.Platform;
  expectedUid?: number;
  verifyPermissions?: boolean;
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
    if (
      params.verifyPermissions !== false
      && (Number(params.stats.mode) & FORBIDDEN_POSIX_BITS) !== 0
    ) {
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

/**
 * Checks only that a pre-existing path is the thing this process may act on —
 * not a symbolic link, the expected kind, and owned by this user on POSIX —
 * without requiring the protected permissions or DACL to already be in place.
 * Only the `owned` authority uses this, immediately before re-applying or
 * wholesale replacing the protected shape.
 */
async function assertProtectedIdentity(
  path: string,
  kind: ProtectedLocalStateKind,
  options: ProtectedLocalStateOptions,
): Promise<void> {
  const platform = resolvePlatform(options);
  validateStats({
    stats: await lstat(path),
    kind,
    platform,
    expectedUid: platform === 'win32' ? undefined : resolveExpectedUid(options),
    verifyPermissions: false,
  });
}

/**
 * Applies the restrictive shape this module guarantees: mode `0700`/`0600` on
 * POSIX, and an owner-plus-LOCAL SYSTEM protected DACL on Windows. Windows is
 * the platform that cannot express the POSIX mode, so it is the platform that
 * must run its own boundary rather than silently skipping the step.
 */
async function applyProtection(
  path: string,
  kind: ProtectedLocalStateKind,
  options: ProtectedLocalStateOptions,
): Promise<void> {
  if (resolvePlatform(options) === 'win32') {
    await resolveWindowsAclBoundary(options).applyAndVerify({ path, kind });
    return;
  }
  await chmod(path, kind === 'directory' ? 0o700 : 0o600);
}

/**
 * Verifies a pre-existing local-state path without changing its authority or
 * contents. Callers use this before admitting a path as a secret-bearing root.
 */
export async function verifyProtectedLocalStatePath(
  path: string,
  kind: ProtectedLocalStateKind,
  options: ProtectedLocalStateOptions = {},
): Promise<void> {
  await assertProtectedPath(path, kind, options);
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
    await applyProtection(path, 'directory', options);
  } else if (resolveAuthority(options) === 'owned') {
    await assertProtectedIdentity(path, 'directory', options);
    await applyProtection(path, 'directory', options);
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

/**
 * Disclosure reads validate the containing directory as well as the file.
 *
 * A protected file inside a group- or world-writable directory may already have
 * been replaced, so the directory's shape is part of what makes the bytes
 * trustworthy. On POSIX that is the parent's owner UID and the absence of any
 * group/world bit. Windows has no mode to read: the parent's protected DACL is
 * applied and verified where the directory is created
 * (`ensureProtectedLocalStateDirectory`), and the read verifies the file's own
 * DACL. Refusing a symbolic link at either the file or its immediate parent,
 * together with the `O_NOFOLLOW` open below, is what keeps a link from
 * redirecting the read.
 */
function assertProtectedFileReadIdentity(params: Readonly<{
  parentStats: Stats;
  fileStats: Stats;
  platform: NodeJS.Platform;
  expectedUid?: number;
}>): void {
  validateStats({
    stats: params.parentStats,
    kind: 'directory',
    platform: params.platform,
    expectedUid: params.expectedUid,
  });
  validateStats({
    stats: params.fileStats,
    kind: 'file',
    platform: params.platform,
    expectedUid: params.expectedUid,
  });
}

/**
 * A device or inode reported as `0` carries no identity, which some Windows
 * filesystems do. Comparing it as a value would reject an unchanged file, so an
 * absent identity component is skipped rather than treated as a mismatch.
 */
function assertUnchangedOpenIdentity(before: Stats, opened: Stats): void {
  const sameDevice = before.dev === 0 || opened.dev === 0 || before.dev === opened.dev;
  const sameInode = before.ino === 0 || opened.ino === 0 || before.ino === opened.ino;
  if (!sameDevice || !sameInode) {
    throw new Error('Protected local state changed during no-follow open');
  }
}

export async function readProtectedLocalStateFile(
  path: string,
  options: ProtectedLocalStateOptions = {},
): Promise<string> {
  const platform = resolvePlatform(options);
  const expectedUid = platform === 'win32' ? undefined : resolveExpectedUid(options);
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  const [parentStats, fileStats] = await Promise.all([
    lstat(parentPath),
    lstat(resolvedPath),
  ]);
  assertProtectedFileReadIdentity({ parentStats, fileStats, platform, expectedUid });
  if (platform === 'win32') {
    await resolveWindowsAclBoundary(options).verify({ path: resolvedPath, kind: 'file' });
  }
  const flags = platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(resolvedPath, flags);
  try {
    const opened = await handle.stat();
    validateStats({ stats: opened, kind: 'file', platform, expectedUid });
    assertUnchangedOpenIdentity(fileStats, opened);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The synchronous mirror of {@link readProtectedLocalStateFile}, for the
 * synchronous directory scans that cannot await. It carries the same
 * guarantees, through the synchronous Windows ACL boundary.
 */
export function readProtectedLocalStateFileSync(
  path: string,
  options: ProtectedLocalStateOptions = {},
): string {
  const platform = resolvePlatform(options);
  const expectedUid = platform === 'win32' ? undefined : resolveExpectedUid(options);
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  const before = lstatSync(resolvedPath);
  assertProtectedFileReadIdentity({
    parentStats: lstatSync(parentPath),
    fileStats: before,
    platform,
    expectedUid,
  });
  if (platform === 'win32') {
    resolveWindowsAclBoundarySync(options).verify({ path: resolvedPath, kind: 'file' });
  }
  const flags = platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const descriptor = openSync(resolvedPath, flags);
  try {
    const opened = fstatSync(descriptor);
    validateStats({ stats: opened, kind: 'file', platform, expectedUid });
    assertUnchangedOpenIdentity(before, opened);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
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
    // `owned` replaces the file wholesale, so it only has to be the thing this
    // process may act on. Requiring the protected shape here would wedge an
    // owner on a file an older release left looser — the case the authority
    // exists to survive.
    if (resolveAuthority(options) === 'owned') {
      await assertProtectedIdentity(path, 'file', options);
    } else {
      await assertProtectedPath(path, 'file', options);
    }
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

/**
 * Publishes a protected file only when the path is still free, reporting
 * whether this call is the one that created it. The bytes are written into a
 * temporary protected file first and the visible path is a hard link to it, so
 * a concurrent reader never observes a partially written secret — unlike an
 * exclusive create, which is visible from its first empty byte.
 */
export async function publishProtectedLocalStateFileIfAbsent(
  path: string,
  contents: string | Uint8Array,
  options: ProtectedLocalStateOptions = {},
): Promise<boolean> {
  await ensureProtectedLocalStateDirectory(dirname(path), options);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await createProtectedLocalStateFileExclusive(temporaryPath, contents, options);
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw error;
    }
    await assertProtectedPath(path, 'file', options);
    await fsyncDirectory(dirname(path), resolvePlatform(options));
    return true;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
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
