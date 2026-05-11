import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';

const commitSessionStoredMessageMock = vi.fn();
const pageTranscriptMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
  return {
    ...actual,
    commitSessionStoredMessage: (...args: unknown[]) => commitSessionStoredMessageMock(...args),
  };
});

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: async () => ({
      externalSessions: {
        pageTranscript: pageTranscriptMock,
      },
    }),
  }),
}));

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

function createLinkedSession(workingDirectory: string): LoadedLinkedExternalSession {
  return {
    rawSession: { id: 'sess-managed', encryptionMode: 'plain' } as LoadedLinkedExternalSession['rawSession'],
    metadata: { path: workingDirectory },
    sessionPath: workingDirectory,
    providerId: 'opencode',
    machineId: 'machine-1',
    remoteSessionId: 'provider-session-1',
    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: workingDirectory },
    codexBackendMode: null,
  };
}

function directMediaItem(path: string): Record<string, unknown> {
  return {
    id: 'provider-media-1',
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'provider-image.png',
    path,
    sizeBytes: pngBytes.byteLength,
    origin: { source: 'provider-generated', agentId: 'opencode' },
  };
}

describe('importExternalSessionTranscript', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('adopts provider-owned direct-session media into managed session storage before committing metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerDirectory, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-1',
        localId: 'direct-item-1',
        createdAtMs: 123,
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

      pageTranscriptMock.mockResolvedValueOnce({
        items: [item],
        nextCursor: null,
        hasMore: false,
      });
      commitSessionStoredMessageMock.mockResolvedValue({
        didWrite: true,
        messageId: 'msg-1',
        seq: 1,
        createdAt: 123,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import',
      })).resolves.toEqual({ importedCount: 1 });

      expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(1);
      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;
      const committedMedia = committedPayload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(committedMedia[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import\/direct-import:v1:opencode:/);
      expect(adoptedPath).not.toBe(providerImagePath);
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('adopts provider-native relative media paths instead of treating them as durable workspace media', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-relative-workspace-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(workingDirectory, 'images', 'out.png');
      await mkdir(join(workingDirectory, 'images'), { recursive: true });
      await writeFile(providerImagePath, pngBytes);

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-relative',
        localId: 'direct-item-relative',
        createdAtMs: 124,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'generated relative image' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: { media: [directMediaItem('images/out.png')] },
            },
          },
        },
      };

      pageTranscriptMock.mockResolvedValueOnce({
        items: [item],
        nextCursor: null,
        hasMore: false,
      });
      commitSessionStoredMessageMock.mockResolvedValue({
        didWrite: true,
        messageId: 'msg-1',
        seq: 1,
        createdAt: 124,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_relative',
      })).resolves.toEqual({ importedCount: 1 });

      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;
      const committedMedia = committedPayload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(committedMedia[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import_relative\/direct-import:v1:opencode:/);
      expect(adoptedPath).not.toBe('images/out.png');
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
