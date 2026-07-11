import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';

const getDirectSessionProviderOpsMock = vi.fn();
const commitSessionStoredMessageMock = vi.fn();

vi.mock('@/backends/catalog', () => ({
  getDirectSessionProviderOps: (...args: unknown[]) => getDirectSessionProviderOpsMock(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  commitSessionStoredMessage: (...args: unknown[]) => commitSessionStoredMessageMock(...args),
}));

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

function createLinkedSession(params: Readonly<{
  sessionPath?: string | null;
  remoteSessionId?: string;
}>): LoadedLinkedDirectSession {
  return {
    rawSession: {
      id: 'sess_direct_import',
      encryptionMode: 'plain',
      metadataVersion: 1,
      metadata: '{}',
    } as RawSessionRecord,
    metadata: {},
    sessionPath: params.sessionPath ?? null,
    providerId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: params.remoteSessionId ?? 'codex-thread-1',
    source: { kind: 'codexHome', home: 'user' },
    codexBackendMode: null,
  };
}

function directMediaItem(path: string) {
  return {
    id: 'provider-media-1',
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'provider-image.png',
    path,
    sizeBytes: pngBytes.byteLength,
    origin: { source: 'provider-generated', agentId: 'codex', generationId: 'img_1' },
  };
}

describe('importDirectSessionTranscript', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('adopts provider-owned direct transcript media into managed session storage before committing metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerDirectory, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);

      const item: DirectTranscriptRawMessageV1 = {
        id: 'direct-item-1',
        localId: 'direct-item-1',
        createdAtMs: 123,
        messageRole: 'event',
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'generated image' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: { media: [directMediaItem(providerImagePath)] },
            },
          },
        },
      };

      getDirectSessionProviderOpsMock.mockResolvedValue({
        pageTranscript: vi.fn(async () => ({
          items: [item],
          nextCursor: null,
          hasMore: false,
        })),
      });
      commitSessionStoredMessageMock.mockResolvedValue({
        didWrite: true,
        messageId: 'msg-1',
        seq: 1,
        createdAt: 123,
      });

      const { importDirectSessionTranscript } = await import('./importDirectSessionTranscript');
      await expect(importDirectSessionTranscript({
        linked: createLinkedSession({ sessionPath: null }),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import',
        workingDirectory,
      })).resolves.toEqual({ importedCount: 1 });

      expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(1);
      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0];
      expect(committed.messageRole).toBe('event');
      expect(committed.content.t).toBe('plain');
      const committedRaw = committed.content.v as Record<string, unknown>;
      const committedMeta = committedRaw.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;
      const committedMedia = committedPayload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(committedMedia[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/direct-item-1\//);
      expect(isAbsolute(adoptedPath)).toBe(false);
      expect(adoptedPath).not.toContain(providerDirectory);
      expect(JSON.stringify(committedRaw)).not.toContain(providerImagePath);
      expect(JSON.stringify(committedRaw)).not.toContain('file://');
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
      await expect(readFile(providerImagePath)).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });
});
