import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { describe, expect, it } from 'vitest';

import { garbageCollectSessionMedia, persistSessionMedia } from './persistSessionMedia';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const webmBytes = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]),
  Buffer.from('webm recording bytes', 'utf8'),
]);
const nonImageBytes = Buffer.from('not an image', 'utf8');

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('persistSessionMedia', () => {
  it('persists base64 generated image bytes as workspace-local metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-base64-'));
    const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'info', 'exclude'), '# existing\n', 'utf8');

      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-1',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            fileNameHint: '../Generated Image?.png',
          },
          origin: { source: 'provider-generated' },
          createdAtMs: 123,
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          mimeType: 'image/png',
          sizeBytes: pngBytes.byteLength,
          sha256: sha256Hex(pngBytes),
          width: 1,
          height: 1,
          createdAtMs: 123,
          origin: { source: 'provider-generated' },
        },
      });
      if (!result.success) throw new Error('expected persistence to succeed');
      expect(result.item.name).toBe('Generated Image_.png');
      expect(result.item.path).toMatch(/^\.happier\/uploads\/generated\/session-1\/message-1\/[0-9a-f-]+-Generated Image_\.png$/);
      expect(isAbsolute(result.item.path)).toBe(false);
      expect(JSON.stringify(result.item)).not.toContain(pngBytes.toString('base64'));
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(pngBytes);
      await expect(readFile(join(workingDirectory, '.git', 'info', 'exclude'), 'utf8')).resolves.toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('adopts local provider files into artifact storage and sniffs MIME from bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-file-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-media-'));

    try {
      const sourcePath = join(providerDirectory, 'misleading.png');
      await writeFile(sourcePath, gifBytes);

      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: gifBytes.byteLength,
        input: {
          sessionId: 'session-2',
          messageLocalId: 'tool-call-1',
          role: 'output',
          category: 'tool-artifact',
          source: {
            kind: 'local-file',
            path: sourcePath,
            mimeType: 'image/png',
            fileNameHint: 'chart.png',
          },
          origin: { source: 'tool-output' },
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          category: 'tool-artifact',
          mimeType: 'image/gif',
          sizeBytes: gifBytes.byteLength,
          sha256: sha256Hex(gifBytes),
        },
      });
      if (!result.success) throw new Error('expected persistence to succeed');
      expect(result.item.path).toMatch(/^\.happier\/uploads\/artifacts\/session-2\/tool-call-1\/[0-9a-f-]+-chart\.gif$/);
      expect(result.item.path).not.toContain(sourcePath);
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(gifBytes);
      await expect(readFile(sourcePath)).resolves.toEqual(gifBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('persists file-backed video artifacts by safe MIME metadata without image dimensions', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-video-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-provider-video-'));

    try {
      const localFilePath = join(providerDirectory, 'recording.webm');
      const localUriPath = join(providerDirectory, 'recording-uri.webm');
      await writeFile(localFilePath, webmBytes);
      await writeFile(localUriPath, webmBytes);

      const sources = [
        {
          label: 'local-file',
          source: { kind: 'local-file' as const, path: localFilePath },
        },
        {
          label: 'local-uri',
          source: { kind: 'local-uri' as const, uri: pathToFileURL(localUriPath).toString(), mimeType: 'video/webm' },
        },
        {
          label: 'provider-file',
          source: { kind: 'provider-file' as const, providerFileId: 'recording-file-1', mimeType: 'video/webm' },
        },
      ];

      for (const { label, source } of sources) {
        const result = await persistSessionMedia({
          workingDirectory,
          pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
          maxBytes: webmBytes.byteLength,
          providerFileDownloader: async () => ({
            success: true,
            bytes: webmBytes,
            mimeType: 'video/webm',
            fileNameHint: 'provider-recording.webm',
          }),
          input: {
            sessionId: `session-video-${label}`,
            messageLocalId: 'message-1',
            role: 'output',
            category: 'tool-artifact',
            source,
            origin: { source: 'tool-output', toolCallId: `recording-${label}` },
          },
        });

        expect(result).toMatchObject({
          success: true,
          item: {
            role: 'output',
            category: 'tool-artifact',
            mediaKind: 'video',
            mimeType: 'video/webm',
            sizeBytes: webmBytes.byteLength,
            sha256: sha256Hex(webmBytes),
            origin: { source: 'tool-output', toolCallId: `recording-${label}` },
          },
        });
        if (!result.success) throw new Error(`expected ${label} video persistence to succeed`);
        expect(result.item.path).toMatch(new RegExp(`^\\.happier/uploads/artifacts/session-video-${label}/message-1/[0-9a-f-]+-.+\\.webm$`));
        expect(result.item.width).toBeUndefined();
        expect(result.item.height).toBeUndefined();
        expect(JSON.stringify(result.item)).not.toContain(webmBytes.toString('base64'));
        await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(webmBytes);
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('rejects unsupported MIME, oversize media, unsafe ids, and unavailable provider-file placeholders', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-reject-'));
    const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

    try {
      await expect(persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: nonImageBytes.byteLength,
        input: {
          sessionId: 'session-3',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: nonImageBytes.toString('base64'), mimeType: 'text/plain' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'unsupported_mime' });

      await expect(persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry,
        maxBytes: pngBytes.byteLength - 1,
        input: {
          sessionId: 'session-3',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'media_too_large' });

      await expect(persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: 'session-3',
          messageLocalId: '../escape',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'invalid_message_local_id' });

      await expect(persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: 'session-3',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'provider-file', providerFileId: 'file-123', mimeType: 'image/png' },
          origin: { source: 'provider-generated', providerFileId: 'file-123' },
        },
      })).resolves.toMatchObject({ success: false, code: 'provider_file_unavailable' });

      await expect(stat(join(workingDirectory, '.happier', 'uploads', 'generated', 'message-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects inline base64 video sources instead of persisting video bytes from transcript-shaped data', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-video-base64-'));

    try {
      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: webmBytes.byteLength,
        input: {
          sessionId: 'session-video-base64',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'tool-artifact',
          source: { kind: 'base64', data: webmBytes.toString('base64'), mimeType: 'video/webm' },
          origin: { source: 'tool-output' },
        },
      });

      expect(result).toMatchObject({ success: false, code: 'unsupported_mime' });
      expect(JSON.stringify(result)).not.toContain(webmBytes.toString('base64'));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects malformed base64 image sources before accepting permissively decoded bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-malformed-base64-'));

    try {
      await expect(persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-malformed-base64',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: `!!!!${pngBytes.toString('base64')}`,
            mimeType: 'image/png',
            fileNameHint: 'generated.png',
          },
          origin: { source: 'provider-generated' },
        },
      })).resolves.toMatchObject({ success: false, code: 'invalid_base64' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('persists provider-file media when a provider downloader supplies bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-provider-file-'));

    try {
      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        providerFileDownloader: async (source) => {
          expect(source.providerFileId).toBe('file-123');
          return {
            success: true,
            bytes: pngBytes,
            mimeType: 'image/png',
            fileNameHint: 'provider-image.png',
          };
        },
        input: {
          sessionId: 'session-provider-file',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'provider-file', providerFileId: 'file-123', mimeType: 'image/png' },
          origin: { source: 'provider-generated', providerFileId: 'file-123' },
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          mimeType: 'image/png',
          sizeBytes: pngBytes.byteLength,
          origin: { source: 'provider-generated', providerFileId: 'file-123' },
        },
      });
      if (!result.success) throw new Error('expected persistence to succeed');
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('sanitizes origin identifiers before returning persisted media metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-origin-'));

    try {
      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-origin',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: {
            source: 'provider-generated',
            agentId: 'agent-safe',
            agentEventId: 'https://provider.example/events/secret-token',
            providerFileId: 'aW1hZ2VCeXRlcw==',
            generationId: '$CODEX_HOME/generated/image.png',
          },
        },
      });

      expect(result).toMatchObject({
        success: true,
        item: {
          origin: { source: 'provider-generated', agentId: 'agent-safe' },
        },
      });
      expect(JSON.stringify(result)).not.toContain('provider.example');
      expect(JSON.stringify(result)).not.toContain('aW1hZ2VCeXRlcw');
      expect(JSON.stringify(result)).not.toContain('$CODEX_HOME');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('uses fallback names for unsafe successful media file name hints', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-safe-name-'));
    const inlineDataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;

    try {
      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId: 'session-safe-name',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            fileNameHint: inlineDataUri,
          },
          origin: { source: 'provider-generated' },
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected persistence to succeed');
      expect(result.item.name).toBe('generated-image.png');
      expect(JSON.stringify(result.item)).not.toContain('data:image');
      expect(JSON.stringify(result.item)).not.toContain(pngBytes.toString('base64'));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('isolates persisted media paths by session id', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-isolation-'));

    try {
      const commonInput = {
        messageLocalId: 'message-1',
        role: 'output' as const,
        category: 'generated' as const,
        source: {
          kind: 'base64' as const,
          data: pngBytes.toString('base64'),
          mimeType: 'image/png' as const,
          fileNameHint: 'generated.png',
        },
        origin: { source: 'provider-generated' as const },
      };

      const first = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: { ...commonInput, sessionId: 'session-one' },
      });
      const second = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: { ...commonInput, sessionId: 'session-two' },
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (!first.success || !second.success) throw new Error('expected persistence to succeed');
      expect(first.item.path).toContain('/session-one/message-1/');
      expect(second.item.path).toContain('/session-two/message-1/');
      expect(first.item.path).not.toBe(second.item.path);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('reuses an existing same-session content-hash media file instead of failing on duplicate writes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-dedupe-'));
    const commonInput = {
      sessionId: 'session-dedupe',
      messageLocalId: 'message-1',
      role: 'output' as const,
      category: 'generated' as const,
      source: {
        kind: 'base64' as const,
        data: pngBytes.toString('base64'),
        mimeType: 'image/png' as const,
        fileNameHint: 'generated.png',
      },
      origin: { source: 'provider-generated' as const },
    };

    try {
      const first = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: commonInput,
      });
      const second = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: commonInput,
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (!first.success || !second.success) throw new Error('expected persistence to succeed');
      expect(second.item.path).toBe(first.item.path);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      await expect(readFile(resolve(workingDirectory, second.item.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('resolves deterministic filename collisions without throwing or overwriting existing bytes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-collision-'));
    const sessionId = 'session-collision';
    const messageLocalId = 'message-1';
    const conflictPath = `.happier/uploads/generated/${sessionId}/${messageLocalId}/${sha256Hex(pngBytes).slice(0, 12)}-generated.png`;

    try {
      await mkdir(dirname(resolve(workingDirectory, conflictPath)), { recursive: true });
      await writeFile(resolve(workingDirectory, conflictPath), gifBytes);

      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        input: {
          sessionId,
          messageLocalId,
          role: 'output',
          category: 'generated',
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            fileNameHint: 'generated.png',
          },
          origin: { source: 'provider-generated' },
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected persistence to succeed');
      expect(result.item.path).not.toBe(conflictPath);
      expect(result.item.path).toMatch(/-generated-1\.png$/);
      await expect(readFile(resolve(workingDirectory, conflictPath))).resolves.toEqual(gifBytes);
      await expect(readFile(resolve(workingDirectory, result.item.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('enforces per-session media budgets without falling back to inline metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-budget-'));

    try {
      const result = await persistSessionMedia({
        workingDirectory,
        pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
        maxBytes: pngBytes.byteLength,
        sessionBudgetMaxBytes: pngBytes.byteLength - 1,
        workspaceBudgetMaxBytes: null,
        input: {
          sessionId: 'session-budget',
          messageLocalId: 'message-1',
          role: 'output',
          category: 'generated',
          source: { kind: 'base64', data: pngBytes.toString('base64'), mimeType: 'image/png' },
          origin: { source: 'provider-generated' },
        },
      });

      expect(result).toMatchObject({
        success: false,
        code: 'session_media_session_budget_exceeded',
      });
      expect(JSON.stringify(result)).not.toContain(pngBytes.toString('base64'));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('garbage-collects unreferenced workspace session media without deleting referenced or protected files', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-gc-'));

    try {
      const referencedPath = '.happier/uploads/generated/session-gc/message-1/referenced.png';
      const protectedPath = '.happier/uploads/generated/session-gc/message-1/protected.png';
      const stalePath = '.happier/uploads/generated/session-gc/message-1/stale.png';
      const outsidePath = '.happier/other/stale.png';

      for (const mediaPath of [referencedPath, protectedPath, stalePath, outsidePath]) {
        await mkdir(dirname(resolve(workingDirectory, mediaPath)), { recursive: true });
        await writeFile(resolve(workingDirectory, mediaPath), pngBytes);
      }

      const result = await garbageCollectSessionMedia({
        workingDirectory,
        referencedWorkspaceRelativePaths: [referencedPath],
        protectedWorkspaceRelativePaths: [protectedPath],
      });

      expect(result).toMatchObject({
        deletedFiles: 1,
        deletedBytes: pngBytes.byteLength,
      });
      await expect(readFile(resolve(workingDirectory, referencedPath))).resolves.toEqual(pngBytes);
      await expect(readFile(resolve(workingDirectory, protectedPath))).resolves.toEqual(pngBytes);
      await expect(stat(resolve(workingDirectory, stalePath))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(resolve(workingDirectory, outsidePath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
