import { describe, expect, it } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { stat } from 'fs/promises';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { registerSessionTransferRpcHandlers } from '@/transfers/rpc/registerSessionTransferRpcHandlers';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createEncryptedUploadChunkRequest(input: Readonly<{
  uploadId: string;
  index: number;
  payload: Buffer;
  recipientPublicKeyBase64: string;
}>) {
  const encryptedChunk = createEncryptedTransferChunkEnvelope({
    transferId: input.uploadId,
    sequence: input.index,
    payload: input.payload,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
  });

  return {
    uploadId: input.uploadId,
    index: input.index,
    payloadBase64: encryptedChunk.payloadBase64,
    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
  };
}

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('attachments upload (chunked)', () => {
  it('fails closed when messageLocalId contains path traversal segments', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-traversal-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      if (!init) throw new Error('expected attachments upload handlers to be registered');

      const initRes = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: '../../escape',
        fileName: 'hello.txt',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      });

      expect(initRes).toEqual({ success: false, error: 'Invalid messageLocalId' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not create a .git directory when configuring git_info_exclude in a non-git folder', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-nogit-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      if (!init) throw new Error('expected attachments upload handlers to be registered');

      const initRes = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-1',
        fileName: 'hello.txt',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(initRes).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      await expect(stat(join(workingDirectory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes a local-only ignore rule to .git/info/exclude when requested', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-git-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'info', 'exclude'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      if (!init) throw new Error('expected attachments upload handlers to be registered');

      const initRes = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-1',
        fileName: 'hello.txt',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(initRes).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      const excludeContents = await readFile(join(workingDirectory, '.git', 'info', 'exclude'), 'utf8');
      expect(excludeContents).toContain('# existing');
      expect(excludeContents).toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes an ignore rule to .gitignore when requested', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-gitignore-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(workingDirectory, '.gitignore'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      if (!init) throw new Error('expected attachments upload handlers to be registered');

      const initRes = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-1',
        fileName: 'hello.txt',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'gitignore',
        vcsIgnoreWritesEnabled: true,
      });
      expect(initRes).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      const ignoreContents = await readFile(join(workingDirectory, '.gitignore'), 'utf8');
      expect(ignoreContents).toContain('# existing');
      expect(ignoreContents).toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('registers dedicated attachment upload handlers', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-files-upload-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      expect(mgr.handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT)).toBe(true);
      expect(mgr.handlers.has(['daemon.sessionAttachments.', 'upload.init'].join(''))).toBe(false);

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
      const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
      if (!init || !chunk || !finalize) {
        throw new Error('expected attachment upload handlers to be registered');
      }

      const initResult: any = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-1',
        fileName: 'hello.txt',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      });
      expect(initResult).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      expect(await chunk(createEncryptedUploadChunkRequest({
        uploadId: initResult.uploadId,
        index: 0,
        payload: Buffer.from('hello world', 'utf8'),
        recipientPublicKeyBase64: initResult.recipientPublicKeyBase64,
      }))).toEqual({ success: true });

      const finalizeResult: any = await finalize({ uploadId: initResult.uploadId });
      expect(finalizeResult).toMatchObject({
        success: true,
        path: expect.stringMatching(/^\.happier\/uploads\/messages\/message-1\/[0-9a-f]{8}-hello\.txt$/),
        sizeBytes: 11,
      });
      await expect(readFile(resolve(workingDirectory, finalizeResult.path), 'utf8')).resolves.toBe('hello world');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('supports os_temp attachment uploads and subsequent file download through the dedicated transfer handlers', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-os-temp-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
      const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
      const downloadInit = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
      const downloadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK);
      const downloadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE);
      if (!init || !chunk || !finalize || !downloadInit || !downloadChunk || !downloadFinalize) {
        throw new Error('expected dedicated attachment upload and file download handlers to be registered');
      }

      const initResult: any = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-2',
        fileName: 'note.txt',
        sizeBytes: 3,
        uploadLocation: 'os_temp',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(initResult).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      const downloadRecipientKeyPair = createTransferRecipientKeyPair();

      expect(await chunk(createEncryptedUploadChunkRequest({
        uploadId: initResult.uploadId,
        index: 0,
        payload: Buffer.from('hey', 'utf8'),
        recipientPublicKeyBase64: initResult.recipientPublicKeyBase64,
      }))).toEqual({ success: true });

      const finalizeResult: any = await finalize({ uploadId: initResult.uploadId });
      expect(finalizeResult).toMatchObject({
        success: true,
        path: expect.stringMatching(/\/messages\/message-2\/[0-9a-f]{8}-note\.txt$/),
        sizeBytes: 3,
      });

      const downloadInitResult: any = await downloadInit({
        t: 'session_file_download_v1',
        path: finalizeResult.path,
        recipientPublicKeyBase64: downloadRecipientKeyPair.recipientPublicKeyBase64,
      });
      expect(downloadInitResult).toMatchObject({ success: true });

      const downloadChunkResult: any = await downloadChunk({
        downloadId: downloadInitResult.downloadId,
        index: 0,
      });
      expect(downloadChunkResult).toMatchObject({ success: true, isLast: true });
      expect(
        decryptEncryptedTransferChunkEnvelope({
          transferId: downloadInitResult.downloadId,
          sequence: 0,
          payloadBase64: String(downloadChunkResult.payloadBase64 ?? ''),
          encryptedDataKeyEnvelopeBase64: String(downloadChunkResult.encryptedDataKeyEnvelopeBase64 ?? ''),
          recipientSecretKeySeed: downloadRecipientKeyPair.recipientSecretKeySeed,
        }).toString('utf8'),
      ).toBe('hey');
      await expect(downloadFinalize({ downloadId: downloadInitResult.downloadId })).resolves.toEqual({ success: true });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('fails closed before decrypt when an encrypted upload chunk exceeds the configured chunk size', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-chunk-too-large-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerSessionTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
      if (!init || !chunk) {
        throw new Error('expected attachment upload handlers to be registered');
      }

      const initResult: any = await init({
        t: 'session_attachment_upload_v1',
        messageLocalId: 'message-3',
        fileName: 'big.bin',
        sizeBytes: 11,
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      });
      expect(initResult).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

      const decodedBytesDefinitelyTooLarge = configuration.filesTransferChunkBytes + 1000;
      const encodedChars = Math.ceil(decodedBytesDefinitelyTooLarge / 3) * 4;
      const oversizedPayloadBase64 = 'A'.repeat(encodedChars);

      await expect(chunk({
        uploadId: initResult.uploadId,
        index: 0,
        payloadBase64: oversizedPayloadBase64,
        encryptedDataKeyEnvelopeBase64: 'AAAA',
      })).resolves.toEqual({ success: false, error: 'Chunk exceeds configured chunk size' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });
});
