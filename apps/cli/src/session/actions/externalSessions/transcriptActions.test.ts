import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const validateDirectMachineSourceMock = vi.fn();
const resolveExternalSessionSurfaceOpsMock = vi.fn();

vi.mock('@/api/session/external/security/validateDirectMachineSource', () => ({
  validateDirectMachineSource: (...args: unknown[]) => validateDirectMachineSourceMock(...args),
}));

vi.mock('./providerOpsResolution', () => ({
  resolveExternalSessionSurfaceOps: (...args: unknown[]) => resolveExternalSessionSurfaceOpsMock(...args),
}));

vi.mock('sharp', () => ({
  default: () => ({
    metadata: async () => ({ width: 1, height: 1 }),
  }),
}));

let transcriptActionsModule: typeof import('./transcriptActions');

describe('external session transcript actions', () => {
  beforeAll(async () => {
    transcriptActionsModule = await import('./transcriptActions');
  }, 60_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps direct-session media browsing transient with scoped read files only', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-source-'));
    const verifiedDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-verified-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-outside-'));
    const sourceDirectoryMediaPath = join(sourceDirectory, '.opencode', 'media', 'source-directory-owned.png');
    const providerMediaPath = join(verifiedDirectory, '.opencode', 'media', 'provider-owned.png');
    const sensitiveMediaPath = join(outsideDirectory, 'sensitive.png');
    await mkdir(join(sourceDirectory, '.opencode', 'media'), { recursive: true });
    await mkdir(join(verifiedDirectory, '.opencode', 'media'), { recursive: true });
    await writeFile(sourceDirectoryMediaPath, 'source-directory-media');
    await writeFile(providerMediaPath, 'provider-media');
    await writeFile(sensitiveMediaPath, 'sensitive-media');
    validateDirectMachineSourceMock.mockResolvedValue({
      ok: true,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: sourceDirectory },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      resolveTranscriptMediaReadRoots: async () => [verifiedDirectory],
      pageTranscript: async () => ({
        items: [
          {
            id: 'direct-item-1',
            localId: 'direct-item-1',
            createdAtMs: 123,
            raw: {
              role: 'agent',
              content: { type: 'output', data: { type: 'message', message: 'preview only' } },
              meta: {
                happier: {
                  kind: 'session_media.v1',
                  payload: {
                    media: [{
                      id: 'provider-media-1',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'provider-owned.png',
                      path: providerMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }, {
                      id: 'provider-media-source-directory',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'source-directory-owned.png',
                      path: sourceDirectoryMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }, {
                      id: 'provider-media-2',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'sensitive.png',
                      path: sensitiveMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }],
                  },
                },
              },
            },
          },
        ],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
      }),
    });

    try {
      const { executeExternalSessionTranscriptPageAction } = transcriptActionsModule;
      const response = await executeExternalSessionTranscriptPageAction({
        machineId: 'machine-1',
        agentId: 'opencode',
        remoteSessionId: 'provider-session-1',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: sourceDirectory },
        direction: 'older',
      });

      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error('expected transcript page to succeed');
      expect(JSON.stringify(response.items)).toContain(providerMediaPath);
      expect(JSON.stringify(response.items)).toContain(sourceDirectoryMediaPath);
      expect(JSON.stringify(response.items)).toContain(sensitiveMediaPath);
      expect(JSON.stringify(response.items)).not.toContain('.happier/uploads/generated');
      expect((response as { transientMediaReadFiles?: readonly string[] }).transientMediaReadFiles).toEqual([
        providerMediaPath,
      ]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(verifiedDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});
