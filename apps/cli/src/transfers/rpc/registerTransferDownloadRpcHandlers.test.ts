import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTransferRecipientKeyPair, TransferSessionStore } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerTransferDownloadRpcHandlers } from './registerTransferDownloadRpcHandlers';

describe('filesystem download RPC custody', () => {
  it('returns typed source absence through download RPC after a successful source read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-download-source-'));
    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const handlers = new Map<string, RpcHandler>();
    registerTransferDownloadRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } },
      { workingDirectory: root, store });
    try {
      await writeFile(join(root, 'present.webm'), Buffer.from([1, 2, 3]));
      const invoke = handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)!;
      const request = { t: 'session_file_download_v1', path: 'present.webm',
        recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64 };
      expect(await invoke(request)).toMatchObject({ success: true, sizeBytes: 3 });
      expect(await invoke({ ...request, path: 'missing.webm' })).toMatchObject({ success: false, errorCode: 'not_found' });
    } finally { await store.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['present_user', 'account_automation'] as const)('refuses member/Agent handle reuse while preserving %s owner downloads', async callerAuthority => {
    const root = await mkdtemp(join(tmpdir(), 'happier-download-rpc-custody-'));
    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const handlers = new Map<string, RpcHandler>();
    const deps = { workingDirectory: root, store,
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) };
    registerTransferDownloadRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, deps);
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
        sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'copied-owner-download' } },
      { ...owner, verifyMachineAdmissionCurrent: async () => false },
    ];
    try {
      await writeFile(join(root, 'private.bin'), Buffer.from([0, 255, 128, 10]), { mode: 0o600 });
      const request = { t: 'session_file_download_v1', path: join(root, 'private.bin'),
        recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64 };
      for (const context of denied) {
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, request, context))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      const initialized = await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, request, owner);
      expect(initialized).toMatchObject({ success: true });
      if (!initialized || typeof initialized !== 'object' || !('downloadId' in initialized)
        || typeof initialized.downloadId !== 'string') throw new Error('Missing owner download');
      const downloadId = initialized.downloadId;
      for (const context of denied) for (const method of [RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT]) {
        expect(await invoke(method, { downloadId, index: 0 }, context))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId, index: 0 }, owner))
        .toMatchObject({ success: true, payloadBase64: expect.any(String) });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId }, owner)).toEqual({ success: true });
      const cleanup = await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, request, owner);
      if (!cleanup || typeof cleanup !== 'object' || !('downloadId' in cleanup)) throw new Error('Missing owner cleanup handle');
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT, { downloadId: cleanup.downloadId }, owner)).toEqual({ success: true });
    } finally { await store.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
