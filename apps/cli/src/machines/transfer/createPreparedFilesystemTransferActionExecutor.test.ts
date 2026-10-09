import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { FilesystemUploadOutputSchema, FilesystemCopyOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from './createPreparedFilesystemTransferActionExecutor';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { startDirectPeerTransferServer } from './directPeerTransport';

describe('prepared filesystem Actions', () => {
  it('refuses a fresh filesystem Action at its first owner entry during the closed drain', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-fresh-filesystem-drain-'));
    const admissionDrain = createDaemonAdmissionDrain();
    let listenerStarts = 0;
    const lifecycle = createDirectTransferServerLifecycle({ admissionDrain, bindPort: 0,
      listenerClasses: ['loopback_http'], startServer: async params => {
        listenerStarts += 1;
        return await startDirectPeerTransferServer(params);
      } });
    const owner = createPreparedFilesystemTransferActionExecutor({ admissionDrain, lifecycle,
      workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'fresh-closed-transfer',
      resolveAction: actionId => ({ actionId, title: 'Upload',
        operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } }) });
    try {
      admissionDrain.beginUnusedStopDrain();
      const result = await runner.observe({ actionId: 'daemon.filesystem.upload', scope: { accountId: 'one', machineId: 'destination' },
        execute: async ({ operationAcceptance }) => projectPreparedFilesystemActionResult(await owner({ actionId: 'daemon.filesystem.upload',
          context: { runtimeAccountId: 'one', operationAcceptance },
          input: { rootPath, path: 'file', overwrite: false, source: { sourceId: 'source', sizeBytes: 0 } } })) });
      expect(result).toMatchObject({ ok: false, errorCode: 'daemon_draining' });
      expect(listenerStarts).toBe(0);
      expect(lifecycle.getState().publishedTransferCount).toBe(0);
    } finally { await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it('does not label an unconfirmed transfer owner outcome as failed', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-unknown-transfer-'));
    const lifecycle = createDirectTransferServerLifecycle({ listenerClasses: ['loopback_http'],
      startServer: async () => { throw Object.assign(new Error('Listening outcome is unconfirmed'), { errorCode: 'indeterminate' }); } });
    try {
      const owner = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
      await expect(owner({ actionId: 'daemon.filesystem.upload', input: { rootPath, path: 'file', overwrite: false,
        source: { sourceId: 'source', sizeBytes: 0 } }, context: { runtimeAccountId: 'account',
          operationAcceptance: { operationId: 'owned-transfer', actionId: 'daemon.filesystem.upload', accept: () => {} } } }))
        .resolves.toMatchObject({ success: false, status: 'unknown', errorCode: 'indeterminate' });
    } finally { await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it('retains the preparing Action across a drain and admits its later blob descriptor under original requester/root custody', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-entry-copy-'));
    const admissionDrain = createDaemonAdmissionDrain();
    let notifyListenerStarted!: () => void;
    let releaseListener!: () => void;
    const listenerStarted = new Promise<void>(resolve => { notifyListenerStarted = resolve; });
    const listenerRelease = new Promise<void>(resolve => { releaseListener = resolve; });
    const manager = createDirectTransferImportSessionManager({ admissionDrain, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const lifecycle = createDirectTransferServerLifecycle({ admissionDrain, bindPort: 46001, listenerClasses: ['loopback_http'],
      startServer: async () => { notifyListenerStarted(); await listenerRelease; return { activity: manager.activity,
        port: 46001, stop: () => manager.close(), issueImportOpenAuthorizationToken: manager.issueImportOpenAuthorizationToken,
        openTrustedImportSession: manager.openTrustedImportSession, abortImportTransferSession: manager.abortImportTransferSession,
        waitForImportTransferSettlement: manager.waitForImportTransferSettlement, cleanupExpiredImportSessions: manager.cleanupExpiredImportSessions,
        getNextImportSessionExpiryAt: manager.getNextImportSessionExpiryAt }; } });
    const owner = createPreparedFilesystemTransferActionExecutor({ admissionDrain, lifecycle, workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'entry-copy', resolveAction: actionId => ({ actionId, title: 'Copy',
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } }) });
    try {
      const preparing = runner.observe({ actionId: 'daemon.filesystem.copy', scope: { accountId: 'one', machineId: 'destination' },
        execute: async ({ operationAcceptance }) => projectPreparedFilesystemActionResult(await owner({ actionId: 'daemon.filesystem.copy',
          context: { runtimeAccountId: 'one', serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'destination' }, operationAcceptance },
          input: { kind: 'prepared_transfer', source: { kind: 'entry_tree', serverId: 'home', machineId: 'source', rootPath, path: 'dir',
            sourceId: 'source-custody', sizeBytes: 2, sha256: '0'.repeat(64), entryTree: { operationId: 'source-export', expectation: { kind: 'directory', fingerprint: '0'.repeat(64) },
              blobs: [{ transferId: 'source-blob', sizeBytes: 4, manifestHash: `sha256:${'1'.repeat(64)}` }] } },
            destination: { serverId: 'home', machineId: 'destination', rootPath, path: 'copy' }, overwrite: false, recursive: true } })) });
      await listenerStarted;
      expect(store.get({ accountId: 'one', machineId: 'destination' }, 'entry-copy')).toMatchObject({ state: 'running' });
      expect(store.readLiveWork()).toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ ownerRef: 'entry-copy', state: 'unknown' }),
      ]) });
      admissionDrain.beginUnusedStopDrain();
      releaseListener();
      const result = await preparing;
      if (!result.ok) throw new Error(result.error);
      const receipt = FilesystemCopyOutputSchema.parse(result.result);
      if (!receipt.success || !('prepared' in receipt) || !('manifest' in receipt.prepared)) throw new Error('Expected tree custody');
      expect(manager.countActiveImportSessions()).toBe(2);
      const denied = await owner({ actionId: 'daemon.filesystem.transfer.cancel', input: { rootPath, direction: 'upload', transferId: receipt.prepared.manifest.uploadId }, context: { runtimeAccountId: 'other' } });
      expect(denied).toMatchObject({ success: false, errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
      await owner({ actionId: 'daemon.filesystem.transfer.cancel', input: { rootPath, direction: 'upload', transferId: receipt.prepared.manifest.uploadId }, context: { runtimeAccountId: 'one' } });
      // The containing owner settles after cancellation of every staged blob,
      // not after one event-loop turn of asynchronous OS cleanup.
      await createActionOperationRpcHandlers({ store, runner, machineId: 'destination', resolveAccountId: async () => 'one' })
        .get({ operationId: 'entry-copy', waitForTerminal: true });
      expect(manager.countActiveImportSessions()).toBe(0);
      expect(store.get({ accountId: 'one', machineId: 'destination' }, 'entry-copy')).toMatchObject({ state: 'cancelled' });
    } finally { releaseListener(); await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it('refuses replacing the admitted copy root before preparing an import', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-copy-root-'));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const owner = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: rootPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const runner = createActionOperationRunner({ store: createActionOperationStore(), generateOperationId: () => 'protected-copy',
      resolveAction: actionId => ({ actionId, title: 'Copy', operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } }) });
    try {
      await expect(runner.observe({ actionId: 'daemon.filesystem.copy', scope: { accountId: 'account-one', machineId: 'destination' },
        execute: async ({ operationAcceptance }) => projectPreparedFilesystemActionResult(await owner({ actionId: 'daemon.filesystem.copy',
          input: { kind: 'prepared_transfer', source: { kind: 'file', serverId: 'home-one', machineId: 'source', rootPath,
            path: 'source.dat', sourceId: 'copy-source', sizeBytes: 0, sha256: '0'.repeat(64) },
            destination: { serverId: 'home-one', machineId: 'destination', rootPath, path: rootPath }, overwrite: true, recursive: false },
          context: { runtimeAccountId: 'account-one', serverId: 'home-one', externalActionTarget: { kind: 'machine', machineId: 'destination' }, operationAcceptance } }))
      })).resolves.toMatchObject({ ok: false, errorCode: 'FILESYSTEM_ROOT_PROTECTED' });
      expect(lifecycle.getState().status).toBe('stopped');
    } finally { await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it.each(['completed', 'owner_stopped'] as const)('keeps prepared custody truthful until real import completion or loss (%s)', async outcome => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-action-'));
    const manager = createDirectTransferImportSessionManager();
    // The listening socket is the OS boundary; the real manager owns all import logic.
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 46001, listenerClasses: ['loopback_http'],
      startServer: async () => ({ port: 46001, stop: () => manager.close(),
        issueImportOpenAuthorizationToken: manager.issueImportOpenAuthorizationToken,
        openTrustedImportSession: manager.openTrustedImportSession,
        abortImportTransferSession: manager.abortImportTransferSession,
        waitForImportTransferSettlement: manager.waitForImportTransferSettlement,
        cleanupExpiredImportSessions: manager.cleanupExpiredImportSessions,
        getNextImportSessionExpiryAt: manager.getNextImportSessionExpiryAt }) });
    const execute = createPreparedFilesystemTransferActionExecutor({ lifecycle,
      workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'upload-operation',
      resolveAction: actionId => ({ actionId, title: 'Upload', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } }) });
    const scope = { accountId: 'account-one', machineId: 'machine-one' };
    const payload = Buffer.from([0, 255, 128, 10]);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    try {
      const result = await runner.observe({ actionId: 'daemon.filesystem.upload', scope,
        execute: async ({ operationAcceptance, signal }) => projectPreparedFilesystemActionResult(await execute({
          actionId: 'daemon.filesystem.upload', input: { rootPath, path: 'binary.dat', overwrite: false,
            source: { sourceId: 'actual-reader', sizeBytes: payload.length, sha256 } },
          context: { runtimeAccountId: scope.accountId, operationAcceptance, signal } })) });
      if (!result.ok) throw new Error(result.error);
      const receipt = FilesystemUploadOutputSchema.parse(result.result);
      if (!receipt.success || receipt.status !== 'accepted') throw new Error('Expected live prepared custody');
      expect(receipt.sourceId).toBe('actual-reader');
      expect(store.get(scope, 'upload-operation')).toMatchObject({ state: 'running' });
      if (outcome === 'owner_stopped') {
        const operations = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
          resolveAccountId: async () => scope.accountId });
        const observation = operations.getV2({ operationId: 'upload-operation', waitForTerminal: true });
        await lifecycle.stop();
        await expect(observation).resolves.toMatchObject({ kind: 'found', operation: { state: 'running',
          observation: { kind: 'outcome_uncertain', code: 'indeterminate' } } });
        expect(store.get(scope, 'upload-operation')).toMatchObject({ state: 'running',
          observation: { kind: 'outcome_uncertain', code: 'indeterminate' } });
        return;
      }
      const envelope = createEncryptedTransferChunkEnvelope({ transferId: receipt.prepared.uploadId,
        sequence: 0, payload, recipientPublicKeyBase64: receipt.prepared.recipientPublicKeyBase64 });
      await manager.writeImportTransferChunk({ uploadId: receipt.prepared.uploadId, index: 0,
        payloadBase64: envelope.payloadBase64, encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64 });
      await manager.finalizeImportTransferSession({ uploadId: receipt.prepared.uploadId });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(store.get(scope, 'upload-operation')).toMatchObject({ state: 'succeeded',
        result: { status: 'completed', sourceId: 'actual-reader', sizeBytes: payload.length, sha256 } });
      expect(await readFile(join(rootPath, 'binary.dat'))).toEqual(payload);
    } finally { await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
});
