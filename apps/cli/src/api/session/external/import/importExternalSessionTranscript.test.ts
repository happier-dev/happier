import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';

const commitSessionStoredMessageMock = vi.fn();
const pageTranscriptMock = vi.fn();
const resolveTranscriptMediaReadRootsMock = vi.fn<() => Promise<string[]>>(async () => []);

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
      externalSession: {
        pageTranscript: pageTranscriptMock,
        resolveTranscriptMediaReadRoots: resolveTranscriptMediaReadRootsMock,
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
    resolveTranscriptMediaReadRootsMock.mockResolvedValue([]);
  });

  it('adopts provider-owned direct-session media into managed session storage before committing metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerDirectory = join(workingDirectory, '.opencode', 'media');
      await mkdir(providerDirectory, { recursive: true });
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

  it('adopts provider-owned media from verified external media roots during import', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-root-workspace-'));
    const providerMediaRoot = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-root-media-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerMediaRoot, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);
      resolveTranscriptMediaReadRootsMock.mockResolvedValueOnce([providerMediaRoot]);

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-provider-root',
        localId: 'direct-item-provider-root',
        createdAtMs: 124,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'generated outside workspace' } },
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
        createdAt: 124,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_provider_root',
      })).resolves.toEqual({ importedCount: 1 });

      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;
      const committedMedia = committedPayload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(committedMedia[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import_provider_root\/direct-import:v1:opencode:/);
      expect(adoptedPath).not.toBe(providerImagePath);
      expect(committedPayload.failures).toBeUndefined();
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerMediaRoot, { recursive: true, force: true });
    }
  });

  it('does not adopt direct-session media from absolute or file URI paths outside the working directory', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-secure-workspace-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-outside-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const outsideAbsolutePath = join(outsideDirectory, 'absolute-secret.png');
      const outsideFileUriPath = join(outsideDirectory, 'file-uri-secret.png');
      await writeFile(outsideAbsolutePath, pngBytes);
      await writeFile(outsideFileUriPath, pngBytes);

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-malicious',
        localId: 'direct-item-malicious',
        createdAtMs: 125,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'malicious media paths' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: {
                media: [
                  directMediaItem(outsideAbsolutePath),
                  directMediaItem(pathToFileURL(outsideFileUriPath).href),
                ],
              },
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
        createdAt: 125,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_secure',
      })).resolves.toEqual({ importedCount: 1 });

      expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(1);
      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;

      expect(committedPayload.media).toEqual([]);
      expect(committedPayload.failures).toMatchObject([
        {
          index: 0,
          code: expect.stringMatching(/^unauthorized_/),
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'provider-image.png',
        },
        {
          index: 1,
          code: expect.stringMatching(/^unauthorized_/),
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'provider-image.png',
        },
      ]);
      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(outsideAbsolutePath)).resolves.toEqual(pngBytes);
      await expect(readFile(outsideFileUriPath)).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('preserves unavailable placeholders with safe names for malformed direct-session media entries', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-malformed-workspace-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-malformed',
        localId: 'direct-item-malformed',
        createdAtMs: 126,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'malformed media paths' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: {
                media: [
                  {
                    id: 'missing-path',
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    name: '../raw/name?.png',
                    path: '   ',
                    sizeBytes: 0,
                    origin: { source: 'provider-generated' },
                  },
                  null,
                  {
                    ...directMediaItem('https://example.test/provider.png'),
                    name: 'provider/<unsafe>:name?.png',
                  },
                ],
              },
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
        createdAt: 126,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_malformed',
      })).resolves.toEqual({ importedCount: 1 });

      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;

      expect(committedPayload.media).toEqual([]);
      expect(committedPayload.failures).toMatchObject([
        {
          index: 0,
          code: 'missing_source_path',
          name: 'name_.png',
        },
        {
          index: 1,
          code: 'malformed_media_record',
          name: 'image-2',
        },
        {
          index: 2,
          code: 'unsupported_source_path',
          name: '_unsafe_name_.png',
        },
      ]);
      await expect(stat(join(workingDirectory, '.happier', 'uploads'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('sanitizes canonical imported media and preserves existing unavailable placeholders', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-canonical-workspace-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const canonicalPath = '.happier/uploads/generated/sess_existing/msg-1/safe.png';
      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-canonical',
        localId: 'direct-item-canonical',
        createdAtMs: 127,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'canonical media' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: {
                media: [
                  {
                    ...directMediaItem(canonicalPath),
                    id: 'safe-canonical',
                    name: 'safe.png',
                    sha256: 'a'.repeat(64),
                    origin: {
                      source: 'provider-generated',
                      agentId: 'opencode',
                      providerEventId: 'https://example.test/event-secret',
                      providerFileId: 'QUJDREVGR0hJSktM',
                      generationId: '/tmp/provider/generated.png',
                    },
                    displayLabel: 'must not be retained',
                  },
                  {
                    ...directMediaItem('.happier/uploads/generated/sess_existing/msg-1/unsafe.png'),
                    id: 'unsafe-canonical',
                    name: 'data:image/png;base64,AAAA',
                    data: 'inline-bytes',
                    url: 'https://example.test/unsafe.png',
                    sourcePath: '/tmp/secret.png',
                    origin: {
                      source: 'provider-generated',
                      agentId: 'https://example.test/agent',
                      providerFileId: 'QUJDREVGR0hJSktM',
                    },
                  },
                  {
                    ...directMediaItem('.happier/uploads/generated/sess_existing/msg-1/mismatch.png'),
                    id: 'mismatched-category',
                    category: 'attachment',
                    name: 'mismatch.png',
                  },
                  {
                    ...directMediaItem('.happier/uploads/generated/sess_existing/msg-1/unsafe-identity.png'),
                    id: 'aW1hZ2VCeXRlcw==',
                    name: 'https://example.test/provider-name.png',
                    origin: {
                      source: 'provider-generated',
                      providerFileId: 'QUJDREVGR0hJSktM',
                    },
                  },
                ],
                failures: [
                  {
                    index: 7,
                    code: 'provider_unavailable',
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    name: 'https://example.test/secret.png',
                    mimeType: 'image/png',
                    origin: {
                      source: 'provider-generated',
                      agentId: 'https://example.test/agent',
                      providerFileId: 'safe-provider-file',
                    },
                    fileUrl: 'file:///tmp/secret.png',
                  },
                ],
              },
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
        createdAt: 127,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_canonical',
      })).resolves.toEqual({ importedCount: 1 });

      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;
      const committedMedia = committedPayload.media as Array<Record<string, unknown>>;
      const committedFailures = committedPayload.failures as Array<Record<string, unknown>>;

      expect(committedMedia).toEqual([
        {
          id: 'safe-canonical',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          mimeType: 'image/png',
          name: 'safe.png',
          path: canonicalPath,
          sizeBytes: pngBytes.byteLength,
          sha256: 'a'.repeat(64),
          origin: { source: 'provider-generated', agentId: 'opencode' },
        },
      ]);
      expect(JSON.stringify(committedPayload)).not.toContain('displayLabel');
      expect(JSON.stringify(committedPayload)).not.toContain('inline-bytes');
      expect(JSON.stringify(committedPayload)).not.toContain('file:///tmp/secret.png');
      expect(committedFailures).toMatchObject([
        {
          index: 1,
          code: 'invalid_media_record',
          name: 'image-2',
          origin: { source: 'provider-generated' },
        },
        {
          index: 2,
          code: 'invalid_media_record',
          name: 'mismatch.png',
        },
        {
          index: 3,
          code: 'invalid_media_record',
          name: 'image-4',
          origin: { source: 'provider-generated' },
        },
        {
          index: 7,
          code: 'provider_unavailable',
          name: 'image-8',
          origin: { source: 'provider-generated', providerFileId: 'safe-provider-file' },
        },
      ]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('sanitizes failure-only direct-session media envelopes', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-failure-only-workspace-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-failure-only',
        localId: 'direct-item-failure-only',
        createdAtMs: 128,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'failure only' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: {
                media: [],
                failures: [
                  {
                    index: 0,
                    code: 'provider_unavailable',
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    name: 'data:image/png;base64,QUJDREVGR0hJSktM',
                    mimeType: 'image/png',
                    origin: {
                      source: 'provider-generated',
                      agentId: 'file:///tmp/agent',
                      providerFileId: 'safe-provider-file',
                    },
                    fileUrl: 'file:///tmp/secret.png',
                  },
                ],
              },
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
        createdAt: 128,
      });

      const { importExternalSessionTranscript } = await import('./importExternalSessionTranscript');
      await expect(importExternalSessionTranscript({
        linked: createLinkedSession(workingDirectory),
        credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) } },
        sessionId: 'sess_direct_import_failure_only',
      })).resolves.toEqual({ importedCount: 1 });

      const committed = commitSessionStoredMessageMock.mock.calls[0]?.[0] as {
        content: { t: 'plain'; v: Record<string, unknown> };
      };
      const committedMeta = committed.content.v.meta as Record<string, unknown>;
      const committedEnvelope = committedMeta.happier as Record<string, unknown>;
      const committedPayload = committedEnvelope.payload as Record<string, unknown>;

      expect(committedPayload.media).toEqual([]);
      expect(committedPayload.failures).toEqual([
        {
          index: 0,
          code: 'provider_unavailable',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'image-1',
          mimeType: 'image/png',
          origin: { source: 'provider-generated', providerFileId: 'safe-provider-file' },
        },
      ]);
      expect(JSON.stringify(committedPayload)).not.toContain('file:///tmp/secret.png');
      expect(JSON.stringify(committedPayload)).not.toContain('file:///tmp/agent');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
