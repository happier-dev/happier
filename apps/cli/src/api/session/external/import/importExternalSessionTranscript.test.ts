import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  cleanupExternalSessionHistoricalImportStagedMedia,
  prepareExternalSessionHistoricalImportItem,
  stageExternalSessionHistoricalImportItem,
} from './importExternalSessionTranscript';

vi.mock('sharp', () => ({
  default: () => ({
    metadata: async () => ({ width: 1, height: 1 }),
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
    agentId: 'opencode',
    machineId: 'machine-1',
    remoteSessionId: 'provider-session-1',
    linkGeneration: '1',
    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: workingDirectory },
    codexBackendMode: null,
  };
}

function externalSessionMediaItem(path: string): Record<string, unknown> {
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

const credentials = {
  token: 'token-1',
  encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3]) },
};

async function preparePlainHistoricalImportItem(params: Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  workingDirectory: string;
  sessionId: string;
  linked?: LoadedLinkedExternalSession;
  sourceReadRoots?: readonly string[];
}>): Promise<Readonly<{
  prepared: Awaited<ReturnType<typeof prepareExternalSessionHistoricalImportItem>>;
  payload: Record<string, unknown>;
}>> {
  const prepared = await prepareExternalSessionHistoricalImportItem({
    item: params.item,
    linked: params.linked ?? createLinkedSession(params.workingDirectory),
    credentials,
    sessionId: params.sessionId,
    workingDirectory: params.workingDirectory,
    sourceReadRoots: params.sourceReadRoots ?? [],
  });
  if (prepared.content.t !== 'plain') {
    throw new Error('expected_plain_historical_import_test_content');
  }
  if (
    !prepared.content.v
    || typeof prepared.content.v !== 'object'
    || Array.isArray(prepared.content.v)
  ) {
    throw new Error('expected_object_historical_import_test_content');
  }
  const meta = (prepared.content.v as Record<string, unknown>).meta as Record<string, unknown>;
  const envelope = meta.happier as Record<string, unknown>;
  return {
    prepared,
    payload: envelope.payload as Record<string, unknown>,
  };
}

