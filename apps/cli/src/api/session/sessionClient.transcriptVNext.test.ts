import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
  flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';

type ClientWithQueuedCommits = {
  messageCommitQueueTail: Promise<void>;
};

async function flushQueuedCommits(client: ClientWithQueuedCommits): Promise<void> {
  await flushApiSessionClientMessageCommitQueue(client);
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

describe('ApiSessionClient transcript vNext transport', () => {
  it('forwards sidechainId as plaintext metadata on durable commits', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'hi', sidechainId: 'sc-1' } as any,
      { localId: 'l1' },
    );

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ sidechainId: 'sc-1' }),
    );
  });

  it('forwards Claude sidechainId on durable commits for imported sidechain messages', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendProviderMessage({
      provider: 'claude',
      body: {
        type: 'assistant',
        uuid: 'sidechain-uuid',
        sidechainId: 'tool_agent_1',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from teammate' }],
        },
      } satisfies RawJSONLines,
      meta: { importedFrom: 'claude-team-inbox' },
    });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ sidechainId: 'tool_agent_1' }),
    );
  });

  it('does not expose transcript-draft ephemerals (legacy partial streaming removed)', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expect((client as any).sendTranscriptDraftDelta).toBeUndefined();
  });

  it('emits live transcript stream segments on the session socket without waiting for durable ACKs', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello', sidechainId: 'sc-1' } as any,
      {
        localId: 'segment-1',
        createdAt: 1_000,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs: 1_025,
          },
        },
      },
    );

    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          sidechainId: 'sc-1',
          createdAt: 1_000,
          updatedAt: 1_025,
          content: {
            t: 'plain',
            v: expect.objectContaining({
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'codex',
                data: { type: 'message', message: 'Hello', sidechainId: 'sc-1' },
              },
            }),
          },
        }),
      }),
    );
  });

  it('observes committed and ephemeral root assistant text through the session transcript API', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', seq: 5 }));
    const snapshotStore = client.getTurnAssistantTextSnapshotStore();
    snapshotStore.beginTurn({ turnToken: 'turn-1', startSeqExclusive: client.getLastObservedMessageSeq(), startedAtMs: 1_000 });

    (client as any).sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Live answer' },
      { localId: 'segment-1', createdAt: 1_000 },
    );
    expect(snapshotStore.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toMatchObject({
      normalizedText: 'Live answer',
      source: 'ephemeral',
    });

    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'Final answer' } as any,
      { localId: 'segment-1' },
    );

    expect(snapshotStore.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toMatchObject({
      normalizedText: 'Final answer',
      source: 'committed',
    });
  });

  it('persists assistant session media through the central bridge before committing byte-free transcript metadata', async () => {
    vi.resetModules();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-bridge-'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }));

      await client.sendAgentSessionMediaCommitted('codex', {
        localId: 'media-row-1',
        role: 'output',
        category: 'generated',
        media: [{
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            fileNameHint: 'generated.png',
          },
          origin: { source: 'provider-generated' },
        }],
      });

      expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
      const [, payload] = sessionSocketStub.emitWithAck.mock.calls[0]!;
      expect(payload).toMatchObject({
        localId: 'media-row-1',
        message: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'codex',
              data: { type: 'message', message: '' },
            },
            meta: {
              happierMedia: {
                kind: 'session_media.v1',
                payload: {
                  media: [expect.objectContaining({
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    path: expect.stringMatching(/^\.happier\/uploads\/generated\/s1\/media-row-1\//),
                    origin: { source: 'provider-generated' },
                  })],
                },
              },
            },
          },
        },
      });
      expect(JSON.stringify(payload)).not.toContain(pngBytes.toString('base64'));
      const media = (payload as any).message.v.meta.happierMedia.payload.media[0];
      await expect(readFile(resolve(workingDirectory, media.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('commits successful session media when another item fails with sanitized failure metadata', async () => {
    vi.resetModules();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-partial-failure-'));
    const missingSourcePath = join(workingDirectory, 'provider-cache', 'generated.png');
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-partial', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }));

      await client.sendAgentSessionMediaCommitted('codex', {
        localId: 'media-row-partial',
        role: 'output',
        category: 'generated',
        meta: {
          sentFrom: 'cli',
          providerId: 'codex',
          summary: 'provider generated an image',
          nested: {
            data: pngBytes.toString('base64'),
            dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
            sourcePath: missingSourcePath,
          },
        },
        media: [
          {
            source: {
              kind: 'base64',
              data: pngBytes.toString('base64'),
              mimeType: 'image/png',
              fileNameHint: 'generated.png',
            },
            origin: {
              source: 'provider-generated',
              agentId: 'codex',
              providerEventId: 'event-123',
              providerFileId: 'file-123',
            },
          },
          {
            source: {
              kind: 'local-file',
              path: missingSourcePath,
              mimeType: 'image/png',
              fileNameHint: 'missing.png',
            },
            origin: {
              source: 'provider-generated',
              providerFileId: 'file-missing',
            },
          },
        ],
      });

      expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
      const [, payload] = sessionSocketStub.emitWithAck.mock.calls[0]!;
      const meta = (payload as any).message.v.meta;
      expect(meta.sentFrom).toBe('cli');
      expect(meta.happierMedia).toMatchObject({
        kind: 'session_media.v1',
        payload: {
          media: [expect.objectContaining({
            path: expect.stringMatching(/^\.happier\/uploads\/generated\/s1\/media-row-partial\//),
            origin: {
              source: 'provider-generated',
              agentId: 'codex',
              providerEventId: 'event-123',
              providerFileId: 'file-123',
            },
          })],
          failures: [expect.objectContaining({
            index: 1,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: 'missing.png',
            mimeType: 'image/png',
            origin: {
              source: 'provider-generated',
              providerFileId: 'file-missing',
            },
          })],
        },
      });
      const serializedMeta = JSON.stringify(meta);
      expect(serializedMeta).not.toContain(pngBytes.toString('base64'));
      expect(serializedMeta).not.toContain('data:image/png;base64');
      expect(serializedMeta).not.toContain(missingSourcePath);
      expect(serializedMeta).not.toContain('providerId');
      expect(serializedMeta).not.toContain('summary');
      const media = meta.happierMedia.payload.media[0];
      await expect(readFile(resolve(workingDirectory, media.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('commits all-failure media-only rows as durable sanitized session media failure metadata', async () => {
    vi.resetModules();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-all-failure-'));
    const missingSourcePath = join(workingDirectory, 'provider-cache', 'missing.png');
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-failed', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }));

      await client.sendAgentSessionMediaCommitted('codex', {
        localId: 'media-row-failed',
        role: 'output',
        category: 'generated',
        media: [{
          source: {
            kind: 'local-file',
            path: missingSourcePath,
            mimeType: 'image/png',
            fileNameHint: 'missing.png',
          },
          origin: {
            source: 'provider-generated',
            providerFileId: 'file-missing',
          },
        }],
      });

      expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
      const [, payload] = sessionSocketStub.emitWithAck.mock.calls[0]!;
      expect(payload).toMatchObject({
        localId: 'media-row-failed',
        message: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'codex',
              data: { type: 'message', message: '' },
            },
            meta: {
              happierMedia: {
                kind: 'session_media.v1',
                payload: {
                  media: [],
                  failures: [expect.objectContaining({
                    index: 0,
                    code: 'invalid_source_file',
                    role: 'output',
                    category: 'generated',
                    mediaKind: 'image',
                    name: 'missing.png',
                    mimeType: 'image/png',
                    origin: {
                      source: 'provider-generated',
                      providerFileId: 'file-missing',
                    },
                  })],
                },
              },
            },
          },
        },
      });
      const serializedMeta = JSON.stringify((payload as any).message.v.meta);
      expect(serializedMeta).not.toContain(missingSourcePath);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('commits missing working-directory media as durable failure metadata instead of throwing', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-no-wd', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      metadata: createTestMetadata({ path: '' }),
    }));

    await expect(client.sendAgentSessionMediaCommitted('codex', {
      localId: 'media-row-no-wd',
      role: 'output',
      category: 'generated',
      media: [{
        source: {
          kind: 'base64',
          data: pngBytes.toString('base64'),
          mimeType: 'image/png',
          fileNameHint: 'generated.png',
        },
        origin: { source: 'provider-generated', providerFileId: 'file-123' },
      }],
    })).resolves.toBeUndefined();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
    const [, payload] = sessionSocketStub.emitWithAck.mock.calls[0]!;
    const meta = (payload as any).message.v.meta;
    expect(meta.happierMedia).toMatchObject({
      kind: 'session_media.v1',
      payload: {
        media: [],
        failures: [expect.objectContaining({
          index: 0,
          code: 'missing_working_directory',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'generated.png',
          mimeType: 'image/png',
          origin: { source: 'provider-generated', providerFileId: 'file-123' },
        })],
      },
    });
    expect(JSON.stringify(meta)).not.toContain(pngBytes.toString('base64'));
  });

  it('clears stale assistant text snapshots when a committed assistant row contains media only', async () => {
    vi.resetModules();
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-snapshot-'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-snapshot', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        seq: 5,
        metadata: createTestMetadata({ path: workingDirectory }),
      }));
      const snapshotStore = client.getTurnAssistantTextSnapshotStore();
      snapshotStore.beginTurn({ turnToken: 'turn-media-only', startSeqExclusive: client.getLastObservedMessageSeq(), startedAtMs: 1_000 });

      client.sendAgentMessageEphemeral(
        'codex',
        { type: 'message', message: 'Stale streamed text' },
        { localId: 'segment-stale', createdAt: 1_000 },
      );
      expect(snapshotStore.getCurrentTurnSnapshot({ turnToken: 'turn-media-only' })?.normalizedText).toBe('Stale streamed text');

      await client.sendAgentSessionMediaCommitted('codex', {
        localId: 'media-row-snapshot',
        role: 'output',
        category: 'generated',
        media: [{
          source: {
            kind: 'base64',
            data: pngBytes.toString('base64'),
            mimeType: 'image/png',
            fileNameHint: 'generated.png',
          },
          origin: { source: 'provider-generated' },
        }],
      });

      expect(snapshotStore.getCurrentTurnSnapshot({ turnToken: 'turn-media-only' })).toBeNull();

      client.sendAgentMessageEphemeral(
        'codex',
        { type: 'message', message: 'Ready after media' },
        { localId: 'segment-final', createdAt: 1_100 },
      );
      expect(snapshotStore.getCurrentTurnSnapshot({ turnToken: 'turn-media-only' })).toMatchObject({
        normalizedText: 'Ready after media',
        source: 'ephemeral',
      });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('clears materialized localId state when a durable stream checkpoint arrives as message-updated', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'Hello' } as any,
      { localId: 'segment-1' },
    );

    expect((client as any).committedLocalIdsAwaitingEcho.has('segment-1')).toBe(true);

    const updateHandler = sessionSocketStub.getHandler('update');
    expect(updateHandler).toBeTypeOf('function');

    updateHandler?.({
      id: 'u2',
      seq: 2,
      createdAt: 2_000,
      body: {
        t: 'message-updated',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          localId: 'segment-1',
          createdAt: 1_000,
          updatedAt: 2_000,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Hello world' }, meta: {} } },
        },
      },
    });

    expect((client as any).committedLocalIdsAwaitingEcho.has('segment-1')).toBe(false);
  });
});
