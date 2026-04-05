import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';

afterEach(() => {
  // No shared state.
});

describe('direct transfer import session manager', () => {
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

    try {
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

      await manager.close();

      expect(manager.countActiveImportSessions()).toBe(0);
      await expect(manager.writeImportTransferChunk({
        uploadId: open.response.uploadId,
        index: 0,
        contentBase64: payload.toString('base64'),
      })).resolves.toEqual({
        success: false,
        error: 'Upload session not found',
      });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
