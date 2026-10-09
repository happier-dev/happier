import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES, WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ReadWorkspaceSyncFileResultV1, WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { withConfinedWorkspaceSyncParent } from './workspaceSyncConfinedFileSystem';
import {
  workspaceSyncRootObjectIdentityFromStat,
  workspaceSyncRootObjectIdentitiesEqual,
  type WorkspaceSyncRootObjectIdentityV1,
} from './workspaceSyncRootIdentity';
import {
  runNativeConfinedWorkspaceSyncRead,
  runNativeConfinedWorkspaceSyncObserve,
  runNativeConfinedWorkspaceSyncMeasure,
  type RunNativeConfinedReadInput,
} from './workspaceSyncNativeConfinedFileSystem';

export type ReadWorkspaceSyncFileAtRootInput = Readonly<{
  rootPath: string;
  relativePath: string;
  expectedDigest?: string;
  maxBytes: number;
  assertCurrentAuthority?: () => Promise<void>;
}>;

export type ReadWorkspaceSyncFileAtRootDependencies = Readonly<{
  runNativeConfinedRead?: (input: RunNativeConfinedReadInput) => Promise<Awaited<ReturnType<typeof runNativeConfinedWorkspaceSyncRead>>>;
}>;

export type ObserveWorkspaceSyncEntryAtRootDependencies = Readonly<{
  runNativeConfinedObserve?: typeof runNativeConfinedWorkspaceSyncObserve;
}>;

function unsafePath(message: string): Error {
  return Object.assign(new Error(message), { code: 'workspace_root_unsafe' });
}

function isMissing(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES) {
    throw Object.assign(new Error('workspace file preview byte limit is invalid'), {
      code: 'invalid_request',
    });
  }
  return value;
}

type ObserveWorkspaceSyncEntryAtRootInput = Readonly<{
  rootPath: string;
  relativePath: string;
  assertCurrentAuthority?: () => Promise<void>;
}>;

function changed(message: string): Error {
  return Object.assign(new Error(message), { code: 'conflict_changed' });
}

async function hashOpenFile(handle: Awaited<ReturnType<typeof open>>): Promise<Readonly<{
  digest: string;
  executable: boolean;
  size: number;
}>> {
  const before = await handle.stat();
  if (!before.isFile()) throw changed('workspace entry changed before file observation');
  const hash = createHash(MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.mode !== after.mode
    || offset !== after.size
  ) throw changed('workspace entry changed during file observation');
  return {
    digest: hash.digest('hex'),
    executable: (after.mode & 0o111) !== 0,
    size: offset,
  };
}

