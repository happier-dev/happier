import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
// The boundary mocks above are hoisted and read their stubs lazily, so every
// test can share one module instance. Re-importing sessionClient behind
// vi.resetModules() per test instantiated its graph eleven times and exhausted
// an 8 GiB heap before this file could report a result.
import { ApiSessionClient } from './sessionClient';
import { loadSessionClientDurableMutationOutbox } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { createPluginSessionMediaHostAdapter } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionMedia';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const openClients: Array<{ close: () => Promise<void> }> = [];

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

function readSessionMediaEnvelope(meta: Record<string, unknown>): unknown {
  const primary = meta.happier;
  if (primary && typeof primary === 'object' && (primary as { kind?: unknown }).kind === 'session_media.v1') {
    return primary;
  }
  return meta.happierMedia;
}

async function readAdmittedMediaMessage(client: ApiSessionClient, localId: string) {
  const records = await loadSessionClientDurableMutationOutbox(client.sessionId);
  const record = records.find(record => record.kind === 'transcript_message_append' && record.payload.localId === localId);
  if (!record || record.kind !== 'transcript_message_append') throw new Error('Missing durable media message');
  return { localId: record.payload.localId, message: record.payload.content };
}

function trackClient<T extends { close: () => Promise<void> }>(client: T): T {
  openClients.push(client);
  return client;
}