describe('external session historical import item preparation', () => {
  it('replays immutable staged media idempotently and removes its final workspace file on discard', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-staged-import-discard-'));
    try {
      const sourcePath = join(workingDirectory, 'source.png');
      await writeFile(sourcePath, pngBytes);
      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'discarded-media-item',
        localId: 'discarded-media-item',
        createdAtMs: 123,
        raw: {
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: { media: [externalSessionMediaItem(sourcePath)] },
            },
          },
        },
      };
      const linked = createLinkedSession(workingDirectory);
      const credentials = {
        token: 'token-1',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3]) },
      };
      const staged = await stageExternalSessionHistoricalImportItem({
        item,
        workingDirectory,
        sourceReadRoots: [],
      });
      await writeFile(sourcePath, Buffer.from('source mutated after capture'));
      await expect(prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory: null,
        sourceReadRoots: [],
      })).rejects.toMatchObject({
        category: 'media',
      });

      const firstCleanupPaths: string[] = [];
      const first = await prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        cleanupWorkspaceMediaPaths: firstCleanupPaths,
      });
      const secondCleanupPaths: string[] = [];
      const second = await prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        cleanupWorkspaceMediaPaths: secondCleanupPaths,
      });
      expect(second).toEqual(first);
      expect(secondCleanupPaths).toEqual(firstCleanupPaths);
      await expect(readFile(resolve(workingDirectory, firstCleanupPaths[0]!)))
        .resolves.toEqual(pngBytes);

      await cleanupExternalSessionHistoricalImportStagedMedia({
        staged,
        agentId: linked.agentId,
        remoteSessionId: linked.remoteSessionId,
        sessionId: 'sess-managed',
      });
      await expect(stat(resolve(workingDirectory, firstCleanupPaths[0]!)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('adopts provider-owned external-session media into managed session storage before historical import', async () => {
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
        messageRole: 'event',
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'generated image' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: { media: [externalSessionMediaItem(providerImagePath)] },
            },
          },
        },
      };

      const { prepared, payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import',
      });
      expect(prepared.messageRole).toBe('event');
      const media = payload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(media[0]?.path ?? '');

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
              payload: { media: [externalSessionMediaItem('images/out.png')] },
            },
          },
        },
      };

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_relative',
      });
      const media = payload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(media[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import_relative\/direct-import:v1:opencode:/);
      expect(adoptedPath).not.toBe('images/out.png');
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('uses the persisted takeover working directory when linked session metadata has no usable path', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-takeover-workspace-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-takeover-outside-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await mkdir(join(workingDirectory, 'images'), { recursive: true });
      await writeFile(join(workingDirectory, 'images', 'inside.png'), pngBytes);
      const outsidePath = join(outsideDirectory, 'outside.png');
      await writeFile(outsidePath, pngBytes);

      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'direct-item-takeover-working-directory',
        localId: 'direct-item-takeover-working-directory',
        createdAtMs: 124,
        raw: {
          role: 'agent',
          content: { type: 'output', data: { type: 'message', message: 'takeover media' } },
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: {
                media: [
                  externalSessionMediaItem('images/inside.png'),
                  externalSessionMediaItem(outsidePath),
                ],
              },
            },
          },
        },
      };

      const linked = {
        ...createLinkedSession(workingDirectory),
        metadata: {},
        sessionPath: null,
      };
      const { payload } = await preparePlainHistoricalImportItem({
        item,
        linked,
        workingDirectory,
        sessionId: 'sess_direct_import_takeover_working_directory',
      });
      const media = payload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(media[0]?.path ?? '');

      expect(media).toHaveLength(1);
      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import_takeover_working_directory\/direct-import:v1:opencode:/);
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
      expect(payload.failures).toMatchObject([
        { index: 1, code: expect.stringMatching(/^unauthorized_/) },
      ]);
      await expect(readFile(outsidePath)).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('adopts provider-owned media from verified external media roots during import', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-root-workspace-'));
    const providerMediaRoot = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-root-media-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerMediaRoot, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);

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
              payload: { media: [externalSessionMediaItem(providerImagePath)] },
            },
          },
        },
      };

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_provider_root',
        sourceReadRoots: [providerMediaRoot],
      });
      const media = payload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(media[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/sess_direct_import_provider_root\/direct-import:v1:opencode:/);
      expect(adoptedPath).not.toBe(providerImagePath);
      expect(payload.failures).toBeUndefined();
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerMediaRoot, { recursive: true, force: true });
    }
  });

  it('does not adopt external-session media from absolute or file URI paths outside the working directory', async () => {
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
                  externalSessionMediaItem(outsideAbsolutePath),
                  externalSessionMediaItem(pathToFileURL(outsideFileUriPath).href),
                ],
              },
            },
          },
        },
      };

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_secure',
      });

      expect(payload.media).toEqual([]);
      expect(payload.failures).toMatchObject([
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

  it('preserves unavailable placeholders with safe names for malformed external-session media entries', async () => {
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
                    ...externalSessionMediaItem('https://example.test/provider.png'),
                    name: 'provider/<unsafe>:name?.png',
                  },
                ],
              },
            },
          },
        },
      };

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_malformed',
      });

      expect(payload.media).toEqual([]);
      expect(payload.failures).toMatchObject([
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
                    ...externalSessionMediaItem(canonicalPath),
                    id: 'safe-canonical',
                    name: 'safe.png',
                    sha256: 'a'.repeat(64),
                    origin: {
                      source: 'provider-generated',
                      agentId: 'opencode',
                      agentEventId: 'https://example.test/event-secret',
                      providerFileId: 'QUJDREVGR0hJSktM',
                      generationId: '/tmp/provider/generated.png',
                    },
                    displayLabel: 'must not be retained',
                  },
                  {
                    ...externalSessionMediaItem('.happier/uploads/generated/sess_existing/msg-1/unsafe.png'),
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
                    ...externalSessionMediaItem('.happier/uploads/generated/sess_existing/msg-1/mismatch.png'),
                    id: 'mismatched-category',
                    category: 'attachment',
                    name: 'mismatch.png',
                  },
                  {
                    ...externalSessionMediaItem('.happier/uploads/generated/sess_existing/msg-1/unsafe-identity.png'),
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
                    code: 'agent_unavailable',
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

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_canonical',
      });
      const media = payload.media as Array<Record<string, unknown>>;
      const failures = payload.failures as Array<Record<string, unknown>>;

      expect(media).toEqual([
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
      expect(JSON.stringify(payload)).not.toContain('displayLabel');
      expect(JSON.stringify(payload)).not.toContain('inline-bytes');
      expect(JSON.stringify(payload)).not.toContain('file:///tmp/secret.png');
      expect(failures).toMatchObject([
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
          code: 'agent_unavailable',
          name: 'image-8',
          origin: { source: 'provider-generated', providerFileId: 'safe-provider-file' },
        },
      ]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('sanitizes failure-only external-session media envelopes', async () => {
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
                    code: 'agent_unavailable',
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

      const { payload } = await preparePlainHistoricalImportItem({
        item,
        workingDirectory,
        sessionId: 'sess_direct_import_failure_only',
      });

      expect(payload.media).toEqual([]);
      expect(payload.failures).toEqual([
        {
          index: 0,
          code: 'agent_unavailable',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'image-1',
          mimeType: 'image/png',
          origin: { source: 'provider-generated', providerFileId: 'safe-provider-file' },
        },
      ]);
      expect(JSON.stringify(payload)).not.toContain('file:///tmp/secret.png');
      expect(JSON.stringify(payload)).not.toContain('file:///tmp/agent');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
