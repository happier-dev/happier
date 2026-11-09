import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { configuration } from '@/configuration';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '@/transfers/policy/serverRoutedTransferPolicy';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

type Handler = (data: any) => Promise<any>;
type UploadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getUploadSession']>>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

const directTransferStores: TransferSessionStore[] = [];
const fileSystemRegistrations: Array<ReturnType<typeof registerFileSystemHandlers>> = [];

function createTrackedTransferSessionStore(deps: ConstructorParameters<typeof TransferSessionStore>[0]): TransferSessionStore {
  const store = new TransferSessionStore(deps);
  directTransferStores.push(store);
  return store;
}

afterEach(async () => {
  const registrations = fileSystemRegistrations.splice(0);
  const stores = directTransferStores.splice(0);
  await Promise.all([
    ...registrations.map(async (registration) => await registration.dispose()),
    ...stores.map(async (store) => await store.dispose()),
  ]);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function registerTrackedFileSystemHandlers(
  manager: RpcHandlerManager,
  workingDirectory: string,
): void {
  fileSystemRegistrations.push(registerFileSystemHandlers(manager, workingDirectory));
}

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

describe('file transfers (upload)', () => {
  it('denies Account automation caller-path uploads while preserving present-person uploads', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'happier-upload-raw-authority-'));
    const workspace = join(fixture, 'workspace');
    mkdirSync(workspace);
    const path = join(fixture, 'daemon-sentinel');
    const mgr = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
      // Authenticated Home/current Machine admission is the network boundary;
      // receiving RPC, target resolution, encrypted chunks and publication stay real.
      authorizeRequest: async () => ({ ok: true }),
    });
    const registration = registerFileSystemHandlers(mgr, workspace);
    const upload = async (callerAuthority: 'present_user' | 'account_automation', content: string) => {
      const request = (method: string, params: unknown) => mgr.handleRequest({
        method: `machine:${method}`, params, callerAuthority,
        machineAdmission: { actorAccountId: 'actor', custodianAccountId: 'actor', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      });
      const initialized = await request(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_file_upload_v1', path, sizeBytes: Buffer.byteLength(content), overwrite: true,
      });
      if (!initialized || typeof initialized !== 'object' || !('uploadId' in initialized)
        || typeof initialized.uploadId !== 'string' || !('recipientPublicKeyBase64' in initialized)
        || typeof initialized.recipientPublicKeyBase64 !== 'string') return { initialized };
      await expect(request(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, createEncryptedUploadChunkRequest({
        uploadId: initialized.uploadId, index: 0, payload: Buffer.from(content),
        recipientPublicKeyBase64: initialized.recipientPublicKeyBase64,
      }))).resolves.toMatchObject({ success: true });
      return { initialized, finalized: await request(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: initialized.uploadId }) };
    };
    try {
      await expect(upload('present_user', 'person-upload')).resolves.toMatchObject({
        initialized: { success: true }, finalized: { success: true },
      });
      expect(readFileSync(path, 'utf8')).toBe('person-upload');
      const result = await upload('account_automation', 'automated-raw-upload');
      expect({ result, contents: readFileSync(path, 'utf8') }).toMatchObject({
        result: { initialized: { errorCode: RPC_ERROR_CODES.FORBIDDEN } }, contents: 'person-upload',
      });
    } finally {
      await registration.dispose();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('uploads a file in chunks and creates parent directories', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerTrackedFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'hello world\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'nested/hello.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: false,
    });

    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));

    const done = await finalize({ uploadId });
    expect(done).toMatchObject({ success: true, sizeBytes: Buffer.byteLength(content) });
    expect(readFileSync(join(workspace, 'nested', 'hello.txt'), 'utf8')).toBe(content);
  });

  it('supports overwriting an existing file when overwrite=true', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    writeFileSync(join(workspace, 'file.txt'), 'old\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerTrackedFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'new\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'file.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: true,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));
    const done = await finalize({ uploadId });
    expect(done).toMatchObject({ success: true });
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe(content);
  });

  it('rejects directory collision even when overwrite=true without deleting the existing directory tree', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    mkdirSync(join(workspace, 'existingdir', 'nested'), { recursive: true });
    writeFileSync(join(workspace, 'existingdir', 'nested', 'keep.txt'), 'important\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerTrackedFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'file\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'existingdir',
      sizeBytes: Buffer.byteLength(content),
      overwrite: true,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));
    const done = await finalize({ uploadId });

    expect(done).toMatchObject({ success: false, errorCode: 'file_replace_failed' });

    // Verify directory and its contents are preserved
    expect(statSync(join(workspace, 'existingdir')).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, 'existingdir', 'nested', 'keep.txt'), 'utf8')).toBe('important\n');
  });

  it('refreshes upload session expiry on chunk progress so long uploads use idle timeout semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const store = createTrackedTransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, { workingDirectory: workspace, store });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const firstChunk = Buffer.alloc(configuration.filesTransferChunkBytes, 'a');
    const secondChunk = Buffer.from('b');
    const content = Buffer.concat([firstChunk, secondChunk]);

    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'slow.bin',
      sizeBytes: content.length,
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    vi.setSystemTime(900);
    expect(await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: firstChunk,
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }))).toMatchObject({ success: true });

    vi.setSystemTime(1500);
    expect(await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 1,
      payload: secondChunk,
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }))).toMatchObject({ success: true });

    vi.setSystemTime(2400);
    expect(await finalize({ uploadId })).toMatchObject({ success: true, sizeBytes: content.length });
  });

  it('rejects malformed base64 chunks instead of silently decoding corrupted bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerTrackedFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    if (!init || !chunk) throw new Error('expected upload handlers');

    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'broken.txt',
      sizeBytes: 3,
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(chunk({
      uploadId: initResp.uploadId,
      index: 0,
      payloadBase64: 'Zm9v*',
      encryptedDataKeyEnvelopeBase64: 'also-invalid',
    })).resolves.toEqual({
      success: false,
      error: `Invalid encrypted transfer data key for ${initResp.uploadId}`,
    });
  });

  it('keeps the upload session recoverable after finalize conflict so finalize can retry without re-uploading', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    writeFileSync(join(workspace, 'file.txt'), 'old\n', 'utf8');

    const store = createTrackedTransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'new\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'file.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));

    const firstFinalize = await finalize({ uploadId });
    expect(firstFinalize).toMatchObject({ success: false, errorCode: 'EEXIST' });
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe('old\n');
    const pending = store.getUploadSession(uploadId) as UploadSessionHandle | null;
    expect(pending).not.toBeNull();
    expect(pending?.file.fd).toBe(-1);
    expect(statSync(pending!.tempPath).isFile()).toBe(true);

    unlinkSync(join(workspace, 'file.txt'));

    const retryFinalize = await finalize({ uploadId });
    expect(retryFinalize).toMatchObject({ success: true, sizeBytes: Buffer.byteLength(content) });
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe(content);
  });

  it('rejects session-routed uploads that exceed the advertised server-routed size limit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const store = createTrackedTransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      sessionRpcTransferMaxBytes: 4,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    if (!init) throw new Error('expected upload init handler');

    await expect(
      init({
        t: 'session_file_upload_v1',
        path: 'too-large.txt',
        sizeBytes: 5,
        overwrite: false,
      }),
    ).resolves.toEqual({
      success: false,
      error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('rejects uploads that exceed the advertised server-routed size limit when registered via registerFileSystemHandlers (no bypass)', async () => {
    vi.stubEnv('HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES', '4');

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerTrackedFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    if (!init) throw new Error('expected upload init handler');

    await expect(
      init({
        t: 'session_file_upload_v1',
        path: 'too-large.txt',
        sizeBytes: 5,
        overwrite: false,
      }),
    ).resolves.toEqual({
      success: false,
      error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('stages ordered relay chunks through the exact Composer execution target without returning a filesystem path', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-composer-stage-relay-'));
    const executionTarget = { serverId: 'server-1', machineId: 'machine-1' };
    const owner = { pluginId: 'com.example.media', localId: 'composer' };
    const store = createTrackedTransferSessionStore({ ttlMs: 1_000 });
    const stageStore = createComposerMediaStageStore({
      rootDirectory: join(workspace, 'composer-media-stages'),
      executionTarget,
    });
    const mgr = createRpcHandlerManager();
    registerTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      composerMediaStage: {
        executionTarget,
        store: stageStore,
      },
    } as Parameters<typeof registerTransferUploadRpcHandlers>[1]);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const initialized = await init({
      t: 'composer_media_stage_upload_v1',
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'camera.png',
      sizeBytes: content.byteLength,
      sha256,
    });
    if (!initialized.success) throw new Error(initialized.error);
    expect(initialized).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initialized.uploadId as string;
    const recipientPublicKeyBase64 = initialized.recipientPublicKeyBase64 as string;
    await expect(chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 1,
      payload: content.subarray(8),
      recipientPublicKeyBase64,
    }))).resolves.toEqual({ success: false, error: 'Unexpected chunk index' });
    await expect(chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: content.subarray(0, 8),
      recipientPublicKeyBase64,
    }))).resolves.toEqual({ success: true });
    await expect(chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 1,
      payload: content.subarray(8),
      recipientPublicKeyBase64,
    }))).resolves.toEqual({ success: true });

    const finalized = await finalize({ uploadId });
    expect(finalized).toMatchObject({
      success: true,
      path: 'Composer media stage',
      sizeBytes: content.byteLength,
      sha256,
      result: {
        v: 1,
        executionTarget,
        owner,
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'camera.png',
        sizeBytes: content.byteLength,
        sha256,
      },
    });
    expect(JSON.stringify(finalized)).not.toContain(workspace);
  });

  it('forwards the daemon-owned Composer stage target through file-system handler registration', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-composer-stage-registration-'));
    const executionTarget = { serverId: 'server-1', machineId: 'machine-1' };
    const stageStore = createComposerMediaStageStore({
      rootDirectory: join(workspace, 'composer-media-stages'),
      executionTarget,
    });
    const mgr = createRpcHandlerManager();
    fileSystemRegistrations.push(registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      composerMediaStage: {
        executionTarget,
        store: stageStore,
      },
    } as Parameters<typeof registerFileSystemHandlers>[2]));

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    if (!init) throw new Error('expected upload init handler');

    const initialized = await init({
      t: 'composer_media_stage_upload_v1',
      executionTarget,
      owner: { pluginId: 'com.example.media', localId: 'composer' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'camera.png',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
    });
    if (!initialized.success) throw new Error(initialized.error);
    expect(initialized).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });
  });
});
