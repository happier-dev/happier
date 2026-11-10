import { describe, expect, it } from 'vitest';
import { createEncryptedTransferChunkEnvelope, TransferSessionStore } from '@happier-dev/transfers/node';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { registerTransferUploadRpcHandlers } from './registerTransferUploadRpcHandlers';
import { acquireDeploymentRestoreUpload } from '../targets/deploymentRestoreUpload';

describe('generic upload request admission', () => {
  it('finishes an Environment import in finite custody without exposing its scratch path', async () => {
    const workingDirectory = await createTempDir('happier-deployment-upload-');
    const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    registerTransferUploadRpcHandlers({ registerHandler: (method, handler) => {
      handlers.set(method, handler as RpcHandler<unknown, unknown>);
    } }, { workingDirectory, store });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' } };
    // Transport boundary supplies the already admitted invocation. Domain
    // transfer, encryption, filesystem and expiry owners run unchanged.
    const invoke = async (method: string, input: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('Missing transfer handler');
      return await handler(input, context);
    };
    try {
      const bytes = Buffer.from('PGDMPfinite-custom-archive');
      const init = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        { t: 'deployment_restore_upload_v1', environmentId: 'environment', sizeBytes: bytes.length });
      expect(init).toMatchObject({ success: true, uploadId: expect.any(String) });
      if (!init || typeof init !== 'object' || !('uploadId' in init) || typeof init.uploadId !== 'string'
        || !('recipientPublicKeyBase64' in init) || typeof init.recipientPublicKeyBase64 !== 'string') throw new Error('Missing upload');
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
        payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }))
        .toMatchObject({ success: false });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
        payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 }))
        .toMatchObject({ success: true });
      const done = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
      expect(done).toMatchObject({ success: true, transferId: init.uploadId, sizeBytes: bytes.length, sha256: expect.any(String) });
      expect(done).not.toHaveProperty('path');
      expect(acquireDeploymentRestoreUpload(store, { transferId: init.uploadId, accountId: 'other', environmentId: 'environment' })).toBeNull();
      expect(acquireDeploymentRestoreUpload(store, { transferId: init.uploadId, accountId: 'owner', environmentId: 'other' })).toBeNull();
      const admitted = acquireDeploymentRestoreUpload(store, { transferId: init.uploadId, accountId: 'owner', environmentId: 'environment' });
      if (!admitted) throw new Error('Missing complete finite upload');
      try {
        expect(await admitted.source.readChunk({ offset: 0, length: bytes.length })).toEqual(bytes);
        // An expired transfer cannot discard a file already admitted by restore.
        store.cleanupExpiredBestEffort(Number.MAX_SAFE_INTEGER);
        expect(await admitted.source.readChunk({ offset: 0, length: bytes.length })).toEqual(bytes);
      } finally { admitted.release(); }
    } finally { await store.dispose(); await removeTempDir(workingDirectory); }
  });

  it.each((['present_user', 'account_automation'] as const).flatMap(callerAuthority => [
    { callerAuthority, actorAccountId: 'owner', role: 'use' as const },
    { callerAuthority, actorAccountId: 'manager', role: 'manage' as const },
  ]))('refuses protected reused phases while preserving $callerAuthority $role uploads', async ({ callerAuthority, actorAccountId, role }) => {
    const workingDirectory = await createTempDir('happier-upload-rpc-custody-');
    const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
    const handlers = new Map<string, RpcHandler>();
    const deps = { workingDirectory, store,
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) };
    registerTransferUploadRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, deps);
    const invoke = async (method: string, input: unknown, context: RpcHandlerContext) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('Transfer handler is unavailable');
      return await handler(input, context);
    };
    const owner: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority,
      machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role, encryptionMode: 'plain' },
      // Ingress already admitted the finite invocation; this downstream owner
      // consumes its actor custody and cancellation without reauthorizing it.
      verifyMachineAdmissionCurrent: async () => false };
    const denied = [
      // Manage grants physical Machine control (OWNER-RULINGS 2026-10-31).
      // A Use member and copied Agent/Session custody remain isolated.
      { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'use' as const } },
      { ...owner, callerAuthority: 'account_automation' as const,
        localActionContext: { actionCaller: { kind: 'session' as const, sessionId: 'owner-session', starterDepth: 0, turnDepth: 0 } } },
      { ...owner, sessionActionOrigin: { v: 1 as const,
        caller: { kind: 'session' as const, sessionId: 'copied-owner-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'copied-owner-upload' } },
    ];
    const path = join(workingDirectory, 'private.bin');
    try {
      const request = { t: 'session_file_upload_v1', path, sizeBytes: 4, overwrite: false };
      for (const context of denied) {
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request, context))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      const initialized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request, owner);
      expect(initialized).toMatchObject({ success: true });
      if (!initialized || typeof initialized !== 'object' || !('uploadId' in initialized) || typeof initialized.uploadId !== 'string'
        || !('recipientPublicKeyBase64' in initialized) || typeof initialized.recipientPublicKeyBase64 !== 'string') {
        throw new Error('Missing owner upload');
      }
      const uploadId = initialized.uploadId;
      const chunk = createEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence: 0,
        payload: Buffer.from([0, 255, 128, 10]), recipientPublicKeyBase64: initialized.recipientPublicKeyBase64 });
      for (const context of denied) for (const method of [RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
        RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT]) {
        expect(await invoke(method, { uploadId, index: 0, payloadBase64: chunk.payloadBase64,
          encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 }, context))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId, index: 0,
        payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 }, owner))
        .toEqual({ success: true });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId }, owner)).toMatchObject({ success: true });
      expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128, 10]));
      const cleanup = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { ...request, path: join(workingDirectory, 'cleanup.bin') }, owner);
      if (!cleanup || typeof cleanup !== 'object' || !('uploadId' in cleanup)) throw new Error('Missing owner cleanup handle');
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: cleanup.uploadId }, owner)).toEqual({ success: true });
      await expect(access(join(workingDirectory, 'cleanup.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await store.dispose(); await removeTempDir(workingDirectory); }
  });

  it('refuses the retired asset tag without reinterpreting it as a workspace upload', async () => {
    const workingDirectory = await createTempDir('happier-retired-upload-');
    const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    registerTransferUploadRpcHandlers(manager, { workingDirectory, store });
    try {
      const request = { path: 'retained.txt', sizeBytes: 0 };
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        { ...request, t: 'prompt_asset_upload_v1' })).toMatchObject({ success: false });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        { ...request, t: 'session_file_upload_v1' })).toMatchObject({ success: true, uploadId: expect.any(String) });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request))
        .toMatchObject({ success: true, uploadId: expect.any(String) });
    } finally {
      await store.dispose();
      await removeTempDir(workingDirectory);
    }
  });
});
