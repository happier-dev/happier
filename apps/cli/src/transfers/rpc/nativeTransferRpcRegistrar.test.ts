import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';

import type { RpcHandler } from '@/api/rpc/types';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createFilesystemOwnerRpcContext } from '@/rpc/handlers/fileSystem.testkit';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem/registerFileSystemHandlers';
import { runFilesystemEffectInternal } from '@/rpc/handlers/fileSystem/filesystemEffectInternal';
import { createFilesystemEffectChannel, createFilesystemEffectRpcOwner, initializeFilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';

describe('retained native filesystem RPC transfer', () => {
  it('cancels a launched initializer before promotion and settles its physical process without retaining a record', async () => {
    await withTempDir('happier-native-rpc-cancel-', async root => {
      const receipt = new AbortController();
      let signalLaunch!: () => void;
      const launched = new Promise<void>(resolve => { signalLaunch = resolve; });
      let releaseInitialization!: () => void;
      const initialization = new Promise<void>(resolve => { releaseInitialization = resolve; });
      let disposals = 0;
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      const registration = registerFileSystemHandlers({ registerHandler(method, handler) {
        handlers.set(method, handler as RpcHandler<unknown, unknown>);
      } }, root, { accessPolicy: { kind: 'osUser' }, prepareNativeTransfer: async original => {
        const operation = new AbortController();
        const cancel = () => { operation.abort(original?.signal.reason); };
        original?.signal.addEventListener('abort', cancel, { once: true });
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const running = runFilesystemEffectInternal(stdin, stdout, operation.signal).catch(error => {
          if (!(error instanceof Error && error.name === 'AbortError')) throw error;
        });
        const channel = createFilesystemEffectChannel({ input: stdin, output: stdout, signal: operation.signal,
          dispose: async () => { original?.signal.removeEventListener('abort', cancel); await running; disposals++; } });
        signalLaunch();
        try {
          // Paused process-start boundary: cancellation must win before the
          // initial native request can be promoted into retained custody.
          await initialization;
          original?.signal.throwIfAborted();
          await initializeFilesystemEffectChannel(channel, { workingDirectory: root, accessPolicy: { kind: 'osUser' } });
          return createFilesystemEffectRpcOwner(channel, async () => {}, () => {
            original?.signal.throwIfAborted(); original?.signal.removeEventListener('abort', cancel);
          });
        } catch (error) { await channel.dispose(); throw error; }
      } });
      try {
        const handler = handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
        if (!handler) throw new Error('Missing transfer initializer');
        const pending = handler({ t: 'session_file_upload_v1', path: 'cancelled.dat', sizeBytes: 4, overwrite: false },
          { ...createFilesystemOwnerRpcContext(), signal: receipt.signal });
        await launched;
        receipt.abort();
        releaseInitialization();
        await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
        expect(registration.transferSessionStore.countUploadSessions()).toBe(0);
        expect(disposals).toBe(1);
        await expect(readFile(join(root, 'cancelled.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { releaseInitialization(); await registration.dispose(); }
    });
  });

  it('keeps one process in the existing directional record through encrypted phases, checks original custody, and closes on finalization or expiry', async () => {
    await withTempDir('happier-native-rpc-transfer-', async root => {
      const member = join(root, 'member');
      await mkdir(member);
      let receiptController = new AbortController();
      let context = { ...createFilesystemOwnerRpcContext(), signal: receiptController.signal };
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      let preparations = 0;
      let disposals = 0;
      const registration = registerFileSystemHandlers({ registerHandler(method, handler) {
        handlers.set(method, handler as RpcHandler<unknown, unknown>);
      } }, root, { accessPolicy: { kind: 'osUser' }, prepareNativeTransfer: async original => {
        original?.signal.throwIfAborted();
        preparations++;
        const operationController = new AbortController();
        const cancelInitialization = () => { operationController.abort(original?.signal.reason); };
        original?.signal.addEventListener('abort', cancelInitialization, { once: true });
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const running = runFilesystemEffectInternal(stdin, stdout, operationController.signal);
        const channel = createFilesystemEffectChannel({ input: stdin, output: stdout, signal: operationController.signal,
          dispose: async () => { original?.signal.removeEventListener('abort', cancelInitialization); await running; disposals++; } });
        await initializeFilesystemEffectChannel(channel, { workingDirectory: member,
          accessPolicy: { kind: 'restrictedRoots', roots: [member] } });
        return createFilesystemEffectRpcOwner(channel, async incoming => {
          // The host's verified invocation check is a process-boundary input.
          // This test proves its original result is retained, not UID selection.
          const admission: unknown = incoming && typeof incoming === 'object' ? Reflect.get(incoming, 'machineAdmission') : undefined;
          if (!admission || typeof admission !== 'object'
            || Reflect.get(admission, 'actorAccountId') !== original?.machineAdmission?.actorAccountId) {
            throw Object.assign(new Error('Different admitted invocation'), { code: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
          }
        }, () => { original?.signal.throwIfAborted(); original?.signal.removeEventListener('abort', cancelInitialization); });
      } });
      const invoke = async (method: string, input: unknown, selectedContext = context) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`Missing transfer method ${method}`);
        return await handler(input, selectedContext);
      };
      try {
        const bytes = Buffer.from([0, 255, 128, 1]);
        const uploaded = z.object({ success: z.literal(true), uploadId: z.string(), recipientPublicKeyBase64: z.string() }).parse(
          await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { t: 'session_file_upload_v1', path: 'owned.dat', sizeBytes: bytes.length, overwrite: false }));
        expect(registration.transferSessionStore.countUploadSessions()).toBe(1);
        receiptController.abort();
        context = { ...context, signal: new AbortController().signal };
        const encrypted = createEncryptedTransferChunkEnvelope({ transferId: uploaded.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: uploaded.recipientPublicKeyBase64 });
        const chunk = { uploadId: uploaded.uploadId, index: 0, payloadBase64: encrypted.payloadBase64,
          encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 };
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk, { ...context,
          machineAdmission: context.machineAdmission ? { ...context.machineAdmission, actorAccountId: 'other-requester' } : undefined }))
          .resolves.toMatchObject({ success: false, errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk)).resolves.toEqual({ success: true });
        expect(preparations).toBe(1);
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: uploaded.uploadId })).resolves.toMatchObject({ success: true });
        expect(await readFile(join(member, 'owned.dat'))).toEqual(bytes);
        expect(registration.transferSessionStore.countUploadSessions()).toBe(0);
        expect(disposals).toBe(1);

        receiptController = new AbortController();
        context = { ...createFilesystemOwnerRpcContext(), signal: receiptController.signal };
        const recipient = createTransferRecipientKeyPair();
        const download = z.object({ success: z.literal(true), downloadId: z.string() }).parse(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
          { t: 'session_file_download_v1', path: 'owned.dat', recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }));
        const received = z.object({ success: z.literal(true), payloadBase64: z.string(), encryptedDataKeyEnvelopeBase64: z.string(), isLast: z.literal(true) })
          .parse(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId: download.downloadId, index: 0 }));
        expect(decryptEncryptedTransferChunkEnvelope({ transferId: download.downloadId, sequence: 0,
          payloadBase64: received.payloadBase64, encryptedDataKeyEnvelopeBase64: received.encryptedDataKeyEnvelopeBase64,
          recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
        expect(preparations).toBe(2);
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId: download.downloadId })).resolves.toEqual({ success: true });
        expect(disposals).toBe(2);

        const incomplete = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
          { t: 'session_file_upload_v1', path: 'incomplete.dat', sizeBytes: 4, overwrite: false });
        expect(incomplete).toMatchObject({ success: true });
        await registration.transferSessionStore.cleanupExpired(Number.MAX_SAFE_INTEGER);
        expect(disposals).toBe(3);
        expect(registration.transferSessionStore.countUploadSessions()).toBe(0);
        await expect(readFile(join(member, 'incomplete.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
        receiptController.abort();
        context = { ...context, signal: receiptController.signal };
        await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
          { t: 'session_file_upload_v1', path: 'cancelled.dat', sizeBytes: 4, overwrite: false }))
          .resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
        expect(preparations).toBe(3);
      } finally { await registration.dispose(); }
    });
  });
});
