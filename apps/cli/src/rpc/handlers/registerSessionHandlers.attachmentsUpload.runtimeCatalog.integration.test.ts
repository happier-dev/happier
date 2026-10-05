import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('registerSessionHandlers attachments uploads', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attachments-'));
  });

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('does not register bulk transfer attachment uploads in session scope', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, workingDirectory);

    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT)).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.finalize'].join(''))).toBe(false);
  });

  it('binds attachment uploads to the actual session directory and previews only finalized handles', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    const registration = registerSessionHandlers(mgr, workingDirectory, { sessionId: 'session-a' });
    const invoke = async (method: string, request: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Missing attachment handler ${method}`);
      return await handler(request);
    };
    try {
      for (const method of [RPC_METHODS.READ_FILE, RPC_METHODS.WRITE_FILE, RPC_METHODS.CREATE_DIRECTORY, RPC_METHODS.LIST_DIRECTORY, RPC_METHODS.GET_DIRECTORY_TREE]) {
        expect(handlers.has(method)).toBe(false);
      }
      for (const t of ['session_file_upload_v1', 'prompt_asset_upload_v1', 'composer_media_stage_upload_v1']) {
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
          t, path: 'outside.txt', sizeBytes: 0,
        })).toMatchObject({ success: false });
      }
      const bytes = Buffer.from('notes');
      const init = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-a', workingDirectory: '/outside', workspaceRootPath: '/outside',
        messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: bytes.length, uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
      });
      expect(init).toMatchObject({ success: true });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-b',
        messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: 0,
      })).toMatchObject({ success: false });
      const { createEncryptedTransferChunkEnvelope } = await import('@happier-dev/transfers/node');
      const chunk = createEncryptedTransferChunkEnvelope({
        transferId: init.uploadId, sequence: 0, payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64,
      });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0, ...chunk })).toMatchObject({ success: true });
      const finalized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
      expect(finalized).toMatchObject({ success: true, attachmentHandle: { v: 1, sessionId: 'session-a', id: expect.any(String) } });
      const destination = isAbsolute(finalized.path) ? finalized.path : join(workingDirectory, finalized.path);
      expect(destination.startsWith(join(workingDirectory, '.happier', 'attachments'))).toBe(true);
      expect(await readFile(destination)).toEqual(bytes);
      const { createTransferRecipientKeyPair } = await import('@happier-dev/transfers/node');
      const recipient = createTransferRecipientKeyPair();
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_file_download_v1', path: finalized.path, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: { ...finalized.attachmentHandle, sessionId: 'session-b' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: { ...finalized.attachmentHandle, id: 'unissued-id' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: { ...finalized.attachmentHandle, id: '../../outside.txt' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: finalized.attachmentHandle, path: '/outside/secret.txt',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      const otherHandlers = new Map<string, RpcHandler>();
      const otherRegistration = registerSessionHandlers({ registerHandler(method, handler) { otherHandlers.set(method, handler); } },
        workingDirectory, { sessionId: 'session-b' });
      try {
        const otherPreview = otherHandlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
        if (!otherPreview) throw new Error('Missing other Session preview handler');
        expect(await otherPreview({
          t: 'session_attachment_download_v1', attachmentHandle: { ...finalized.attachmentHandle, sessionId: 'session-b' },
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        })).toMatchObject({ success: false });
      } finally { await otherRegistration.dispose(); }
      const preview = await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: finalized.attachmentHandle,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(preview).toMatchObject({ success: true, sizeBytes: bytes.length, name: 'notes.txt' });
      await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT, { downloadId: preview.downloadId });
      await registration.dispose();
      expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_attachment_download_v1', attachmentHandle: finalized.attachmentHandle,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false });
      expect(await readFile(destination)).toEqual(bytes);
    } finally {
      await registration?.dispose();
    }
  });
});