async function observeAtDescriptorPath(
  path: string,
  measureSize = false,
  expectedRootIdentity?: WorkspaceSyncRootObjectIdentityV1,
): Promise<WorkspaceSyncEntryExpectationV1 | number> {
  const admitted = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!admitted) {
    if (measureSize) throw changed('workspace entry disappeared during measurement');
    return { kind: 'missing' };
  }
  if (expectedRootIdentity && !admitted.isDirectory()) {
    throw Object.assign(new Error('Workspace copy root identity changed before measurement'), { code: 'root_changed' });
  }
  if (admitted.isSymbolicLink()) {
    if (measureSize) return 0;
    const rawTarget = await readlink(path, { encoding: 'buffer' });
    const target = rawTarget.toString('utf8');
    if (!Buffer.from(target, 'utf8').equals(rawTarget)) {
      throw Object.assign(new Error('workspace symlink target cannot be represented'), { code: 'workspace_file_unsupported' });
    }
    const current = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) throw changed('workspace symlink changed during observation');
      throw error;
    });
    if (admitted.dev !== current.dev || admitted.ino !== current.ino || admitted.mtimeMs !== current.mtimeMs) {
      throw changed('workspace symlink changed during observation');
    }
    return { kind: 'symlink', target };
  }
  if (admitted.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw changed('workspace file changed before observation');
      }
      throw error;
    });
    try {
      if (measureSize) {
        const current = await handle.stat();
        if (!current.isFile() || admitted.dev !== current.dev || admitted.ino !== current.ino
          || admitted.size !== current.size || admitted.mtimeMs !== current.mtimeMs) {
          throw changed('workspace file changed during measurement');
        }
        if (!Number.isSafeInteger(current.size) || current.size < 0) {
          throw Object.assign(new Error('workspace file size cannot be represented'), { code: 'workspace_file_unsupported' });
        }
        return current.size;
      }
      const observed = await hashOpenFile(handle);
      return { kind: 'file', ...observed };
    } finally {
      await handle.close();
    }
  }
  if (!admitted.isDirectory()) {
    throw Object.assign(new Error('workspace entry kind cannot be resolved safely'), { code: 'workspace_file_unsupported' });
  }
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw changed('workspace directory changed before observation');
    }
    throw error;
  });
  try {
    const before = await directory.stat();
    if (expectedRootIdentity && !workspaceSyncRootObjectIdentitiesEqual(
      expectedRootIdentity, workspaceSyncRootObjectIdentityFromStat(before),
    )) {
      throw Object.assign(new Error('Workspace copy root identity changed before measurement'), { code: 'root_changed' });
    }
    const descriptorPath = `/proc/self/fd/${directory.fd}`;
    const rawNames = (await readdir(descriptorPath, { encoding: 'buffer' })).sort(Buffer.compare);
    const names = rawNames.map((rawName) => {
      const name = rawName.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(rawName)) {
        throw Object.assign(new Error('workspace directory contains an unrepresentable filename'), { code: 'workspace_file_unsupported' });
      }
      return name;
    });
    const entries: Array<readonly [string, WorkspaceSyncEntryExpectationV1]> = [];
    let sizeBytes = 0;
    // Traverse sequentially so a large valid tree cannot exhaust this process's
    // descriptor budget merely because every sibling was opened concurrently.
    for (const name of names) {
      const observed = await observeAtDescriptorPath(resolve(descriptorPath, name), measureSize);
      if (typeof observed === 'number') {
        sizeBytes += observed;
        if (!Number.isSafeInteger(sizeBytes)) {
          throw Object.assign(new Error('workspace copy size cannot be represented'), { code: 'workspace_file_unsupported' });
        }
      } else {
        entries.push([name, observed]);
      }
    }
    const after = await directory.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) throw changed('workspace directory changed during observation');
    if (measureSize) return sizeBytes;
    const fingerprint = createHash('sha256').update(JSON.stringify({ v: 1, entries })).digest('hex');
    return { kind: 'directory', fingerprint };
  } finally {
    await directory.close();
  }
}

/** Passive logical regular-file bytes; the same confined traversal does not hash content in this mode. */
export async function measureWorkspaceSyncRegularFileBytesAtRoot(input: ObserveWorkspaceSyncEntryAtRootInput & Readonly<{
  /** Linux compares the opened target fstat. Native platforms use the prepared authority callback and held-name revalidation. */
  expectedRootIdentity?: WorkspaceSyncRootObjectIdentityV1;
}>): Promise<number> {
  if (process.platform !== 'linux') return await runNativeConfinedWorkspaceSyncMeasure(input);
  const observed = await withConfinedWorkspaceSyncParent({
    rootPath: input.rootPath,
    relativePath: input.relativePath,
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    run: async ({ parentHandlePath, finalName }) => await observeAtDescriptorPath(
      resolve(parentHandlePath, finalName), true, input.expectedRootIdentity,
    ),
  });
  if (typeof observed !== 'number') throw unsafePath('workspace measurement returned an invalid result');
  return observed;
}

