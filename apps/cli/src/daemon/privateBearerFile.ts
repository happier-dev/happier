import { createHash, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
  publishProtectedLocalStateFileIfAbsent,
  readProtectedLocalStateFile,
  readProtectedLocalStateFileSync,
  writeProtectedLocalStateFileAtomic,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';

/**
 * Bearer credentials the daemon mints and consumes on this machine.
 *
 * Every on-disk guarantee here — owner-only permissions, symbolic-link refusal,
 * no-follow reads, the Windows protected DACL — belongs to
 * `utils/fs/protectedLocalState`, the single owner of what "protected" means on
 * each platform. This module owns only what is specific to a bearer credential:
 * its hash/compare primitives and the typed `private_*_unsafe` codes callers and
 * their tests already discriminate on. It makes no protection decision of its
 * own, so Windows and POSIX cannot drift apart between a bearer file and any
 * other protected local state.
 */

const PRIVATE_BEARER_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/**
 * The daemon creates and maintains its own bearer state, so a path left looser
 * by an older release is repaired rather than treated as someone else's.
 */
const BEARER_STATE: ProtectedLocalStateOptions = Object.freeze({ authority: 'owned' });

/**
 * Filesystem failures (`ENOENT`, `EACCES`, `EEXIST`, …) stay verbatim so callers
 * can branch on them; a refusal from the protection owner becomes this domain's
 * typed code.
 */
function asTypedUnsafeFailure(error: unknown, unsafeCode: string): unknown {
  if (
    typeof error === 'object'
    && error !== null
    && typeof (error as NodeJS.ErrnoException).code === 'string'
  ) {
    return error;
  }
  return new Error(unsafeCode);
}

async function ensureProtectedBearerDirectory(path: string, unsafeCode: string): Promise<void> {
  try {
    await ensureProtectedLocalStateDirectory(path, BEARER_STATE);
  } catch (error) {
    throw asTypedUnsafeFailure(error, unsafeCode);
  }
}

export async function ensurePrivateOwnerDirectory(path: string): Promise<void> {
  await ensureProtectedBearerDirectory(path, 'private_owner_directory_unsafe');
}

export async function readPrivateOwnerFile(path: string): Promise<string> {
  try {
    return await readProtectedLocalStateFile(path, BEARER_STATE);
  } catch (error) {
    throw asTypedUnsafeFailure(error, 'private_owner_file_unsafe');
  }
}

export function readPrivateOwnerFileSync(path: string): string {
  try {
    return readProtectedLocalStateFileSync(path, BEARER_STATE);
  } catch (error) {
    throw asTypedUnsafeFailure(error, 'private_owner_file_unsafe');
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

export async function writePrivateOwnerFile(input: Readonly<{
  path: string;
  contents: string | Uint8Array;
}>): Promise<void> {
  await ensureProtectedBearerDirectory(dirname(input.path), 'private_bearer_parent_unsafe');
  await createProtectedLocalStateFileExclusive(input.path, input.contents, BEARER_STATE);
}

export async function writePrivateBearerFile(input: Readonly<{
  path: string;
  contents: string;
}>): Promise<void> {
  await writePrivateOwnerFile(input);
}

export async function publishPrivateBearerFileIfAbsent(input: Readonly<{
  path: string;
  contents: string;
}>): Promise<boolean> {
  await ensureProtectedBearerDirectory(dirname(input.path), 'private_bearer_parent_unsafe');
  return await publishProtectedLocalStateFileIfAbsent(
    input.path,
    input.contents,
    BEARER_STATE,
  );
}

export async function replacePrivateBearerFile(input: Readonly<{
  path: string;
  contents: string;
}>): Promise<void> {
  await ensureProtectedBearerDirectory(dirname(input.path), 'private_bearer_parent_unsafe');
  await writeProtectedLocalStateFileAtomic(input.path, input.contents, BEARER_STATE);
}

/**
 * A bearer file that is simply not there is an ordinary `ENOENT` the caller
 * handles; anything else — including a dangling symbolic link, whose target
 * resolution fails with `ENOENT` too — is a refusal, never an absence.
 */
export async function readPrivateBearerFile(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('private_bearer_file_unsafe');
  }
  try {
    return await readPrivateOwnerFile(path);
  } catch {
    throw new Error('private_bearer_file_unsafe');
  }
}

export async function removePrivateBearerFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function removePrivateBearerFileSync(path: string): void {
  rmSync(path, { force: true });
}
