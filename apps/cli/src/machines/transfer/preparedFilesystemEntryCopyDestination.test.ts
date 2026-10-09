import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createWorkspaceSyncEntryExport } from '@/workspaces/sync/workspaceSyncEntryTransfer';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import type { WorkspaceSyncNativeConfinedChild } from '@/workspaces/sync/workspaceSyncNativeConfinedFileSystem';
import { readTransferPayloadChunk, resolveTransferPayloadSizeBytes } from './transferPayloadSource';
import { createPreparedFilesystemEntryCopyDestination } from './preparedFilesystemEntryCopyDestination';

async function fixture() {
  const owner = await mkdtemp(join(tmpdir(), 'prepared-entry-copy-'));
  const source = join(owner, 'source');
  const root = join(owner, 'root');
  const stagingDirectory = join(owner, 'staging');
  const recoveryDirectory = join(owner, 'recovery');
  await Promise.all([source, root, stagingDirectory, recoveryDirectory].map((path) => mkdir(path)));
  const bytes = Buffer.from([0, 255, 1, 128]);
  await writeFile(join(source, 'bytes.bin'), bytes);
  await Promise.all(['.git', 'node_modules', '.hidden'].map(async (name) => {
    await mkdir(join(source, name));
    await writeFile(join(source, name, 'binary-child'), bytes);
  }));
  await mkdir(join(source, '~'));
  await writeFile(join(source, '~', 'literal.bin'), bytes);
  await symlink('~/literal.bin', join(source, 'literal-link'));
  const expectation = await observeWorkspaceSyncEntryAtRoot({ rootPath: dirname(source), relativePath: basename(source) });
  const operationId = 'prepared-copy-test';
  const prepared = await createWorkspaceSyncEntryExport({ operationId, expectation, materialPath: source });
  const input = {
    operationId, rootPath: root, path: 'tree', requesterAccountId: 'verified-requester',
    overwrite: false, recursive: true, expectation, stagingDirectory, recoveryDirectory,
    assertCurrentAuthority: async () => {},
    requestPayload: async ({ transferId, destinationPath }: { transferId: string; destinationPath: string }) => {
      const payload = transferId === operationId ? prepared.payloadSource
        : await prepared.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null });
      const size = await resolveTransferPayloadSizeBytes(payload);
      await writeFile(destinationPath, await readTransferPayloadChunk({ source: payload, offset: 0, length: size }));
    },
  };
  const deps = { workingDirectory: root, accessPolicy: { kind: 'restrictedRoots' as const, roots: [root] } };
  return { owner, root, source, bytes, input, deps, dispose: () => rm(owner, { recursive: true, force: true }) };
}

