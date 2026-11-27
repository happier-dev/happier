import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { materializePluginSessionAttachment } from './materializePluginSessionAttachment';
import { ApiMachineClient } from '@/api/apiMachine';
import { createDaemonPluginTransferRpcResolver } from '@/plugins/daemon/runtimeOwner';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';

describe('plugin Session attachment materialization', () => {
  it('uses the daemon host carrier without a peer grant and preserves the hosted Session destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-host-attachment-'));
    const sourcePath = join(directory, 'lead.pdf');
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const machine = new ApiMachineClient('fixture-token', {
      id: 'attachment-machine', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    }, undefined, { resolveHostedSessionWorkingDirectory: async id => id === 'session-1' ? directory : null });
    let activeMachine: ApiMachineClient | null = null;
    const resolveRpc = createDaemonPluginTransferRpcResolver(() => activeMachine);
    const preparedTransfers = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    try {
      // Real daemon startup attaches the prepared data-plane after construction.
      // It shares method ids with the host-local attachment upload lifecycle.
      machine.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          errorMessage: 'No fixture Session launch' }),
        stopSession: async () => true,
        requestShutdown() {},
        preparedMachineTransfer: { request: preparedTransfers.requestPreparedTransfer },
      });
      await writeFile(sourcePath, bytes);
      expect(resolveRpc()).toBeNull();
      activeMachine = machine;
      const rpc = resolveRpc();
      if (!rpc) throw new Error('Expected daemon transfer carrier');
      const request = { sourcePath, name: 'lead.pdf', messageLocalId: 'plugin-input-v1:4m9MAtqecOTML90GoD1ICHEtIyV4-1uX2iCCcOTGufM' };
      const result = await materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: new AbortController().signal });
      expect(await readFile(join(directory, result.path))).toEqual(bytes);
      expect(result.bytes).toEqual(bytes);
      // Public prepared RPC keeps its strict envelope even while local uploads work.
      await expect(machine.invokeLocalMachineAction(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, {
        uploadId: 'not-a-prepared-transfer', index: 0, contentBase64: bytes.toString('base64'),
      })).resolves.toMatchObject({ errorCode: 'invalid_request' });
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'foreign-session', request, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'plugin_session_attachment_unavailable' });
      await expect(machine.getPeerMediationMachineRpcHandlerManager().invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'input-1', fileName: 'lead.pdf', sizeBytes: bytes.byteLength,
      })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally {
      await machine.shutdown();
      await preparedTransfers.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers exact binary bytes through the real Session upload target and refuses an unhosted Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-channel-attachment-'));
    const sourcePath = join(directory, 'provider.bin');
    const bytes = Buffer.from([0, 255, 1, 2, 0, 128]);
    const store = new TransferSessionStore({ ttlMs: 60_000 });
    const rpc = new RpcHandlerManager({ scopePrefix: 'test', encryptionMode: 'plain' });
    try {
      await writeFile(sourcePath, bytes);
      registerTransferUploadRpcHandlers(rpc, {
        workingDirectory: directory,
        store,
        attachmentUpload: { resolveSessionWorkingDirectory: async id => id === 'session-1' ? directory : null },
      });
      const request = { sourcePath, name: '../lead.bin', messageLocalId: 'input-1' };
      const result = await materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: new AbortController().signal });
      expect(result.path).toContain('.happier/uploads/messages/session-1/input-1/');
      expect(result.path.endsWith('-lead.bin')).toBe(true);
      expect(await readFile(join(directory, result.path))).toEqual(bytes);
      expect(result.bytes).toEqual(bytes);
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'remote-session', request, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'plugin_session_attachment_unavailable' });
      const cancellation = new AbortController();
      cancellation.abort();
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: cancellation.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await store.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
