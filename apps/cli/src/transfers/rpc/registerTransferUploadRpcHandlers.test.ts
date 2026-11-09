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

describe('generic upload request admission', () => {
  it.each(['present_user', 'account_automation'] as const)('refuses protected reused phases while preserving %s owner uploads', async callerAuthority => {
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
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const denied = [
      { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member' } },
      { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'manage' as const } },
      { ...owner, callerAuthority: 'account_automation' as const,
        localActionContext: { actionCaller: { kind: 'session' as const, sessionId: 'owner-session', starterDepth: 0, turnDepth: 0 } } },
      { ...owner, sessionActionOrigin: { v: 1 as const,
        caller: { kind: 'session' as const, sessionId: 'copied-owner-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'copied-owner-upload' } },
      { ...owner, verifyMachineAdmissionCurrent: async () => false },
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
