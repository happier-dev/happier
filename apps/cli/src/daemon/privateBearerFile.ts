import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PRIVATE_BEARER_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    const existing = await lstat(parent);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error('private_bearer_parent_unsafe');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const beforeModeChange = await lstat(parent);
  if (beforeModeChange.isSymbolicLink() || !beforeModeChange.isDirectory()) {
    throw new Error('private_bearer_parent_unsafe');
  }
  try {
    await chmod(parent, 0o700);
  } catch {
    // Windows does not expose POSIX modes. The caller still owns the containing runtime root.
  }
  const afterModeChange = await lstat(parent);
  if (afterModeChange.isSymbolicLink() || !afterModeChange.isDirectory()) {
    throw new Error('private_bearer_parent_unsafe');
  }
}

async function enforcePrivateFileMode(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

export function hashPrivateBearer(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function constantTimeEqualUtf8(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyPrivateBearer(input: Readonly<{
  provided: string;
  expectedHash: string;
}>): boolean {
  if (!PRIVATE_BEARER_HASH_PATTERN.test(input.expectedHash)) return false;
  return constantTimeEqualUtf8(hashPrivateBearer(input.provided), input.expectedHash);
}

export async function writePrivateBearerFile(input: Readonly<{
  path: string;
  contents: string;
}>): Promise<void> {
  await ensurePrivateParent(input.path);
  await writeFile(input.path, input.contents, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await enforcePrivateFileMode(input.path);
}

export async function replacePrivateBearerFile(input: Readonly<{
  path: string;
  contents: string;
}>): Promise<void> {
  await ensurePrivateParent(input.path);
  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateBearerFile({
      path: temporaryPath,
      contents: input.contents,
    });
    await rename(temporaryPath, input.path);
    await enforcePrivateFileMode(input.path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readPrivateBearerFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('private_bearer_file_unsafe');
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !openedStat.isFile()
      || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== 0o600)
      || (currentUid !== null && openedStat.uid !== currentUid)
      || (pathStat.dev !== 0 && openedStat.dev !== 0 && pathStat.dev !== openedStat.dev)
      || (pathStat.ino !== 0 && openedStat.ino !== 0 && pathStat.ino !== openedStat.ino)
    ) {
      throw new Error('private_bearer_file_unsafe');
    }
    const contents = await handle.readFile({ encoding: 'utf8' });
    const finalStat = await lstat(path);
    if (
      finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || (finalStat.dev !== 0 && openedStat.dev !== 0 && finalStat.dev !== openedStat.dev)
      || (finalStat.ino !== 0 && openedStat.ino !== 0 && finalStat.ino !== openedStat.ino)
    ) {
      throw new Error('private_bearer_file_unsafe');
    }
    return contents;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function removePrivateBearerFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function removePrivateBearerFileSync(path: string): void {
  rmSync(path, { force: true });
}