describe('prepared filesystem entry copy destination', () => {
  it.skipIf(process.platform !== 'linux')('installs the complete binary tree through native confinement and preserves literal tilde links', async () => {
    const f = await fixture();
    try {
      await expect(createPreparedFilesystemEntryCopyDestination(f.deps)(f.input)).resolves.toEqual({ status: 'installed' });
      await expect(readFile(join(f.root, 'tree', 'bytes.bin'))).resolves.toEqual(f.bytes);
      for (const name of ['.git', 'node_modules', '.hidden']) {
        await expect(readFile(join(f.root, 'tree', name, 'binary-child'))).resolves.toEqual(f.bytes);
      }
      await expect(readFile(join(f.root, 'tree', 'literal-link'))).resolves.toEqual(f.bytes);
      await expect(readlink(join(f.root, 'tree', 'literal-link'))).resolves.toBe('~/literal.bin');
      await expect(readFile(join(f.source, 'bytes.bin'))).resolves.toEqual(f.bytes);
    } finally { await f.dispose(); }
  });

  it('rejects missing requester, unauthorized roots, root replacement, nonrecursive trees and overwrite conflicts without public effects', async () => {
    const f = await fixture();
    try {
      const apply = createPreparedFilesystemEntryCopyDestination(f.deps);
      await expect(apply({ ...f.input, requesterAccountId: '' })).rejects.toMatchObject({ code: 'filesystem_requester_unavailable' });
      await expect(apply({ ...f.input, rootPath: f.source })).rejects.toMatchObject({ code: 'access_denied' });
      await expect(apply({ ...f.input, path: '.' })).rejects.toMatchObject({ code: 'root_refused' });
      await expect(createPreparedFilesystemEntryCopyDestination({
        workingDirectory: join(f.root, 'tree', 'workspace'), accessPolicy: { kind: 'osUser' },
      })(f.input)).rejects.toMatchObject({ code: 'root_refused' });
      await expect(apply({ ...f.input, recursive: false })).rejects.toMatchObject({ code: 'recursive_required' });
      await mkdir(join(f.root, 'tree'));
      await writeFile(join(f.root, 'tree', 'incumbent.bin'), f.bytes);
      await expect(apply(f.input)).rejects.toMatchObject({ code: 'destination_exists' });
      await expect(apply({ ...f.input, overwrite: true, expectation: { kind: 'missing' } })).rejects.toMatchObject({ code: 'source_missing' });
      await expect(readFile(join(f.root, 'tree', 'incumbent.bin'))).resolves.toEqual(f.bytes);
    } finally { await f.dispose(); }
  });

  it.skipIf(process.platform !== 'linux')('installs missing destination parents together with the complete copied tree', async () => {
    const f = await fixture();
    try {
      await expect(createPreparedFilesystemEntryCopyDestination(f.deps)({ ...f.input, path: 'missing/deep/tree' }))
        .resolves.toEqual({ status: 'installed' });
      await expect(readFile(join(f.root, 'missing', 'deep', 'tree', 'bytes.bin'))).resolves.toEqual(f.bytes);
      await expect(readFile(join(f.root, 'missing', 'deep', 'tree', 'literal-link'))).resolves.toEqual(f.bytes);
    } finally { await f.dispose(); }
  });

  it.skipIf(process.platform !== 'linux')('does not overwrite a missing ancestor that another caller creates during staging', async () => {
    const f = await fixture();
    let changed = false;
    try {
      await expect(createPreparedFilesystemEntryCopyDestination(f.deps)({ ...f.input, path: 'missing/deep/tree', overwrite: true,
        requestPayload: async (request) => {
          if (!changed) {
            changed = true;
            await mkdir(join(f.root, 'missing'));
            await writeFile(join(f.root, 'missing', 'external.bin'), f.bytes);
          }
          await f.input.requestPayload(request);
        },
      })).rejects.toMatchObject({ code: 'conflict_changed' });
      await expect(readFile(join(f.root, 'missing', 'external.bin'))).resolves.toEqual(f.bytes);
      await expect(readFile(join(f.root, 'missing', 'deep', 'tree', 'bytes.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.dispose(); }
  });

  it('refuses prospective escaping symlinks before native apply', async () => {
    const f = await fixture();
    try {
      await symlink('../../source/bytes.bin', join(f.source, 'escape'));
      const expectation = await observeWorkspaceSyncEntryAtRoot({ rootPath: dirname(f.source), relativePath: basename(f.source) });
      const prepared = await createWorkspaceSyncEntryExport({ operationId: f.input.operationId, expectation, materialPath: f.source });
      await expect(createPreparedFilesystemEntryCopyDestination(f.deps)({ ...f.input, expectation,
        requestPayload: async ({ transferId, destinationPath }) => {
          const payload = transferId === f.input.operationId ? prepared.payloadSource
            : await prepared.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null });
          await writeFile(destinationPath, await readTransferPayloadChunk({ source: payload, offset: 0, length: await resolveTransferPayloadSizeBytes(payload) }));
        },
      })).rejects.toMatchObject({ code: 'access_denied' });
      await expect(readFile(join(f.root, 'tree', 'bytes.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.dispose(); }
  });

  it.skipIf(process.platform !== 'linux')('does not overwrite a destination changed while the complete tree is being staged', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'tree'));
    await writeFile(join(f.root, 'tree', 'incumbent.bin'), f.bytes);
    let changed = false;
    try {
      await expect(createPreparedFilesystemEntryCopyDestination(f.deps)({ ...f.input, overwrite: true,
        requestPayload: async (request) => {
          if (!changed) {
            changed = true;
            await writeFile(join(f.root, 'tree', 'concurrent.bin'), 'external writer');
          }
          await f.input.requestPayload(request);
        },
      })).rejects.toMatchObject({ code: 'conflict_changed' });
      await expect(readFile(join(f.root, 'tree', 'concurrent.bin'), 'utf8')).resolves.toBe('external writer');
      await expect(readFile(join(f.root, 'tree', 'incumbent.bin'))).resolves.toEqual(f.bytes);
    } finally { await f.dispose(); }
  });

  it('preserves staged bytes and recovery custody when the native process loses its terminal result after commit', async () => {
    const f = await fixture();
    // Only the packaged native process boundary is replaced; staging and admission remain real.
    class Child extends EventEmitter implements WorkspaceSyncNativeConfinedChild {
      readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
      kill() { return true; }
    }
    const child = new Child();
    let writes = 0;
    child.stdin.on('data', () => {
      writes += 1;
      if (writes === 1) child.stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n');
      else { child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', 1, null)); }
    });
    try {
      const result = await createPreparedFilesystemEntryCopyDestination({ ...f.deps,
        nativeDependencies: { resolveExecutable: () => '/packaged/happier-process-custody', spawnChild: () => child },
      })(f.input);
      expect(result).toEqual({ status: 'recovery_needed', recoveryPath: join(f.input.recoveryDirectory, `workspace-recovery-${f.input.operationId}.json`) });
      await expect(readFile(join(f.input.stagingDirectory, 'entry', 'bytes.bin'))).resolves.toEqual(f.bytes);
      await expect(readFile(join(f.root, 'tree', 'bytes.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.dispose(); }
  });
});
