import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { createDirectPeerTransferApp } from './directPeerTransport';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import type { DirectTransferImportOpenRequest, DirectTransferImportSessionManager } from './directTransferImportSession';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('direct transfer import endpoints', () => {
  it('responds to browser preflight requests for import routes with loopback-safe CORS headers', async () => {
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
    });

    try {
      await app.ready();

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          origin: 'https://app.happier.dev',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://app.happier.dev');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('content-type');
      expect(response.headers.vary).toContain('Origin');
    } finally {
      await app.close();
    }
  });

  it('rejects opening an import session without a scoped bearer token', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-unauthorized-'));

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'payload.bin',
          sizeBytes: 4,
          overwrite: true,
        },
      });

      expect(open.statusCode).toBe(401);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('forwards a scoped bearer token into the import session manager when opening a session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-scoped-'));
    const destinationPath = join(tempDir, 'payload.bin');

    const importSessionManager = {
      issueImportOpenAuthorizationToken: () => ({
        authorizationToken: 'scoped-import-open-token',
        expiresAt: 1_000,
      }),
      openTrustedImportSession: async () => ({
        success: true as const,
        response: {
          uploadId: 'trusted-upload-id',
          destDisplayPath: 'payload.bin',
          expectedSizeBytes: 4,
          chunkSizeBytes: 8,
          recipientPublicKeyBase64: 'recipient-public-key',
          expiresAt: 1_000,
        },
      }),
      openImportSession: async (input: DirectTransferImportOpenRequest & Readonly<{ authorizationToken?: string }>) => {
        expect(input.authorizationToken).toBe('scoped-import-open-token');
        return {
          success: true as const,
          response: {
            uploadId: 'scoped-upload-id',
            destDisplayPath: 'payload.bin',
            expectedSizeBytes: 4,
            chunkSizeBytes: 8,
            recipientPublicKeyBase64: 'recipient-public-key',
            expiresAt: 1_000,
          },
        };
      },
      writeImportTransferChunk: async () => ({ success: true as const }),
      finalizeImportTransferSession: async () => ({
        success: true as const,
        finalized: {
          success: true as const,
          path: destinationPath,
          sizeBytes: 4,
        },
        sha256: 'sha256:test',
      }),
      abortImportTransferSession: async () => {},
      cleanupExpiredImportSessions: () => {},
      getNextImportSessionExpiryAt: () => null,
      countActiveImportSessions: () => 0,
      close: async () => {},
    } satisfies DirectTransferImportSessionManager;

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          origin: 'https://app.happier.dev',
          authorization: 'Bearer scoped-import-open-token',
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'payload.bin',
          sizeBytes: 4,
          overwrite: true,
        },
      });

      expect(open.statusCode).toBe(200);
      expect(open.headers['access-control-allow-origin']).toBe('https://app.happier.dev');
      expect(open.headers.vary).toContain('Origin');
      expect(open.json()).toMatchObject({
        uploadId: 'scoped-upload-id',
        destDisplayPath: 'payload.bin',
      });
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('accepts a target- and owner-bound Composer stage open request through the direct HTTP route', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-composer-open-'));
    const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
    const request = {
      t: 'composer_media_stage_upload_v1',
      workingDirectory: '/',
      executionTarget,
      owner: { pluginId: 'com.example.media', localId: 'composer' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'camera.png',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
    } as const;
    const importSessionManager = createDirectTransferImportSessionManager({
      composerMediaStage: {
        executionTarget,
        store: createComposerMediaStageStore({
          rootDirectory: join(tempDir, 'composer-media-stages'),
          executionTarget,
        }),
      },
    } as Parameters<typeof createDirectTransferImportSessionManager>[0]);
    const authorization = importSessionManager.issueImportOpenAuthorizationToken(
      request as unknown as DirectTransferImportOpenRequest,
    );
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();
      const opened = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: { authorization: `Bearer ${authorization.authorizationToken}` },
        payload: request,
      });

      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({
        destDisplayPath: 'Composer media stage',
        expectedSizeBytes: 12,
        uploadId: expect.any(String),
      });
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects reusing an import-open token for a different request scope', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-scope-mismatch-'));
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
    });
    const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
      t: 'session_file_upload_v1',
      workingDirectory: tempDir,
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'other-payload.bin',
          sizeBytes: 4,
          overwrite: true,
        },
      });

      expect(open.statusCode).toBe(401);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('opens an import session, accepts encrypted chunks, and finalizes into the requested file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-'));
    const destinationPath = join(tempDir, 'payload.bin');
    const payload = Buffer.from('direct-import-payload', 'utf8');
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
    });
    const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
      t: 'session_file_upload_v1',
      workingDirectory: tempDir,
      path: 'payload.bin',
      sizeBytes: payload.length,
      overwrite: true,
    });

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'payload.bin',
          sizeBytes: payload.length,
          overwrite: true,
        },
      });

      expect(open.statusCode).toBe(200);
      const opened = open.json() as {
        uploadId: string;
        recipientPublicKeyBase64: string;
        chunkSizeBytes: number;
        expiresAt: number;
      };
      expect(opened.uploadId).toEqual(expect.any(String));
      expect(opened.recipientPublicKeyBase64).toEqual(expect.any(String));
      expect(opened.chunkSizeBytes).toBeGreaterThan(0);
      expect(opened.expiresAt).toBeGreaterThan(0);

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: opened.recipientPublicKeyBase64,
      });

      const chunk = await app.inject({
        method: 'PUT',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/chunks/0`,
        payload: {
          payloadBase64: encryptedChunk.payloadBase64,
          encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
        },
      });
      expect(chunk.statusCode).toBe(200);
      expect(chunk.json()).toEqual({ success: true });

      const finalize = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/finalize`,
      });
      expect(finalize.statusCode).toBe(200);
      expect(finalize.json()).toMatchObject({
        success: true,
        finalized: expect.objectContaining({
          path: 'payload.bin',
          sizeBytes: payload.length,
        }),
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('accepts a default-sized encrypted import chunk without weakening the open-metadata body limit', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-default-chunk-'));
    const payload = Buffer.alloc(256_000, 0x5a);
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
      chunkSizeBytes: payload.length,
    });
    const request = {
      t: 'session_file_upload_v1' as const,
      workingDirectory: tempDir,
      path: 'payload.bin',
      sizeBytes: payload.length,
      overwrite: true,
    };
    const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken(request);
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();
      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: request,
      });
      expect(open.statusCode).toBe(200);
      const opened = open.json() as {
        uploadId: string;
        recipientPublicKeyBase64: string;
      };
      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: opened.recipientPublicKeyBase64,
      });

      const chunk = await app.inject({
        method: 'PUT',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/chunks/0`,
        payload: encryptedChunk,
      });

      expect(chunk.statusCode).toBe(200);
      expect(chunk.json()).toEqual({ success: true });
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('disposes the direct import transfer store when the app closes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-app-close-'));
    const tempEnv = createEnvKeyScope(['TEMP', 'TMP', 'TMPDIR']);
    const payload = Buffer.from('app-close-payload', 'utf8');

    try {
      tempEnv.patch({
        TEMP: tempDir,
        TMP: tempDir,
        TMPDIR: tempDir,
      });
      const importSessionManager = createDirectTransferImportSessionManager({
        ttlMs: 10_000,
      });
      const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
        t: 'session_file_upload_v1',
        workingDirectory: tempDir,
        path: 'payload.bin',
        sizeBytes: payload.length,
        overwrite: true,
      });
      const app = createDirectPeerTransferApp({
        readPublishedTransfer: () => null,
        importSessionManager,
      });

      await app.ready();
      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'payload.bin',
          sizeBytes: payload.length,
          overwrite: true,
        },
      });
      expect(open.statusCode).toBe(200);
      const transferRoots = await readdir(join(tempDir, 'happier', 'file-transfers'));
      expect(transferRoots).toHaveLength(1);
      const transferTempRoot = join(tempDir, 'happier', 'file-transfers', transferRoots[0] ?? '');
      await expect(access(transferTempRoot)).resolves.toBeUndefined();

      await app.close();

      await expectPathMissing(transferTempRoot);
      await expect(importSessionManager.openTrustedImportSession({
        workingDirectory: tempDir,
        t: 'session_file_upload_v1',
        path: 'after-close.bin',
        sizeBytes: payload.length,
        overwrite: true,
      })).rejects.toThrow('Transfer session store is disposed');
    } finally {
      tempEnv.restore();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('opens a workspace attachment import session, writes the ignore rule, and finalizes inside the explicit workspace root', async () => {
    const handlerWorkingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-attachment-handler-'));
    const sessionWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-attachment-workspace-'));
    const payload = Buffer.from('hello', 'utf8');
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await mkdir(join(sessionWorkspaceRoot, '.git'), { recursive: true });
      await writeFile(join(sessionWorkspaceRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(sessionWorkspaceRoot, '.gitignore'), '# existing\n', 'utf8');
      await app.ready();

      const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
        t: 'session_attachment_upload_v1',
        workingDirectory: handlerWorkingDirectory,
        messageLocalId: 'message-4',
        fileName: 'hello.txt',
        sizeBytes: payload.length,
        uploadLocation: 'workspace',
        workspaceRootPath: sessionWorkspaceRoot,
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'gitignore',
        vcsIgnoreWritesEnabled: true,
      });

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_attachment_upload_v1',
          workingDirectory: handlerWorkingDirectory,
          messageLocalId: 'message-4',
          fileName: 'hello.txt',
          sizeBytes: payload.length,
          uploadLocation: 'workspace',
          workspaceRootPath: sessionWorkspaceRoot,
          workspaceRelativeDir: '.happier/uploads',
          vcsIgnoreStrategy: 'gitignore',
          vcsIgnoreWritesEnabled: true,
        },
      });

      expect(open.statusCode).toBe(200);
      const opened = open.json() as {
        uploadId: string;
        recipientPublicKeyBase64: string;
      };
      expect(opened.uploadId).toEqual(expect.any(String));

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: opened.recipientPublicKeyBase64,
      });

      const chunk = await app.inject({
        method: 'PUT',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/chunks/0`,
        payload: {
          payloadBase64: encryptedChunk.payloadBase64,
          encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
        },
      });
      expect(chunk.statusCode).toBe(200);

      const finalize = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/finalize`,
      });
      expect(finalize.statusCode).toBe(200);
      expect(finalize.json()).toMatchObject({
        success: true,
        finalized: {
          success: true,
          path: expect.stringMatching(/^\.happier\/uploads\/messages\/message-4\/[0-9a-f]{8}-hello\.txt$/),
          sizeBytes: payload.length,
        },
      });

      const finalizedPath = (finalize.json() as { finalized: { path: string } }).finalized.path;
      await expect(readFile(resolve(sessionWorkspaceRoot, finalizedPath), 'utf8')).resolves.toBe('hello');
      await expect(readFile(join(sessionWorkspaceRoot, '.gitignore'), 'utf8')).resolves.toContain('/.happier/uploads/');
    } finally {
      await app.close();
      await rm(handlerWorkingDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(sessionWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('supports aborting an import session before finalization', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-abort-'));
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
    });
    const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
      t: 'session_file_upload_v1',
      workingDirectory: tempDir,
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: 'payload.bin',
          sizeBytes: 4,
          overwrite: true,
        },
      });
      expect(open.statusCode).toBe(200);
      const opened = open.json() as { uploadId: string };

      const abort = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/abort`,
      });
      expect(abort.statusCode).toBe(200);
      expect(abort.json()).toEqual({ success: true });

      const finalize = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/finalize`,
      });
      expect(finalize.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns a structured 400 keepSession failure for absolute-path collisions and still allows abort', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-import-collision-'));
    const destinationPath = resolve(join(tempDir, 'existing.txt'));
    const payload = Buffer.from('new\n', 'utf8');
    const importSessionManager = createDirectTransferImportSessionManager({
      ttlMs: 10_000,
    });
    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await writeFile(destinationPath, 'old\n', 'utf8');
      await app.ready();

      const openAuthorization = importSessionManager.issueImportOpenAuthorizationToken({
        t: 'session_file_upload_v1',
        workingDirectory: tempDir,
        path: destinationPath,
        sizeBytes: payload.length,
        overwrite: false,
      });

      const open = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/open',
        headers: {
          authorization: `Bearer ${openAuthorization.authorizationToken}`,
        },
        payload: {
          t: 'session_file_upload_v1',
          workingDirectory: tempDir,
          path: destinationPath,
          sizeBytes: payload.length,
          overwrite: false,
        },
      });
      expect(open.statusCode).toBe(200);
      const opened = open.json() as { uploadId: string; recipientPublicKeyBase64: string };

      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: opened.uploadId,
        sequence: 0,
        payload,
        recipientPublicKeyBase64: opened.recipientPublicKeyBase64,
      });

      const chunk = await app.inject({
        method: 'PUT',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/chunks/0`,
        payload: {
          payloadBase64: encryptedChunk.payloadBase64,
          encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
        },
      });
      expect(chunk.statusCode).toBe(200);
      expect(chunk.json()).toEqual({ success: true });

      const finalize = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/finalize`,
      });
      expect(finalize.statusCode).toBe(400);
      expect(finalize.json()).toEqual({
        success: false,
        error: 'Destination already exists',
        keepSession: true,
      });

      const abort = await app.inject({
        method: 'POST',
        url: `/machine-transfers/direct/imports/${opened.uploadId}/abort`,
      });
      expect(abort.statusCode).toBe(200);
      expect(abort.json()).toEqual({ success: true });
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('old\n');
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('maps keepSession finalize failures from the import session manager to a structured 400 response', async () => {
    const abortImportTransferSession = vi.fn(async () => {});
    const importSessionManager = {
      issueImportOpenAuthorizationToken: () => ({
        authorizationToken: 'unused-token',
        expiresAt: 1_000,
      }),
      openTrustedImportSession: async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.txt',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'recipient-public-key',
          expiresAt: 1_000,
        },
      }),
      openImportSession: async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.txt',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'recipient-public-key',
          expiresAt: 1_000,
        },
      }),
      writeImportTransferChunk: async () => ({ success: true as const }),
      finalizeImportTransferSession: async () => ({
        success: false as const,
        error: 'Destination already exists',
        keepSession: true,
      }),
      abortImportTransferSession,
      cleanupExpiredImportSessions: () => {},
      getNextImportSessionExpiryAt: () => null,
      countActiveImportSessions: () => 0,
      close: async () => {},
    } satisfies DirectTransferImportSessionManager;

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const finalize = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/upload-123/finalize',
      });
      expect(finalize.statusCode).toBe(400);
      expect(finalize.json()).toEqual({
        success: false,
        error: 'Destination already exists',
        keepSession: true,
      });

      const abort = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/upload-123/abort',
      });
      expect(abort.statusCode).toBe(200);
      expect(abort.json()).toEqual({ success: true });
      expect(abortImportTransferSession).toHaveBeenCalledWith({ uploadId: 'upload-123' });
    } finally {
      await app.close();
    }
  });

  it('maps finalize recovery failures to an exact application/json 500 response', async () => {
    const importSessionManager = {
      issueImportOpenAuthorizationToken: () => ({
        authorizationToken: 'unused-token',
        expiresAt: 1_000,
      }),
      openTrustedImportSession: async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.txt',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'recipient-public-key',
          expiresAt: 1_000,
        },
      }),
      openImportSession: async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.txt',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'recipient-public-key',
          expiresAt: 1_000,
        },
      }),
      writeImportTransferChunk: async () => ({ success: true as const }),
      finalizeImportTransferSession: async () => ({
        success: false as const,
        error: 'Destination recovery requires operator action',
        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED' as const,
        keepSession: true as const,
        expiresAt: 9_000,
      }),
      abortImportTransferSession: async () => {},
      cleanupExpiredImportSessions: () => {},
      getNextImportSessionExpiryAt: () => null,
      countActiveImportSessions: () => 1,
      close: async () => {},
    };

    const app = createDirectPeerTransferApp({
      readPublishedTransfer: () => null,
      importSessionManager,
    });

    try {
      await app.ready();

      const finalize = await app.inject({
        method: 'POST',
        url: '/machine-transfers/direct/imports/upload-recovery/finalize',
      });
      expect(finalize.statusCode).toBe(500);
      expect(finalize.headers['content-type']).toMatch(/^application\/json\b/);
      expect(finalize.headers['x-happier-transfer-session-expires-at']).toBe('9000');
      expect(finalize.headers['access-control-expose-headers']).toContain(
        'x-happier-transfer-session-expires-at',
      );
      expect(finalize.json()).toEqual({
        success: false,
        error: 'Destination recovery requires operator action',
        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
        keepSession: true,
      });
    } finally {
      await app.close();
    }
  });
});