/** Canonical complete observation used by both reviewed comparison and mutation. */
export async function observeWorkspaceSyncEntryAtRoot(
  input: ObserveWorkspaceSyncEntryAtRootInput,
  dependencies: ObserveWorkspaceSyncEntryAtRootDependencies = {},
): Promise<WorkspaceSyncEntryExpectationV1> {
  if (process.platform !== 'linux') {
    return WorkspaceSyncEntryExpectationV1Schema.parse(await (
      dependencies.runNativeConfinedObserve ?? runNativeConfinedWorkspaceSyncObserve
    )(input));
  }
  const observed = await withConfinedWorkspaceSyncParent({
    rootPath: input.rootPath,
    relativePath: input.relativePath,
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    run: async ({ parentHandlePath, finalName }) => await observeAtDescriptorPath(resolve(parentHandlePath, finalName)),
  });
  return WorkspaceSyncEntryExpectationV1Schema.parse(observed);
}

export async function readWorkspaceSyncFileAtRoot(
  input: ReadWorkspaceSyncFileAtRootInput,
  dependencies: ReadWorkspaceSyncFileAtRootDependencies = {},
): Promise<ReadWorkspaceSyncFileResultV1> {
  const maxBytes = validateMaxBytes(input.maxBytes);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const outcome = await (dependencies.runNativeConfinedRead ?? runNativeConfinedWorkspaceSyncRead)({
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      maxBytes,
      ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
      ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    });
    if (outcome.status !== 'content') return outcome;
    if (outcome.content.includes(0)) {
      return { status: 'binary', digest: outcome.digest, size: outcome.size };
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.content);
      return { status: 'text', text, digest: outcome.digest, size: outcome.size };
    } catch {
      return { status: 'binary', digest: outcome.digest, size: outcome.size };
    }
  }
  return await withConfinedWorkspaceSyncParent({
    rootPath: input.rootPath,
    relativePath: input.relativePath,
    ...(input.assertCurrentAuthority ? { assertCurrentAuthority: input.assertCurrentAuthority } : {}),
    run: async ({ parentHandlePath, finalName }) => {
      const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
      const handle = await open(resolve(parentHandlePath, finalName), openFlags).catch((error: unknown) => {
        if (isMissing(error)) return null;
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
          throw unsafePath('workspace file preview does not follow symlinks');
        }
        throw error;
      });
      if (!handle) return { status: 'missing' };
      try {
        const before = await handle.stat();
        if (!before.isFile()) {
          throw Object.assign(new Error('workspace conflict entry is not a file'), {
            code: 'workspace_file_unsupported',
          });
        }
        if (before.size > maxBytes && input.expectedDigest === undefined) {
          return { status: 'too_large', size: before.size };
        }

        const hash = createHash(MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM);
        const retained: Buffer[] = [];
        let retainedBytes = 0;
        let offset = 0;
        const chunk = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
          if (bytesRead === 0) break;
          const bytes = chunk.subarray(0, bytesRead);
          hash.update(bytes);
          if (retainedBytes <= maxBytes) {
            const remaining = maxBytes + 1 - retainedBytes;
            if (remaining > 0) {
              const retainedChunk = Buffer.from(bytes.subarray(0, remaining));
              retained.push(retainedChunk);
              retainedBytes += retainedChunk.byteLength;
            }
          }
          offset += bytesRead;
        }
        const after = await handle.stat();
        const digest = hash.digest('hex');
        if (
          after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ino !== before.ino
          || after.dev !== before.dev
          || (input.expectedDigest !== undefined && digest !== input.expectedDigest)
        ) {
          return { status: 'changed', actualDigest: digest };
        }
        if (offset > maxBytes) {
          return { status: 'too_large', size: offset, digest };
        }

        const bytes = Buffer.concat(retained, offset);
        if (bytes.includes(0)) return { status: 'binary', digest, size: offset };
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return { status: 'text', text, digest, size: offset };
        } catch {
          return { status: 'binary', digest, size: offset };
        }
      } finally {
        await handle.close();
      }
    },
  });
}
