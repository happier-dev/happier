import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1,
  type ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import {
  prepareExternalSessionHistoricalImportItem,
  stageExternalSessionHistoricalImportItem,
  validateExternalSessionHistoricalImportStagedItem,
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

// Mirrors the canonical Message-writer profile-candidate reservation. The
// unsupported profile vector ensures E2EE cannot hide a future profile that
// the current reader cannot replay.
const reservedStructuredPresentationRawCandidates = [
  {
    id: 'current-v1',
    raw: Object.freeze({
      v: 1,
      profile: 'pluginTranscriptV1',
      owner: { pluginId: 'acme.preview', contributionLocalId: 'review-card' },
      snapshot: { kind: 'text', text: 'must wait for a reader floor' },
    }),
  },
  {
    id: 'unsupported-profile',
    raw: Object.freeze({ v: 2, profile: 'pluginTranscriptV2' }),
  },
] as const;

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
  it('writes plain historical content with token-only credentials', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-token-only-import-'));
    try {
      const linked = createLinkedSession(workingDirectory);
      const prepared = await prepareExternalSessionHistoricalImportItem({
        item: {
          id: 'plain-item',
          localId: 'plain-item',
          createdAtMs: 123,
          raw: { role: 'agent', content: { type: 'output', data: 'plain' } },
        },
        linked,
        credentials: { token: 'plain-token', encryption: null },
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
      });

      expect(prepared.content).toEqual({
        t: 'plain',
        v: { role: 'agent', content: { type: 'output', data: 'plain' } },
      });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('preserves a child sidechain through preparation and staged replay', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-sidechain-import-'));
    const sidechainId = '22222222-2222-2222-2222-222222222222';
    try {
      const item: ExternalSessionTranscriptRawMessageV1 = {
        id: 'child-sidechain-item',
        localId: 'child-sidechain-item',
        createdAtMs: 123,
        sidechainId,
        raw: { role: 'agent', content: { type: 'output', data: 'child output' } },
      };
      const linked = createLinkedSession(workingDirectory);
      const staged = await stageExternalSessionHistoricalImportItem({
        item,
        workingDirectory,
        sourceReadRoots: [],
      });
      const prepared = await prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
      });
      const replayed = validateExternalSessionHistoricalImportStagedItem({
        staged,
        linked,
        credentials,
        sessionId: 'sess-managed',
      });

      expect(staged.item).toMatchObject({ sidechainId });
      expect(prepared).toMatchObject({ sidechainId });
      expect(replayed).toMatchObject({ sidechainId });

      const rootItem: ExternalSessionTranscriptRawMessageV1 = {
        id: 'root-sidechain-item',
        localId: 'root-sidechain-item',
        createdAtMs: 124,
        raw: { role: 'agent', content: { type: 'output', data: 'root output' } },
      };
      const rootStaged = await stageExternalSessionHistoricalImportItem({
        item: rootItem,
        workingDirectory,
        sourceReadRoots: [],
      });
      const rootPrepared = await prepareExternalSessionHistoricalImportItem({
        item: rootStaged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
      });
      const rootReplayed = validateExternalSessionHistoricalImportStagedItem({
        staged: rootStaged,
        linked,
        credentials,
        sessionId: 'sess-managed',
      });

      expect(rootStaged.item).not.toHaveProperty('sidechainId');
      expect(rootPrepared).toMatchObject({ sidechainId: null });
      expect(rootReplayed).toMatchObject({ sidechainId: null });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('host-stamps only source-fact user history and removes protected input metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-source-fact-import-'));
    try {
      const sourceFact = await prepareExternalSessionHistoricalImportItem({
        item: {
          id: 'source-fact-user',
          localId: 'source-fact-user',
          createdAtMs: 123,
          messageRole: 'user',
          userProjection: 'source_fact',
          raw: {
            role: 'user',
            content: { type: 'text', text: 'historical user fact' },
            meta: {
              displayText: 'preserve this',
              happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
              happierInputAuthorityV1: { v: 1, producer: 'happierApp' },
              happierInputRequestV1: { v: 1, producer: 'happierApp' },
            },
          },
        },
        linked: createLinkedSession(workingDirectory),
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
      });
      const ordinaryUser = await prepareExternalSessionHistoricalImportItem({
        item: {
          id: 'ordinary-user',
          localId: 'ordinary-user',
          createdAtMs: 124,
          messageRole: 'user',
          raw: {
            role: 'user',
            content: { type: 'text', text: 'ordinary imported user row' },
            meta: {
              happierProvenanceV1: { v: 1, kind: 'host', producer: 'externalSessionHistory' },
              happierInputAuthorityV1: { v: 1, producer: 'happierApp' },
            },
          },
        },
        linked: createLinkedSession(workingDirectory),
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
      });

      expect(sourceFact.content).toEqual({
        t: 'plain',
        v: expect.objectContaining({
          role: 'user',
          meta: expect.objectContaining({
            displayText: 'preserve this',
            happierProvenanceV1: {
              v: 1,
              kind: 'host',
              producer: 'externalSessionHistory',
            },
          }),
        }),
      });
      if (sourceFact.content.t !== 'plain') throw new Error('expected_plain_source_fact_content');
      const sourceFactMeta = (sourceFact.content.v as Record<string, unknown>).meta;
      expect(sourceFactMeta).not.toHaveProperty('happierInputAuthorityV1');
      expect(sourceFactMeta).not.toHaveProperty('happierInputRequestV1');
      expect(SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1.externalSessionHistory)
        .toBe('transcriptOnly');

      if (ordinaryUser.content.t !== 'plain') throw new Error('expected_plain_ordinary_user_content');
      const ordinaryUserMeta = (ordinaryUser.content.v as Record<string, unknown>).meta;
      expect(ordinaryUserMeta).not.toHaveProperty('happierProvenanceV1');
      expect(ordinaryUserMeta).not.toHaveProperty('happierInputAuthorityV1');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('fails retained E2EE historical import without fabricating encryption material', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-locked-import-'));
    try {
      const linked = {
        ...createLinkedSession(workingDirectory),
        rawSession: {
          id: 'sess-encrypted',
          encryptionMode: 'e2ee',
        } as LoadedLinkedExternalSession['rawSession'],
      };

      await expect(prepareExternalSessionHistoricalImportItem({
        item: {
          id: 'encrypted-item',
          localId: 'encrypted-item',
          createdAtMs: 123,
          raw: { role: 'agent', content: { type: 'output', data: 'encrypted' } },
        },
        linked,
        credentials: { token: 'plain-token', encryption: null },
        sessionId: 'sess-encrypted',
        workingDirectory,
        sourceReadRoots: [],
      })).rejects.toMatchObject({
        category: 'conversion',
      });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('keeps fresh E2EE historical preparations randomized', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-randomized-import-'));
    try {
      const linked = {
        ...createLinkedSession(workingDirectory),
        rawSession: {
          id: 'sess-encrypted',
          encryptionMode: 'e2ee',
          dataEncryptionKey: null,
        } as LoadedLinkedExternalSession['rawSession'],
      };
      const input = {
        item: {
          id: 'randomized-item',
          localId: 'randomized-item',
          createdAtMs: 123,
          raw: { role: 'agent', content: { type: 'output', data: 'randomized' } },
        },
        linked,
        credentials: {
          token: 'token-1',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        },
        sessionId: 'sess-encrypted',
        workingDirectory: null,
        sourceReadRoots: [],
      } as const;

      const first = await prepareExternalSessionHistoricalImportItem(input);
      const second = await prepareExternalSessionHistoricalImportItem(input);

      expect(first.localId).toBe(second.localId);
      expect(first.content.t).toBe('encrypted');
      expect(second.content.t).toBe('encrypted');
      if (first.content.t !== 'encrypted' || second.content.t !== 'encrypted') {
        throw new Error('expected_encrypted_historical_import_content');
      }
      expect(second.content.c).not.toBe(first.content.c);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects structured-presentation candidates before plaintext historical-import conversion', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-reserved-plain-import-'));
    try {
      const linked = createLinkedSession(workingDirectory);
      for (const candidate of reservedStructuredPresentationRawCandidates) {
        const item: ExternalSessionTranscriptRawMessageV1 = {
          id: `reserved-plain-${candidate.id}`,
          localId: `reserved-plain-${candidate.id}`,
          createdAtMs: 123,
          raw: candidate.raw,
        };
        const staged = await stageExternalSessionHistoricalImportItem({
          item,
          workingDirectory,
          sourceReadRoots: [],
        });

        await expect(prepareExternalSessionHistoricalImportItem({
          item: staged.item,
          linked,
          credentials: { token: 'plain-token', encryption: null },
          sessionId: 'sess-managed',
          workingDirectory,
          sourceReadRoots: [],
        })).rejects.toMatchObject({ category: 'conversion' });
        expect(() => validateExternalSessionHistoricalImportStagedItem({
          staged,
          linked,
          credentials: { token: 'plain-token', encryption: null },
          sessionId: 'sess-managed',
        })).toThrowError(expect.objectContaining({ category: 'conversion' }));
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects structured-presentation candidates before E2EE historical-import encryption', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-reserved-e2ee-import-'));
    try {
      const linked = {
        ...createLinkedSession(workingDirectory),
        rawSession: {
          id: 'sess-encrypted',
          encryptionMode: 'e2ee',
          dataEncryptionKey: null,
        } as LoadedLinkedExternalSession['rawSession'],
      };
      const credentials = {
        token: 'token-1',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
      };
      for (const candidate of reservedStructuredPresentationRawCandidates) {
        const item: ExternalSessionTranscriptRawMessageV1 = {
          id: `reserved-e2ee-${candidate.id}`,
          localId: `reserved-e2ee-${candidate.id}`,
          createdAtMs: 123,
          raw: candidate.raw,
        };
        const staged = await stageExternalSessionHistoricalImportItem({
          item,
          workingDirectory,
          sourceReadRoots: [],
        });

        await expect(prepareExternalSessionHistoricalImportItem({
          item: staged.item,
          linked,
          credentials,
          sessionId: 'sess-encrypted',
          workingDirectory,
          sourceReadRoots: [],
        })).rejects.toMatchObject({ category: 'conversion' });
        expect(() => validateExternalSessionHistoricalImportStagedItem({
          staged,
          linked,
          credentials,
          sessionId: 'sess-encrypted',
        })).toThrowError(expect.objectContaining({ category: 'conversion' }));
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('reports ownership only for the preparation that created deterministic workspace media', async () => {
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

      const firstCreatedPaths: string[] = [];
      const firstWorkspacePaths: string[] = [];
      const first = await prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        createdWorkspaceMediaPaths: firstCreatedPaths,
        persistedWorkspaceMediaPaths: firstWorkspacePaths,
      });
      const secondCreatedPaths: string[] = [];
      const secondWorkspacePaths: string[] = [];
      const second = await prepareExternalSessionHistoricalImportItem({
        item: staged.item,
        linked,
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        createdWorkspaceMediaPaths: secondCreatedPaths,
        persistedWorkspaceMediaPaths: secondWorkspacePaths,
      });
      expect(second).toEqual(first);
      expect(firstCreatedPaths).toHaveLength(1);
      expect(secondCreatedPaths).toEqual([]);
      expect(firstWorkspacePaths).toEqual(firstCreatedPaths);
      expect(secondWorkspacePaths).toEqual(firstCreatedPaths);
      await expect(readFile(resolve(workingDirectory, firstCreatedPaths[0]!)))
        .resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('cleans only newly created media after interrupted preparation and preserves an exact reused file', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-staged-import-transient-cleanup-'));
    try {
      const firstSourcePath = join(workingDirectory, 'first.png');
      const secondSourcePath = join(workingDirectory, 'second.png');
      await writeFile(firstSourcePath, pngBytes);
      await writeFile(secondSourcePath, Buffer.concat([pngBytes, Buffer.from('second')]));
      const rawFor = (paths: readonly string[]): ExternalSessionTranscriptRawMessageV1 => ({
        id: 'transient-media-item',
        localId: 'transient-media-item',
        createdAtMs: 123,
        raw: {
          meta: {
            happier: {
              kind: 'session_media.v1',
              payload: { media: paths.map(externalSessionMediaItem) },
            },
          },
        },
      });
      const firstStaged = await stageExternalSessionHistoricalImportItem({
        item: rawFor([firstSourcePath]),
        workingDirectory,
        sourceReadRoots: [],
      });
      const firstCreatedPaths: string[] = [];
      await prepareExternalSessionHistoricalImportItem({
        item: firstStaged.item,
        linked: createLinkedSession(workingDirectory),
        credentials,
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        createdWorkspaceMediaPaths: firstCreatedPaths,
      });
      expect(firstCreatedPaths).toHaveLength(1);

      const secondStaged = await stageExternalSessionHistoricalImportItem({
        item: rawFor([firstSourcePath, secondSourcePath]),
        workingDirectory,
        sourceReadRoots: [],
      });
      const transientCreatedPaths: string[] = [];
      await expect(prepareExternalSessionHistoricalImportItem({
        item: secondStaged.item,
        linked: {
          ...createLinkedSession(workingDirectory),
          rawSession: {
            id: 'sess-managed',
            encryptionMode: 'e2ee',
          } as LoadedLinkedExternalSession['rawSession'],
        },
        credentials: { token: 'token-1', encryption: null },
        sessionId: 'sess-managed',
        workingDirectory,
        sourceReadRoots: [],
        createdWorkspaceMediaPaths: transientCreatedPaths,
      })).rejects.toMatchObject({ category: 'conversion' });
      expect(transientCreatedPaths).toHaveLength(1);

      await garbageCollectUncommittedSessionMedia({
        workingDirectory,
        candidateWorkspaceRelativePaths: transientCreatedPaths,
        reason: 'interrupted_ingestion',
      });
      await expect(readFile(resolve(workingDirectory, firstCreatedPaths[0]!)))
        .resolves.toEqual(pngBytes);
      await expect(stat(resolve(workingDirectory, transientCreatedPaths[0]!)))
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
