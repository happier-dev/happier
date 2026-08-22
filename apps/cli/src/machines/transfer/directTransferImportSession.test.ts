import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import { TRANSFER_CHUNK_HARD_MAX_BYTES } from './transferChunkSizeLimit';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

let failNextUploadPromotionWithExdev = false;
let failNextUploadSourceCleanup = false;
let failDestinationBackupRestore = false;
let destinationBackupPath: string | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (failNextUploadPromotionWithExdev && from.endsWith('.upload')) {
        failNextUploadPromotionWithExdev = false;
        const error = new Error('simulated cross-device upload promotion') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      if (failDestinationBackupRestore && destinationBackupPath === from) {
        throw new Error('simulated destination backup restoration failure');
      }
      await actual.rename(from, to);
      if (to.includes('.happier-upload-backup-')) {
        destinationBackupPath = to;
      }
    }),
    rm: vi.fn(async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
      if (failNextUploadSourceCleanup && path.endsWith('.upload')) {
        failNextUploadSourceCleanup = false;
        const error = new Error('simulated staged upload cleanup failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actual.rm(path, options);
    }),
  };
});

afterEach(() => {
  failNextUploadPromotionWithExdev = false;
  failNextUploadSourceCleanup = false;
  failDestinationBackupRestore = false;
  destinationBackupPath = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('direct transfer import session manager', () => {
  it('never advertises an import chunk size larger than the encrypted-transfer hard limit', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-chunk-limit-'));
    const manager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
      chunkSizeBytes: TRANSFER_CHUNK_HARD_MAX_BYTES + 1,
    });

    try {
      const opened = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: TRANSFER_CHUNK_HARD_MAX_BYTES + 1,
        overwrite: true,
      });

      expect(opened).toMatchObject({
        success: true,
        response: {
          chunkSizeBytes: TRANSFER_CHUNK_HARD_MAX_BYTES,
        },
      });
    } finally {
      await manager.close();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('drops active import activity after a route-independent abort', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-machine-abort-'));
    const activeCounts: number[] = [];

    try {
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
        onActiveSessionCountChanged: (count) => activeCounts.push(count),
      });
      const opened = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: 4,
        overwrite: true,
      });
      if (!opened.success) {
        throw new Error(opened.error);
      }

      expect(manager.countActiveImportSessions()).toBe(1);
      await manager.abortImportTransferSession({ uploadId: opened.response.uploadId });

      expect(manager.countActiveImportSessions()).toBe(0);
      expect(activeCounts).toEqual([1, 0]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('preserves finalize recovery codes and retained session state through the import manager', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-finalize-recovery-'));
    const destinationPath = join(workingDirectory, 'payload.txt');
    const manager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
      chunkSizeBytes: 16,
    });
    const payload = Buffer.from('replacement', 'utf8');

    try {
      await writeFile(destinationPath, 'original', 'utf8');
      const opened = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: payload.length,
        overwrite: true,
      });
      if (!opened.success) {
        throw new Error(opened.error);
      }
      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.response.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64,
      });
      now = 2_000;
      await expect(manager.writeImportTransferChunk({
        uploadId: opened.response.uploadId,
        index: 0,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: true });

      failNextUploadPromotionWithExdev = true;
      failNextUploadSourceCleanup = true;
      failDestinationBackupRestore = true;

      await expect(manager.finalizeImportTransferSession({
        uploadId: opened.response.uploadId,
      })).resolves.toEqual({
        success: false,
        error: 'Failed to finalize uploaded file because destination recovery was incomplete. Recovery files were preserved; inspect the destination before retrying.',
        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
        keepSession: true,
        expiresAt: 12_000,
      });
      expect(manager.countActiveImportSessions()).toBe(1);
    } finally {
      nowSpy.mockRestore();
      await manager.close();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('uses refreshed canonical-store expiry truth and ignores stale prepared deadlines', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-idle-expiry-'));
    const tempEnv = createEnvKeyScope(['TEMP', 'TMP', 'TMPDIR']);
    const activeCounts: number[] = [];
    let manager: ReturnType<typeof createDirectTransferImportSessionManager> | null = null;

    try {
      tempEnv.patch({
        TEMP: workingDirectory,
        TMP: workingDirectory,
        TMPDIR: workingDirectory,
      });
      manager = createDirectTransferImportSessionManager({
        ttlMs: 1_000,
        onActiveSessionCountChanged: (count) => activeCounts.push(count),
      });
      const first = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'first-payload.txt',
        sizeBytes: 8,
        overwrite: true,
      });
      if (!first.success) {
        throw new Error(first.error);
      }
      nowSpy.mockReturnValue(1_200);
      const second = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'second-payload.txt',
        sizeBytes: 4,
        overwrite: true,
      });
      if (!second.success) {
        throw new Error(second.error);
      }
      nowSpy.mockReturnValue(1_500);
      const refreshedChunk = createEncryptedTransferChunkEnvelope({
        transferId: first.response.uploadId,
        sequence: 0,
        payload: Buffer.from('data', 'utf8'),
        recipientPublicKeyBase64: first.response.recipientPublicKeyBase64,
      });
      await expect(manager.writeImportTransferChunk({
        uploadId: first.response.uploadId,
        index: 0,
        payloadBase64: refreshedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: refreshedChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: true });

      expect(manager.countActiveImportSessions()).toBe(2);
      expect(activeCounts).toEqual([1, 2]);
      const importExpiryOwner = manager as typeof manager & Readonly<{
        getNextImportSessionExpiryAt: () => number | null;
      }>;
      expect(importExpiryOwner.getNextImportSessionExpiryAt()).toBe(second.response.expiresAt);
      const transferRoots = await readdir(join(workingDirectory, 'happier', 'file-transfers'));
      expect(transferRoots).toHaveLength(1);
      const transferTempRoot = join(workingDirectory, 'happier', 'file-transfers', transferRoots[0] ?? '');
      const firstStagedUploadPath = join(transferTempRoot, `${first.response.uploadId}.upload`);
      const secondStagedUploadPath = join(transferTempRoot, `${second.response.uploadId}.upload`);

      manager.cleanupExpiredImportSessions(first.response.expiresAt);
      expect(manager.countActiveImportSessions()).toBe(2);
      expect(activeCounts.at(-1)).toBe(2);
      await expect(access(firstStagedUploadPath)).resolves.toBeUndefined();
      await expect(access(secondStagedUploadPath)).resolves.toBeUndefined();

      nowSpy.mockReturnValue(second.response.expiresAt);
      manager.cleanupExpiredImportSessions(second.response.expiresAt);
      expect(manager.countActiveImportSessions()).toBe(1);
      expect(activeCounts.at(-1)).toBe(1);
      expect(importExpiryOwner.getNextImportSessionExpiryAt()).toBe(first.response.expiresAt + 500);
      await expect(manager.writeImportTransferChunk({
        uploadId: second.response.uploadId,
        index: 0,
        contentBase64: Buffer.from('data', 'utf8').toString('base64'),
      })).resolves.toEqual({
        success: false,
        error: 'Upload session not found',
      });
      await vi.waitFor(async () => {
        await expectPathMissing(secondStagedUploadPath);
      });
      await expect(access(firstStagedUploadPath)).resolves.toBeUndefined();

      nowSpy.mockReturnValue(first.response.expiresAt + 500);
      manager.cleanupExpiredImportSessions(first.response.expiresAt + 500);
      expect(manager.countActiveImportSessions()).toBe(0);
      expect(activeCounts.at(-1)).toBe(0);
      expect(importExpiryOwner.getNextImportSessionExpiryAt()).toBeNull();
      await vi.waitFor(async () => {
        await expectPathMissing(firstStagedUploadPath);
      });
    } finally {
      await manager?.close();
      tempEnv.restore();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('applies the manager filesystem access policy to workspace file uploads', async () => {
    const allowedRoot = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-allowed-'));
    const deniedRoot = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-denied-'));

    try {
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
        accessPolicy: { kind: 'restrictedRoots', roots: [allowedRoot] },
      });

      const open = await manager.openTrustedImportSession({
        workingDirectory: deniedRoot,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: 5,
        overwrite: true,
      });

      expect(open).toEqual({
        success: false,
        error: expect.stringContaining('Access denied'),
      });
    } finally {
      await rm(allowedRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(deniedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('resolves workspace-backed attachment uploads through the attachment target semantics instead of writing to the raw request path', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-attachment-'));
    const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

    try {
      await mkdir(join(workingDirectory, '.git'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(workingDirectory, '.gitignore'), '# existing\n', 'utf8');

      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      } as unknown as Parameters<typeof createDirectTransferImportSessionManager>[0]);

      const payload = Buffer.from('hello world', 'utf8');
      const open = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_attachment_upload_v1',
        sizeBytes: payload.length,
        messageLocalId: 'message-1',
        fileName: 'hello.txt',
        uploadLocation: 'workspace',
        workspaceRootPath: workingDirectory,
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'gitignore',
        vcsIgnoreWritesEnabled: true,
      } as unknown as Parameters<typeof manager.openTrustedImportSession>[0]);

      expect(open).toEqual({
        success: true,
        response: expect.objectContaining({
          destDisplayPath: expect.stringMatching(/^\.happier\/uploads\/messages\/message-1\/[0-9a-f]{8}-hello\.txt$/),
          expectedSizeBytes: payload.length,
          chunkSizeBytes: expect.any(Number),
          recipientPublicKeyBase64: expect.any(String),
          expiresAt: expect.any(Number),
          uploadId: expect.any(String),
        }),
      });

      if (!open.success) {
        throw new Error(open.error);
      }

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: open.response.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: open.response.recipientPublicKeyBase64,
      });

      expect(await manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      })).toEqual({ success: true });

      const finalized = await manager.finalizeImportTransferSession({ uploadId: open.response.uploadId });
      expect(finalized).toMatchObject({
        success: true,
        sha256: expect.any(String),
      });
      if (!finalized.success) {
        throw new Error(finalized.error);
      }

      const resolvedFinalPath = resolve(
        workingDirectory,
        '.happier',
        'uploads',
        'messages',
        'message-1',
      );
      const finalizedPath = finalized.finalized.path;
      expect(finalizedPath).toMatch(/^\.happier\/uploads\/messages\/message-1\/[0-9a-f]{8}-hello\.txt$/);
      await expect(readFile(resolve(workingDirectory, finalizedPath), 'utf8')).resolves.toBe('hello world');
      await expect(readFile(join(workingDirectory, '.gitignore'), 'utf8')).resolves.toContain('/.happier/uploads/');
      expect(pathAllowanceRegistry.getAdditionalAllowedReadDirs()).toEqual([]);
      expect(pathAllowanceRegistry.getAdditionalAllowedWriteDirs()).toEqual([]);
      expect(resolvedFinalPath).toBe(join(workingDirectory, '.happier', 'uploads', 'messages', 'message-1'));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('supports os_temp attachment uploads through the direct import session manager', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-os-temp-'));

    try {
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
      });

      const payload = Buffer.from('hey', 'utf8');
      const open = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_attachment_upload_v1',
        sizeBytes: payload.length,
        messageLocalId: 'message-2',
        fileName: 'note.txt',
        uploadLocation: 'os_temp',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      });

      expect(open).toEqual({
        success: true,
        response: expect.objectContaining({
          destDisplayPath: expect.stringMatching(/\/messages\/message-2\/[0-9a-f]{8}-note\.txt$/),
          expectedSizeBytes: payload.length,
          chunkSizeBytes: expect.any(Number),
          recipientPublicKeyBase64: expect.any(String),
          expiresAt: expect.any(Number),
          uploadId: expect.any(String),
        }),
      });

      if (!open.success) {
        throw new Error(open.error);
      }

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: open.response.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: open.response.recipientPublicKeyBase64,
      });

      expect(await manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      })).toEqual({ success: true });

      const finalized = await manager.finalizeImportTransferSession({ uploadId: open.response.uploadId });
      expect(finalized).toMatchObject({
        success: true,
        sha256: expect.any(String),
      });
      if (!finalized.success) {
        throw new Error(finalized.error);
      }

      expect(finalized.finalized.path).toMatch(/\/messages\/message-2\/[0-9a-f]{8}-note\.txt$/);
      await expect(readFile(finalized.finalized.path, 'utf8')).resolves.toBe('hey');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('stages Composer media via direct import only for its authorized target and owner', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-composer-media-'));
    const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
    const owner = { pluginId: 'com.example.media', localId: 'composer' };
    const stageStore = createComposerMediaStageStore({
      rootDirectory: join(workingDirectory, 'composer-media-stages'),
      executionTarget,
    });
    const manager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
      composerMediaStage: {
        executionTarget,
        store: stageStore,
      },
    } as Parameters<typeof createDirectTransferImportSessionManager>[0]);
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const request = {
      workingDirectory,
      t: 'composer_media_stage_upload_v1',
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'camera.png',
      sizeBytes: content.byteLength,
      sha256,
    } as const;

    try {
      const hijackAuthorization = manager.issueImportOpenAuthorizationToken(
        request as unknown as Parameters<typeof manager.issueImportOpenAuthorizationToken>[0],
      );
      await expect(manager.openImportSession({
        ...request,
        owner: { pluginId: 'com.example.media', localId: 'other-composer' },
        authorizationToken: hijackAuthorization.authorizationToken,
      } as unknown as Parameters<typeof manager.openImportSession>[0])).resolves.toEqual({
        success: false,
        error: 'Import session open authorization required',
      });

      const authorization = manager.issueImportOpenAuthorizationToken(
        request as unknown as Parameters<typeof manager.issueImportOpenAuthorizationToken>[0],
      );
      const opened = await manager.openImportSession({
        ...request,
        authorizationToken: authorization.authorizationToken,
      } as unknown as Parameters<typeof manager.openImportSession>[0]);
      if (!opened.success) throw new Error(opened.error);
      expect(opened).toMatchObject({
        success: true,
        response: {
          destDisplayPath: 'Composer media stage',
          recipientPublicKeyBase64: expect.any(String),
        },
      });
      const outOfOrderChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.response.uploadId,
        sequence: 1,
        payload: content.subarray(8),
        recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64,
      });
      await expect(manager.writeImportTransferChunk({
        uploadId: opened.response.uploadId,
        index: 1,
        payloadBase64: outOfOrderChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: outOfOrderChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: false, error: 'Unexpected chunk index' });

      const firstChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.response.uploadId,
        sequence: 0,
        payload: content.subarray(0, 8),
        recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64,
      });
      const secondChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.response.uploadId,
        sequence: 1,
        payload: content.subarray(8),
        recipientPublicKeyBase64: opened.response.recipientPublicKeyBase64,
      });
      await expect(manager.writeImportTransferChunk({
        uploadId: opened.response.uploadId,
        index: 0,
        payloadBase64: firstChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: firstChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: true });
      await expect(manager.writeImportTransferChunk({
        uploadId: opened.response.uploadId,
        index: 1,
        payloadBase64: secondChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: secondChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: true });

      const finalized = await manager.finalizeImportTransferSession({ uploadId: opened.response.uploadId });
      expect(finalized).toMatchObject({
        success: true,
        sha256,
        finalized: {
          success: true,
          path: 'Composer media stage',
          result: {
            v: 1,
            executionTarget,
            owner,
            name: 'camera.png',
            sha256,
          },
        },
      });
      expect(JSON.stringify(finalized)).not.toContain(workingDirectory);
    } finally {
      await manager.close();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('supports prompt asset uploads through the direct import session manager', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-prompt-assets-'));

    try {
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
        promptAssetUpload: {
          adapterRegistry: createPromptAssetAdapterRegistry({
            homedir: () => homeDir,
          }),
        },
      } as unknown as Parameters<typeof createDirectTransferImportSessionManager>[0]);

      const payload = Buffer.from(JSON.stringify({
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: null,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: {
          v: 1,
          entries: [
            { path: 'SKILL.md', contentBase64: Buffer.from('# Writer\n', 'utf8').toString('base64'), contentKind: 'utf8' },
          ],
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        previewOnly: false,
        expectedDigest: null,
      }), 'utf8');

      const open = await manager.openTrustedImportSession({
        workingDirectory: homeDir,
        t: 'prompt_asset_upload_v1',
        sizeBytes: payload.length,
      } as unknown as Parameters<typeof manager.openTrustedImportSession>[0]);

      expect(open).toEqual({
        success: true,
        response: expect.objectContaining({
          destDisplayPath: 'prompt-asset-upload.json',
          expectedSizeBytes: payload.length,
          chunkSizeBytes: expect.any(Number),
          recipientPublicKeyBase64: expect.any(String),
          expiresAt: expect.any(Number),
          uploadId: expect.any(String),
        }),
      });

      if (!open.success) {
        throw new Error(open.error);
      }

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: open.response.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: open.response.recipientPublicKeyBase64,
      });

      expect(await manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      })).toEqual({ success: true });

      const finalized = await manager.finalizeImportTransferSession({ uploadId: open.response.uploadId });
      expect(finalized).toMatchObject({
        success: true,
        finalized: {
          success: true,
          result: expect.objectContaining({
            ok: true,
            externalRef: { skillName: 'writer' },
          }),
        },
      });
      if (!finalized.success) {
        throw new Error(finalized.error);
      }

      await expect(readFile(join(homeDir, '.agents', 'skills', 'writer', 'SKILL.md'), 'utf8')).resolves.toBe('# Writer\n');
    } finally {
      await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps finalize successful even if transfer activity callbacks fail', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-callback-failure-'));

    try {
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
        onActiveSessionCountChanged: () => {
          throw new Error('active-session observer failed');
        },
        onActivity: () => {
          throw new Error('activity observer failed');
        },
      });

      const payload = Buffer.from('callback-safe', 'utf8');
      const open = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: payload.length,
        overwrite: true,
      });

      expect(open).toEqual({
        success: true,
        response: expect.objectContaining({
          uploadId: expect.any(String),
          recipientPublicKeyBase64: expect.any(String),
        }),
      });

      if (!open.success) {
        throw new Error(open.error);
      }

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: open.response.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: open.response.recipientPublicKeyBase64,
      });

      expect(await manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      })).toEqual({ success: true });

      const finalized = await manager.finalizeImportTransferSession({ uploadId: open.response.uploadId });
      expect(finalized).toMatchObject({
        success: true,
        sha256: expect.any(String),
      });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('cleans up active import sessions and invalidates their upload ids when the manager closes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-close-'));
    const tempEnv = createEnvKeyScope(['TEMP', 'TMP', 'TMPDIR']);

    try {
      tempEnv.patch({
        TEMP: workingDirectory,
        TMP: workingDirectory,
        TMPDIR: workingDirectory,
      });
      const manager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
      });

      const payload = Buffer.from('close-cleanup', 'utf8');
      const open = await manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'payload.txt',
        sizeBytes: payload.length,
        overwrite: true,
      });

      expect(open).toEqual({
        success: true,
        response: expect.objectContaining({
          uploadId: expect.any(String),
          recipientPublicKeyBase64: expect.any(String),
        }),
      });

      if (!open.success) {
        throw new Error(open.error);
      }

      expect(manager.countActiveImportSessions()).toBe(1);
      const transferRoots = await readdir(join(workingDirectory, 'happier', 'file-transfers'));
      expect(transferRoots).toHaveLength(1);
      const transferTempRoot = join(workingDirectory, 'happier', 'file-transfers', transferRoots[0] ?? '');
      await expect(access(transferTempRoot)).resolves.toBeUndefined();

      await manager.close();
      await manager.close();

      expect(manager.countActiveImportSessions()).toBe(0);
      await expectPathMissing(transferTempRoot);
      await expect(manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        contentBase64: payload.toString('base64'),
      })).resolves.toEqual({
        success: false,
        error: 'Upload session not found',
      });
      await expect(manager.openTrustedImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'after-close.txt',
        sizeBytes: payload.length,
        overwrite: true,
      })).rejects.toThrow('Transfer session store is disposed');
    } finally {
      tempEnv.restore();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