afterEach(async () => {
  const clients = openClients.splice(0);
  await Promise.allSettled(clients.map((client) => client.close()));
  sessionSocketStub = null;
  userSocketStub = null;
  vi.clearAllMocks();
});

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

  it('does not expose transcript-draft ephemerals (legacy partial streaming removed)', () => {
    expect('sendTranscriptDraftDelta' in ApiSessionClient.prototype).toBe(false);
  });

  it('emits live transcript stream segments on the session socket without waiting for durable ACKs', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
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
          messageRole: 'agent',
          sidechainId: 'sc-1',
          createdAt: 1_000,
          updatedAt: 1_025,
          content: {
            t: 'plain',
            v: expect.objectContaining({
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'message', message: 'Hello', sidechainId: 'sc-1' },
              },
            }),
          },
        }),
      }),
    );
  });

  it('includes the live-stream tick on transcript-stream-segment snapshot emissions when provided', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
    (client as any).sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello' },
      { localId: 'segment-1', createdAt: 1_000, tick: 5 },
    );

    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          tick: 5,
        }),
      }),
    );
  });

  it('emits transcript-stream-segment-delta ticks carrying only the appended text', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
    expect((client as any).sendAgentMessageEphemeralDelta).toBeTypeOf('function');
    (client as any).sendAgentMessageEphemeralDelta(
      'codex',
      { type: 'message', message: ' world', sidechainId: 'sc-1' },
      {
        localId: 'segment-1',
        tick: 2,
        baseLength: 5,
        createdAt: 1_000,
        updatedAt: 1_040,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs: 1_040,
          },
        },
      },
    );

    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment-delta',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          messageRole: 'agent',
          sidechainId: 'sc-1',
          tick: 2,
          baseLength: 5,
          createdAt: 1_000,
          updatedAt: 1_040,
          content: {
            t: 'plain',
            v: expect.objectContaining({
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'message', message: ' world', sidechainId: 'sc-1' },
              },
            }),
          },
        }),
      }),
    );
  });

  it('does not emit transcript-stream-segment-delta while the socket is disconnected', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
    (client as any).sendAgentMessageEphemeralDelta(
      'codex',
      { type: 'message', message: 'delta' },
      { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1_000 },
    );

    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith(
      'transcript-stream-segment-delta',
      expect.anything(),
    );
  });

  it('sends live transcript segments as ordinary packets, never as socket.io volatile packets', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    // Boundary mirror of socket.io-client 4.x: reading `socket.volatile` arms a flag that the next emit
    // consumes, and a volatile packet is discarded whenever the transport is mid-write.
    const stub = sessionSocketStub;
    let volatileArmed = false;
    const emittedVolatile: Array<[string, boolean]> = [];
    const plainEmit = stub.emit;
    Object.defineProperty(stub, 'volatile', { configurable: true, get: () => {
      volatileArmed = true;
      return { emit: (event: string, ...args: unknown[]) => stub.emit(event, ...args) };
    } });
    stub.emit = vi.fn((event: string, ...args: unknown[]) => {
      emittedVolatile.push([event, volatileArmed]);
      volatileArmed = false;
      return plainEmit(event, ...args);
    }) as typeof stub.emit;

    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
    (client as any).sendAgentMessageEphemeral('codex', { type: 'message', message: 'Hello' } as any,
      { localId: 'segment-1', tick: 1, createdAt: 1_000 });
    (client as any).sendAgentMessageEphemeralDelta('codex', { type: 'message', message: ' world' },
      { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1_000 });

    expect(emittedVolatile.filter(([event]) => event.startsWith('transcript-stream-segment'))).toEqual([
      ['transcript-stream-segment', false],
      ['transcript-stream-segment-delta', false],
    ]);
  });

  it('advances the ephemeral stream connection epoch on every socket connect', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));
    await Promise.resolve();
    await Promise.resolve();

    const initialEpoch = (client as any).getEphemeralStreamConnectionEpoch();
    expect(initialEpoch).toBeGreaterThanOrEqual(1);

    // Boundary mock: the mocked connection supervisor invokes onConnected on every start().
    await (client as unknown as { sessionConnectionSupervisor: { start: () => Promise<void> } }).sessionConnectionSupervisor.start();

    expect((client as any).getEphemeralStreamConnectionEpoch()).toBe(initialEpoch + 1);
  });

  it('does not expose retired direct transcript publication bypasses', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' })));

    expect('sendAgentMessageCommitted' in client).toBe(false);
    expect('sendUserTextMessageCommitted' in client).toBe(false);
    expect('sendSessionEvent' in client).toBe(false);
    expect('sendProviderMessage' in client).toBe(false);
    expect('sendAgentMessage' in client).toBe(false);
  });



  it('persists plugin tool-result images locally through the central media service with byte-free, sidechain-scoped transcript metadata', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-bridge-'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }), { durableMutationDeliveryInitiallyActive: false }));

      const adapter = createPluginSessionMediaHostAdapter({
        agentId: 'claude',
        readActiveScope: () => ({
          sessionId: 's1', rootPath: workingDirectory,
          sendAgentSessionMediaCommitted: client.sendAgentSessionMediaCommitted.bind(client),
        }),
      });
      const service = adapter.forSession('s1');
      expect(service.publishToolResultMedia).toBeTypeOf('function');
      await service.publishToolResultMedia!({ localId: 'ordinary-result', toolCallId: 'text-1', content: [{ type: 'text', text: 'done' }] });
      expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
      await service.publishToolResultMedia!({
        localId: 'media-row-1', toolCallId: 'read-image-1', sidechainId: 'child-1',
        content: [{ type: 'text', text: 'Image read' }, {
          type: 'image', source: { type: 'base64', data: pngBytes.toString('base64'), media_type: 'image/png' },
        }],
      });

      const payload = await readAdmittedMediaMessage(client, 'media-row-1');
      expect(payload).toMatchObject({
        localId: 'media-row-1',
        message: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'claude',
              data: { type: 'message', message: '', sidechainId: 'child-1' },
            },
            meta: {
              happier: {
                kind: 'session_media.v1',
                payload: {
                  media: [expect.objectContaining({
                    role: 'output',
                    category: 'tool-artifact',
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    path: expect.stringMatching(/^\.happier\/uploads\/artifacts\/s1\/media-row-1\//),
                    origin: { source: 'tool-output', agentId: 'claude', toolCallId: 'read-image-1' },
                  })],
                },
              },
            },
          },
        },
      });
      expect(JSON.stringify(payload)).not.toContain(pngBytes.toString('base64'));
      const media = (readSessionMediaEnvelope((payload as any).message.v.meta) as any).payload.media[0];
      await expect(readFile(resolve(workingDirectory, media.path))).resolves.toEqual(pngBytes);
      adapter.dispose();
      await expect(service.publishToolResultMedia!({ localId: 'retired', toolCallId: 'read-2', content: [] })).rejects.toThrow('media_adapter_disposed');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('commits successful session media when another item fails with sanitized failure metadata', async () => {
    const workingDirectory = await realpath(await mkdtemp(join(tmpdir(), 'happier-session-media-partial-failure-')));
    const missingSourcePath = join(workingDirectory, 'provider-cache', 'generated.png');
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-partial', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }), { durableMutationDeliveryInitiallyActive: false }));

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
              agentEventId: 'event-123',
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
            sourceAccessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
          },
        ],
      });

      const payload = await readAdmittedMediaMessage(client, 'media-row-partial');
      const meta = (payload as any).message.v.meta;
      expect(meta.sentFrom).toBe('cli');
      const sessionMediaEnvelope = readSessionMediaEnvelope(meta);
      expect(sessionMediaEnvelope).toMatchObject({
        kind: 'session_media.v1',
        payload: {
          media: [expect.objectContaining({
            path: expect.stringMatching(/^\.happier\/uploads\/generated\/s1\/media-row-partial\//),
            origin: {
              source: 'provider-generated',
              agentId: 'codex',
              agentEventId: 'event-123',
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
      const media = (sessionMediaEnvelope as any).payload.media[0];
      await expect(readFile(resolve(workingDirectory, media.path))).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('commits all-failure media-only rows as durable sanitized session media failure metadata', async () => {
    const workingDirectory = await realpath(await mkdtemp(join(tmpdir(), 'happier-session-media-all-failure-')));
    const missingSourcePath = join(workingDirectory, 'provider-cache', 'missing.png');
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-failed', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ path: workingDirectory }),
      }), { durableMutationDeliveryInitiallyActive: false }));

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
          sourceAccessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
        }],
      });

      const payload = await readAdmittedMediaMessage(client, 'media-row-failed');
      expect(payload).toMatchObject({
        localId: 'media-row-failed',
        message: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'codex',
              data: { type: 'message', message: '' },
            },
            meta: {
              happier: {
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
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-no-wd', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });


    const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({
      id: 's1',
      metadata: createTestMetadata({ path: '' }),
    }), { durableMutationDeliveryInitiallyActive: false }));

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

    const payload = await readAdmittedMediaMessage(client, 'media-row-no-wd');
    const meta = (payload as any).message.v.meta;
    expect(readSessionMediaEnvelope(meta)).toMatchObject({
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
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-snapshot-'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 8, localId: 'media-row-snapshot', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });

      const client = trackClient(createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({
        id: 's1',
        seq: 5,
        metadata: createTestMetadata({ path: workingDirectory }),
      })));
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

});
