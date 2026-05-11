import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { describe, expect, it } from 'vitest';

import { garbageCollectSessionMedia, persistSessionMedia } from './persistSessionMedia';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
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
      await expect(readFile(resolve(workingDirectory, second.item.path))).resolves.toEqual(pngBytes);
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
