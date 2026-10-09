import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from './createPreparedFilesystemTransferActionExecutor';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';
import { FilesystemUploadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';

describe('headless prepared filesystem client', () => {
  it.each(['matching', 'wrong_source', 'wrong_size', 'wrong_hash', 'cancel_after_chunk'] as const)('drives a previously admitted copy receipt exactly once and preserves %s custody', async mode => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-admitted-copy-'));
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: address.port, listenerClasses: ['loopback_http'] });
    const owner = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: rootPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'admitted-copy',
      resolveAction: actionId => ({ actionId, title: 'Copy', operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } }) });
    const scope = { accountId: 'account-one', machineId: 'destination' };
    const sourcePath = join(rootPath, 'actual-source');
    const payload = Buffer.from([0, 255, 128, 10]);
    const source = { kind: 'file' as const, sourceId: 'captured-source', sizeBytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'), serverId: 'home', machineId: 'source', rootPath, path: 'actual-source' };
    const executeAction = vi.fn(async () => { throw new Error('Copy admission was repeated'); });
    const openMachineTunnel = vi.fn(async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct' as const, close: async () => {} }));
    const client = createPreparedFilesystemTransferClient({ executeAction, openMachineTunnel });
    const cancellation = new AbortController();
    const nativeFetch = globalThis.fetch;
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await nativeFetch(...args);
      if (mode === 'cancel_after_chunk' && String(args[0]).endsWith('/chunks/0')) cancellation.abort();
      return response;
    });
    try {
      await writeFile(sourcePath, payload);
      const result = await runner.observe({ actionId: 'daemon.filesystem.copy', scope,
        execute: async context => projectPreparedFilesystemActionResult(await owner({ actionId: 'daemon.filesystem.copy',
          input: { kind: 'prepared_transfer', source, destination: { serverId: 'home', machineId: 'destination', rootPath, path: 'copied' }, overwrite: false, recursive: false },
          context: { ...context, runtimeAccountId: scope.accountId, serverId: 'home',
            externalActionTarget: { kind: 'machine', machineId: 'destination' } } })) });
      if (!result.ok) throw new Error(result.error);
      const receipt = FilesystemUploadOutputSchema.parse(result.result);
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Expected active copy admission');
      const transferred = await client.upload({ targetMachineId: 'destination', serverId: 'home', rootPath, path: 'copied', sourcePath,
        source: mode === 'wrong_hash' ? { ...source, sha256: 'f'.repeat(64) } : source, overwrite: false, signal: cancellation.signal,
        preparedAdmission: mode === 'wrong_source' ? { ...receipt, sourceId: 'another-source' }
          : mode === 'wrong_size' ? { ...receipt, prepared: { ...receipt.prepared, expectedSizeBytes: payload.length + 1 } } : receipt });
      expect(executeAction).not.toHaveBeenCalled();
      if (mode === 'matching') {
        expect(transferred).toMatchObject({ success: true, status: 'completed', sourceId: source.sourceId });
        expect(await readFile(join(rootPath, 'copied'))).toEqual(payload);
      } else if (mode === 'cancel_after_chunk') {
        expect(transferred).toMatchObject({ success: false, status: 'cancelled' });
        expect(await lifecycle.activity.read()).toMatchObject({ items: [] });
        expect(fetchBoundary.mock.calls.some(([url]) => String(url).endsWith('/abort'))).toBe(true);
        await expect(readFile(join(rootPath, 'copied'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(transferred).toMatchObject({ success: false, status: 'unknown', errorCode: 'indeterminate' });
        expect(openMachineTunnel).not.toHaveBeenCalled();
        await expect(readFile(join(rootPath, 'copied'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally { fetchBoundary.mockRestore(); await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it('retains an already admitted copy as unknown when source admission fails before its import capability can be reached', async () => {
    const client = createPreparedFilesystemTransferClient({ openMachineTunnel: async () => { throw new Error('Unexpected carrier'); },
      executeAction: async () => ({ ok: false, errorCode: 'source_unavailable', error: 'Source admission refused' }) });
    const result = await client.copy({ source: { kind: 'file', serverId: 'source', machineId: 'source', rootPath: '/source', path: 'binary',
      sourceId: 'captured', sizeBytes: 4, sha256: 'a'.repeat(64) }, destination: { serverId: 'destination', machineId: 'destination', rootPath: '/destination', path: 'binary' },
      overwrite: false, recursive: false, preparedAdmission: { success: true, status: 'accepted', operationId: 'already-admitted', sourceId: 'captured',
        prepared: { uploadId: 'opaque', destDisplayPath: '/destination/binary', expectedSizeBytes: 4, chunkSizeBytes: 4,
          recipientPublicKeyBase64: Buffer.alloc(32).toString('base64'), expiresAt: Date.now() + 1000, endpointCandidates: [] } } });
    expect(result).toMatchObject({ success: false, status: 'unknown', errorCode: 'indeterminate' });
  });
  it('refuses a public entry descriptor without its original export capability before preparing another source', async () => {
    const executeAction = vi.fn(async () => { throw new Error('A replacement source was prepared'); });
    const openMachineTunnel = vi.fn(async () => { throw new Error('A replacement carrier was opened'); });
    const client = createPreparedFilesystemTransferClient({ executeAction, openMachineTunnel });
    await expect(client.copy({ source: { kind: 'entry_tree', serverId: 'home', machineId: 'source', rootPath: '/source', path: 'tree',
      sourceId: 'owned-source', sizeBytes: 1, sha256: 'a'.repeat(64), entryTree: { operationId: 'original-export',
        expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) }, blobs: [] } },
      destination: { serverId: 'home', machineId: 'destination', rootPath: '/destination', path: 'tree' }, overwrite: false, recursive: true }))
      .resolves.toMatchObject({ success: false, status: 'failed', errorCode: 'filesystem_transfer_custody_required' });
    expect(executeAction).not.toHaveBeenCalled(); expect(openMachineTunnel).not.toHaveBeenCalled();
  });
  it.each(['file', 'entry_tree'] as const)('copies actual %s custody between qualified Machines through the copy operation', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-cross-copy-'));
    const sourceRoot = join(directory, 'source');
    const destinationRoot = join(directory, 'destination');
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: address.port, listenerClasses: ['loopback_http'] });
    const owner = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: directory,
      accessPolicy: { kind: 'restrictedRoots', roots: [sourceRoot, destinationRoot] } });
    const store = createActionOperationStore();
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `copy-operation-${++sequence}`,
      resolveAction: actionId => ({ actionId, title: 'File transfer', operation: { version: 1, visibility: 'activity',
        progress: 'reported', presentation: { onStart: 'activity' } } }) });
    const client = createPreparedFilesystemTransferClient({
      openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct' as const, close: async () => {} }),
      executeAction: async (actionId, input, context) => {
        if (actionId === 'action.operations.get') return { ok: true, result: await createActionOperationRpcHandlers({ store, runner,
          machineId: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : '', resolveAccountId: async () => 'account-one' }).get({ operationId: 'operationId' in Object(input) ? (input as { operationId: string }).operationId : '', waitForTerminal: true }) };
        return await runner.observe({ actionId,
        scope: { accountId: 'account-one', machineId: context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : '' },
        execute: async ({ operationAcceptance, signal }) => projectPreparedFilesystemActionResult(await owner({ actionId, input,
          context: { ...context, runtimeAccountId: 'account-one', operationAcceptance, signal } })) }); },
    });
    try {
      const bytes = Buffer.from([0, 255, 128, 42]);
      await writeFile(join(sourceRoot, 'source.dat'), bytes);
      await mkdir(join(sourceRoot, 'tree'));
      for (const name of ['.git', 'node_modules', '.hidden', '~']) {
        await mkdir(join(sourceRoot, 'tree', name)); await writeFile(join(sourceRoot, 'tree', name, 'literal.bin'), bytes);
      }
      await symlink('~/literal.bin', join(sourceRoot, 'tree', 'literal-link'));
      const copied = await client.copy({ source: kind === 'file' ? { kind: 'file', serverId: 'home-one', machineId: 'machine-source', rootPath: sourceRoot,
        path: 'source.dat', sourceId: 'copy-source', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
        : { serverId: 'home-one', machineId: 'machine-source', rootPath: sourceRoot, path: 'tree' },
        destination: { serverId: 'home-one', machineId: 'machine-destination', rootPath: destinationRoot, path: kind === 'file' ? 'copied.dat' : 'tree' }, overwrite: false, recursive: kind === 'entry_tree' });
      expect(copied, JSON.stringify(copied)).toMatchObject(kind === 'file' ? { success: true, status: 'completed', sourceId: 'copy-source', sizeBytes: bytes.length }
        : { success: true, status: 'completed', expectation: { kind: 'directory' } });
      if (kind === 'file') expect(await readFile(join(destinationRoot, 'copied.dat'))).toEqual(bytes);
      else {
        for (const name of ['.git', 'node_modules', '.hidden', '~']) expect(await readFile(join(destinationRoot, 'tree', name, 'literal.bin'))).toEqual(bytes);
        expect(await readlink(join(destinationRoot, 'tree', 'literal-link'))).toBe('~/literal.bin');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(store.get({ accountId: 'account-one', machineId: 'machine-destination' }, 'copy-operation-2')).toMatchObject({
        state: 'succeeded', actionId: 'daemon.filesystem.copy' });
    } finally { await lifecycle.stop(); await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves deferred approval without opening a byte carrier', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-file-approval-'));
    const approval = { kind: 'approval_request_created' as const, artifactId: 'approval-one', actionId: 'daemon.filesystem.upload' };
    const openMachineTunnel = vi.fn(async () => { throw new Error('Byte carrier opened before approval'); });
    const client = createPreparedFilesystemTransferClient({ openMachineTunnel,
      // The signed Action transport is the network boundary.
      executeAction: async () => ({ ok: true, result: approval }),
    });
    const sourceName = process.platform === 'win32' ? 'source file.dat' : ' source\n.dat ';
    try {
      await writeFile(join(rootPath, sourceName), Buffer.from([0, 255]));
      await expect(client.upload({ targetMachineId: 'machine-one', rootPath, path: ' remote\n.dat ',
        sourcePath: join(rootPath, sourceName), overwrite: false })).resolves.toEqual(approval);
      expect(openMachineTunnel).not.toHaveBeenCalled();
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });
  it.each([false, true])('moves binary files through real prepared HTTP imports and exports and settles both Actions (lost finalize response: %s)', async (lostFinalizeResponse) => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-headless-files-'));
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: port, listenerClasses: ['loopback_http'] });
    const execute = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: rootPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const store = createActionOperationStore();
    let sequence = 0;
    const scope = { accountId: 'account-one', machineId: 'target-machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => `operation-${++sequence}`,
      resolveAction: actionId => ({ actionId, title: 'File transfer', operation: { version: 1, visibility: 'activity',
        progress: 'reported', presentation: { onStart: 'activity' } } }) });
    // Native tunnel establishment is the transport boundary. The test uses its
    // actual loopback HTTP listener; the production opener verifies machine/1.
    const client = createPreparedFilesystemTransferClient({
      openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct' as const, close: async () => {} }),
      executeAction: async (actionId, input, context) => {
        if (actionId === 'action.operations.get') throw new Error('No tree copy in this fixture');
        return await runner.observe({ actionId, scope,
        execute: async ({ operationAcceptance, signal }) => projectPreparedFilesystemActionResult(await execute({ actionId, input,
          context: { ...context, runtimeAccountId: scope.accountId, operationAcceptance, signal } })) }); },
    });
    const payload = Buffer.from([0, 255, 128, 10, 13, 200]);
    const sourceName = process.platform === 'win32' ? 'local source.dat' : ' local-source\n.dat ';
    const remoteName = process.platform === 'win32' ? 'remote file.dat' : ' remote\n.dat ';
    const destinationName = process.platform === 'win32' ? 'local destination.dat' : ' local-destination\n.dat ';
    const nativeFetch = globalThis.fetch;
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await nativeFetch(...args);
      if (lostFinalizeResponse && String(args[0]).endsWith('/finalize')) {
        await response.body?.cancel();
        throw new TypeError('Connection lost after committed finalize');
      }
      return response;
    });
    try {
      await writeFile(join(rootPath, sourceName), payload);
      const upload = await client.upload({ targetMachineId: scope.machineId, rootPath, path: remoteName,
        sourcePath: join(rootPath, sourceName), source: { sourceId: 'actual-cli-source', sizeBytes: payload.length,
          sha256: createHash('sha256').update(payload).digest('hex') }, overwrite: false });
      expect(upload).toMatchObject(lostFinalizeResponse
        ? { success: false, status: 'unknown', errorCode: 'indeterminate' }
        : { success: true, status: 'completed', sourceId: 'actual-cli-source', sizeBytes: payload.length });
      expect(await readFile(join(rootPath, remoteName))).toEqual(payload);
      const download = await client.download({ targetMachineId: scope.machineId, rootPath, path: remoteName,
        destinationPath: join(rootPath, destinationName), destinationId: 'actual-cli-destination', asZip: false });
      expect(download).toMatchObject({ success: true, status: 'completed', destinationId: 'actual-cli-destination', sizeBytes: payload.length });
      expect(await readFile(join(rootPath, destinationName))).toEqual(payload);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(store.get(scope, 'operation-1')).toMatchObject({ state: 'succeeded' });
      expect(store.get(scope, 'operation-2')).toMatchObject({ state: 'succeeded' });
    } finally { fetchBoundary.mockRestore(); await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
});
