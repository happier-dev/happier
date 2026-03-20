import { describe, expect, it, vi } from 'vitest';

import type { RawJSONLines } from '@/backends/claude/types';
import type { Session } from '@/api/types';

type EmitCall = { event: string; payload: unknown };
type EmitWithAckCall = { event: string; payload: unknown };

type SocketStub = {
  socket: {
    id: string;
    connected: boolean;
    on: (event: string, handler: (...args: any[]) => void) => void;
    off: (event: string, handler?: (...args: any[]) => void) => void;
    close: () => void;
    connect: () => void;
    disconnect: () => void;
    emit: (event: string, payload: unknown, cb?: (...args: any[]) => void) => void;
    timeout: (ms: number) => any;
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
  };
  calls: { emit: EmitCall[]; emitWithAck: EmitWithAckCall[] };
  handlers: Map<string, (...args: any[]) => void>;
};

type ClientWithQueuedCommits = {
  messageCommitQueueTail: Promise<void>;
};

function createSocketStub(opts: { emitWithAckResult: unknown }): SocketStub {
  const calls: SocketStub['calls'] = { emit: [], emitWithAck: [] };
  const handlers = new Map<string, (...args: any[]) => void>();

  const socket: SocketStub['socket'] = {
    id: 'sock-1',
    connected: true,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    close: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn((event: string, payload: unknown) => {
      calls.emit.push({ event, payload });
    }),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async (event: string, payload: unknown) => {
      calls.emitWithAck.push({ event, payload });
      return opts.emitWithAckResult;
    }),
  };

  return { socket, calls, handlers };
}

async function flushQueuedCommits(client: ClientWithQueuedCommits): Promise<void> {
  await client.messageCommitQueueTail;
}

let sessionSocketStub: SocketStub | null = null;
let userSocketStub: SocketStub | null = null;

vi.mock('./sockets', () => ({
  createSessionScopedSocket: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return sessionSocketStub.socket as any;
  },
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub.socket as any;
  },
}));

function createPlainSession(): Session {
  return {
    id: 's1',
    seq: 0,
    encryptionMode: 'plain',
    metadata: {
      path: '/tmp',
      host: 'test',
      homeDir: '/home/test',
      happyHomeDir: '/home/test/.happier',
      happyLibDir: '/home/test/.happier/lib',
      happyToolsDir: '/home/test/.happier/tools',
    },
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
  };
}

describe('ApiSessionClient transcript vNext transport', () => {
  it('forwards sidechainId as plaintext metadata on durable commits', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createSocketStub({ emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSession());
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'hi', sidechainId: 'sc-1' } as any,
      { localId: 'l1' },
    );

    expect(sessionSocketStub.calls.emitWithAck).toHaveLength(1);
    expect(sessionSocketStub.calls.emitWithAck[0]!.event).toBe('message');
    expect(sessionSocketStub.calls.emitWithAck[0]!.payload).toMatchObject({ sidechainId: 'sc-1' });
  });

  it('forwards Claude sidechainId on durable commits for imported sidechain messages', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createSocketStub({ emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSession());
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

    expect(sessionSocketStub.calls.emitWithAck).toHaveLength(1);
    expect(sessionSocketStub.calls.emitWithAck[0]!.event).toBe('message');
    expect(sessionSocketStub.calls.emitWithAck[0]!.payload).toMatchObject({ sidechainId: 'tool_agent_1' });
  });

  it('emits transcript-draft ephemerals without writing to the durable transcript', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createSocketStub({ emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSession());
    client.sendTranscriptDraftDelta('codex' as any, {
      localId: 'd1',
      segmentKind: 'assistant',
      sidechainId: 'sc-1',
      deltaText: 'Hello',
      createdAtMs: 123,
    });

    expect(sessionSocketStub.calls.emit.some((c) => c.event === 'message')).toBe(false);
    expect(sessionSocketStub.calls.emit).toContainEqual(
      expect.objectContaining({
        event: 'transcript-draft',
        payload: expect.objectContaining({
          sid: 's1',
          localId: 'd1',
          segmentKind: 'assistant',
          sidechainId: 'sc-1',
          createdAt: 123,
        }),
      }),
    );
  });

  it('clears materialized localId state when a durable stream checkpoint arrives as message-updated', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createSocketStub({ emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSession());
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'Hello' } as any,
      { localId: 'segment-1' },
    );

    expect((client as any).committedLocalIdsAwaitingEcho.has('segment-1')).toBe(true);

    const updateHandler = sessionSocketStub.handlers.get('update');
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
