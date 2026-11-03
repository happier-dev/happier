import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FilesystemWriteGuardErrorCode } from '@happier-dev/protocol/actions';

import { moveFileWithCrossDeviceFallback, type MoveFileOperations } from '@/utils/fs/moveFileWithCrossDeviceFallback';
import { renameWithWindowsRetries, writeFileAtomically } from '@/utils/fs/writeJsonAtomic';

type GuardedFileReplaceFailure = Readonly<{ success: false; error: string; errorCode: FilesystemWriteGuardErrorCode | 'file_replace_failed' | 'filesystem_identity_custody_unavailable' }>;
export type GuardedFileReplaceResult =
  | Readonly<{ success: true; hash: string }>
  | GuardedFileReplaceFailure;
export type GuardedFileAbsenceResult = Readonly<{ success: true; hash: null }> | GuardedFileReplaceFailure;
type GuardedFileReplaceSource = Readonly<{ kind: 'bytes'; bytes: Uint8Array }> | Readonly<{ kind: 'staged'; path: string; sha256: string }>
  | Readonly<{ kind: 'move'; path: string; expectedHash: string }>;
type GuardedFileReplaceOptions = Readonly<{
  destPath: string;
  expectation?: string | null;
  /** Transfer authorization and OS-boundary adapters apply to staging, never replacement of the destination. */
  fileOperations?: MoveFileOperations;
  prepareCommit?: () => Promise<void>;
}>;

class FileWriteGuardError extends Error {
  constructor(readonly code: FilesystemWriteGuardErrorCode, message: string) { super(message); }
}

/** Bounded-memory streaming read, synchronous so the final check and rename have no await between them. */
function hashFile(path: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let length: number;
    while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

export function checkFileWriteExpectation(path: string, expectation: string | null | undefined): void {
  if (expectation === undefined) return;
  try {
    if (expectation === null) {
      statSync(path);
      throw new FileWriteGuardError('expected_file_absent', 'File already exists but was expected to be new');
    }
    if (hashFile(path) !== expectation) throw new FileWriteGuardError('hash_mismatch', 'File content changed since it was read');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    if (expectation !== null) throw new FileWriteGuardError('expected_file_missing', 'File does not exist but hash was provided');
  }
}

/** The expectation owner for inline saves, uploaded saves, review reverts and text replacements. */
export function commitGuardedFileReplace(input: GuardedFileReplaceOptions & Readonly<{ source: GuardedFileReplaceSource }>): Promise<GuardedFileReplaceResult>;
export function commitGuardedFileReplace(input: GuardedFileReplaceOptions & Readonly<{ source: Readonly<{ kind: 'absent' }> }>): Promise<GuardedFileAbsenceResult>;
export async function commitGuardedFileReplace(input: GuardedFileReplaceOptions & Readonly<{
  source: GuardedFileReplaceSource | Readonly<{ kind: 'absent' }>;
}>): Promise<GuardedFileReplaceResult | GuardedFileAbsenceResult> {
  try {
    if (input.source.kind === 'move') {
      await mkdir(dirname(input.destPath), { recursive: true });
      // Source currentness and destination absence are checked together at
      // publication. Semantic rename never replaces an existing destination.
      const source = input.source;
      await renameWithWindowsRetries(source.path, input.destPath, () => {
        checkFileWriteExpectation(source.path, source.expectedHash);
        checkFileWriteExpectation(input.destPath, null);
      }, input.prepareCommit);
      return { success: true, hash: source.expectedHash };
    }
    if (input.source.kind === 'absent') {
      // Added-file Discard removes the directory entry (a symlink's target stays intact).
      // There is no staged content to publish: unlink is the atomic filesystem operation.
      if (input.prepareCommit) await input.prepareCommit();
      checkFileWriteExpectation(input.destPath, input.expectation);
      unlinkSync(input.destPath);
      return { success: true, hash: null };
    }
    const destPath = await realpath(input.destPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return input.destPath;
      throw error;
    });
    checkFileWriteExpectation(destPath, input.expectation);
    // Atomic rename must preserve the existing writer's OS permission refusal;
    // writable parent directories alone do not admit overwriting read-only files.
    await access(destPath, constants.W_OK).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    const source = input.source;
    const hash = source.kind === 'bytes' ? createHash('sha256').update(source.bytes).digest('hex') : source.sha256;
    await writeFileAtomically({ path: destPath, mode: 'preserve', fsync: true,
      writeTemporaryFile: async temporary => {
        if (source.kind === 'bytes') await writeFile(temporary, source.bytes, { mode: 0o600 });
        else {
          // Transfers can start in a private directory; retain that privacy before entering the workspace.
          await chmod(source.path, 0o600);
          await moveFileWithCrossDeviceFallback(source.path, temporary, input.fileOperations);
        }
      },
      beforeCommit: () => checkFileWriteExpectation(destPath, input.expectation),
      prepareCommit: input.prepareCommit,
    });
    return { success: true, hash };
  } catch (error) {
    return { success: false, errorCode: error instanceof FileWriteGuardError ? error.code
      : error instanceof Error && 'code' in error && error.code === 'filesystem_identity_custody_unavailable'
        ? error.code : 'file_replace_failed',
      error: error instanceof Error ? error.message : 'Failed to replace file' };
  }
}
