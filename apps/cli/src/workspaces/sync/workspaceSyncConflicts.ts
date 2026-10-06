import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readlink, readdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { withConfinedWorkspaceSyncParent } from './workspaceSyncConfinedFileSystem';
import { observeWorkspaceSyncEntryAtRoot } from './workspaceSyncFileRead';
import {
  runNativeConfinedWorkspaceSyncApply,
  runNativeConfinedWorkspaceSyncCapture,
  runNativeConfinedWorkspaceSyncRecover,
  type NativeConfinedApplyOutcome,
  type NativeConfinedCapturedEntry,
  type NativeConfinedRecoverOutcome,
  type RunNativeConfinedApplyInput,
  type RunNativeConfinedCaptureInput,
  type RunNativeConfinedRecoverInput,
} from './workspaceSyncNativeConfinedFileSystem';

export type CaptureWorkspaceSyncEntryAtRootInput = RunNativeConfinedCaptureInput;
export type ApplyCapturedWorkspaceSyncEntryAtRootInput = RunNativeConfinedApplyInput;
export type RecoverWorkspaceSyncEntryReplacementAtRootInput = RunNativeConfinedRecoverInput;

export type WorkspaceSyncConflictEntryEffectDependencies = Readonly<{
  runNativeConfinedCapture?: typeof runNativeConfinedWorkspaceSyncCapture;
  runNativeConfinedApply?: typeof runNativeConfinedWorkspaceSyncApply;
  runNativeConfinedRecover?: typeof runNativeConfinedWorkspaceSyncRecover;
}>;

function projectNativeConflictError(error: unknown): never {
  if ((error as { code?: unknown }).code === 'workspace_root_unsafe') {
    throw conflictError('conflict_resolution_unsupported', (error as Error).message);
  }
  throw error;
}

/** Descend only through held Linux directory descriptors, never a recursive pathname copy. */
async function copyConfinedLinuxEntry(sourcePath: string, destinationPath: string): Promise<void> {
  const before = await lstat(sourcePath);
  if (before.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    const after = await lstat(sourcePath);
    if (!after.isSymbolicLink() || !hasSameObjectIdentity(before, after)) {
      throw conflictError('conflict_changed', 'Reviewed workspace source symlink changed during capture');
    }
    await symlink(target, destinationPath);
    return;
  }
  if (before.isFile()) {
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const admitted = await source.stat();
      if (!admitted.isFile() || !hasSameObjectIdentity(before, admitted)) {
        throw conflictError('conflict_changed', 'Reviewed workspace source file changed during capture');
      }
      const destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, offset);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await destination.write(buffer, written, bytesRead - written, offset + written);
            if (result.bytesWritten === 0) throw new Error('Reviewed workspace capture could not write staged material');
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        const after = await source.stat();
        if (!hasSameObjectIdentity(admitted, after) || admitted.size !== after.size
          || admitted.mtimeMs !== after.mtimeMs || admitted.mode !== after.mode || offset !== after.size) {
          throw conflictError('conflict_changed', 'Reviewed workspace source file changed during capture');
        }
        await destination.chmod(admitted.mode & 0o777);
      } finally {
        await destination.close();
      }
    } finally {
      await source.close();
    }
    return;
  }
  if (!before.isDirectory()) {
    throw conflictError('conflict_resolution_unsupported', 'Reviewed workspace source entry type is unsupported');
  }
  const directory = await open(sourcePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const admitted = await directory.stat();
    if (!admitted.isDirectory() || !hasSameObjectIdentity(before, admitted)) {
      throw conflictError('conflict_changed', 'Reviewed workspace source directory changed during capture');
    }
    await mkdir(destinationPath, { mode: 0o700 });
    const heldPath = `/proc/self/fd/${directory.fd}`;
    const names = (await readdir(heldPath)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      await copyConfinedLinuxEntry(resolve(heldPath, name), resolve(destinationPath, name));
    }
    const after = await directory.stat();
    if (!hasSameObjectIdentity(admitted, after) || admitted.mtimeMs !== after.mtimeMs) {
      throw conflictError('conflict_changed', 'Reviewed workspace source directory changed during capture');
    }
    await chmod(destinationPath, admitted.mode & 0o777);
  } finally {
    await directory.close();
  }
}

/** Capture exact reviewed bytes into private file-backed operation material. */
export async function captureWorkspaceSyncEntryAtRoot(
  input: CaptureWorkspaceSyncEntryAtRootInput,
  dependencies: WorkspaceSyncConflictEntryEffectDependencies = {},
): Promise<NativeConfinedCapturedEntry> {
  if (process.platform === 'linux') {
    const expected = WorkspaceSyncEntryExpectationV1Schema.parse(input.expected);
    const before = await observeWorkspaceSyncEntryAtRoot({
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    });
    if (JSON.stringify(before) !== JSON.stringify(expected)) {
      throw conflictError('conflict_changed', 'Reviewed workspace source changed before capture');
    }
    if (expected.kind === 'missing') return { expectation: expected, materialPath: null };
    await mkdir(input.captureDirectory, { recursive: true });
    const captureName = `.happier-resolution-capture-${randomUUID()}`;
    const materialPath = resolve(input.captureDirectory, captureName);
    try {
      await withConfinedWorkspaceSyncParent({
        rootPath: input.rootPath,
        relativePath: input.relativePath,
        ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
        run: async ({ parentHandlePath, finalName }) => {
          await copyConfinedLinuxEntry(resolve(parentHandlePath, finalName), materialPath);
        },
      });
      const [after, captured] = await Promise.all([
        observeWorkspaceSyncEntryAtRoot({
          rootPath: input.rootPath,
          relativePath: input.relativePath,
          ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
        }),
        observeWorkspaceSyncEntryAtRoot({ rootPath: input.captureDirectory, relativePath: captureName }),
      ]);
      if (JSON.stringify(after) !== JSON.stringify(expected) || JSON.stringify(captured) !== JSON.stringify(expected)) {
        throw conflictError('conflict_changed', 'Reviewed workspace source changed during capture');
      }
      return { expectation: expected, materialPath };
    } catch (error) {
      await rm(materialPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  try {
    return await (dependencies.runNativeConfinedCapture ?? runNativeConfinedWorkspaceSyncCapture)(input);
  } catch (error) {
    return projectNativeConflictError(error);
  }
}

/** Conditionally install staged reviewed material without overwriting a new public entry. */
export async function applyCapturedWorkspaceSyncEntryAtRoot(
  input: ApplyCapturedWorkspaceSyncEntryAtRootInput,
  dependencies: WorkspaceSyncConflictEntryEffectDependencies = {},
): Promise<NativeConfinedApplyOutcome> {
  try {
    return await (dependencies.runNativeConfinedApply ?? runNativeConfinedWorkspaceSyncApply)(input);
  } catch (error) {
    return projectNativeConflictError(error);
  }
}

/** Settle an interrupted replacement before any touching sync session may resume. */
export async function recoverWorkspaceSyncEntryReplacementAtRoot(
  input: RecoverWorkspaceSyncEntryReplacementAtRootInput,
  dependencies: WorkspaceSyncConflictEntryEffectDependencies = {},
): Promise<NativeConfinedRecoverOutcome> {
  try {
    return await (dependencies.runNativeConfinedRecover ?? runNativeConfinedWorkspaceSyncRecover)(input);
  } catch (error) {
    return projectNativeConflictError(error);
  }
}

function conflictError(code: 'conflict_changed' | 'conflict_resolution_unsupported', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasSameObjectIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
