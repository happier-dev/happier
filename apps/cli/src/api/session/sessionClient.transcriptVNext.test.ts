import { describe, expect, it, vi } from 'vitest';

import type { RawJSONLines } from '@/backends/claude/types';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
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
    client.sendClaudeSessionMessage(
      {
        type: 'assistant',
        uuid: 'sidechain-uuid',
        sidechainId: 'tool_agent_1',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from teammate' }],
        },
      } satisfies RawJSONLines,
      { importedFrom: 'claude-team-inbox' },
    );

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
    expect(client.sendAgentMessageEphemeral).toBeTypeOf('function');
    client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello', sidechainId: 'sc-1' },
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

  it('does not emit an ephemeral stream segment updatedAt earlier than createdAt', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(500);

    try {
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      client.sendAgentMessageEphemeral(
        'codex',
        { type: 'message', message: 'Hello' },
        {
          localId: 'segment-1',
          createdAt: 1_000,
        },
      );

      expect(sessionSocketStub.emit).toHaveBeenCalledWith(
        'transcript-stream-segment',
        expect.objectContaining({
          message: expect.objectContaining({
            createdAt: 1_000,
            updatedAt: 1_000,
          }),
        }),
      );
    } finally {
      nowSpy.mockRestore();
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
