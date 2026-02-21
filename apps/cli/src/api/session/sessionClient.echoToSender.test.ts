import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/api/types';

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
    emit: (...args: any[]) => void;
    timeout: (ms: number) => any;
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
  };
  calls: { emitWithAck: EmitWithAckCall[] };
};

function createSocketStub(opts: { emitWithAckResult: unknown }): SocketStub {
  const calls: { emitWithAck: EmitWithAckCall[] } = { emitWithAck: [] };

  const socket: SocketStub['socket'] = {
    id: 'sock-1',
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async (event: string, payload: unknown) => {
      calls.emitWithAck.push({ event, payload });
      return opts.emitWithAckResult;
    }),
  };

  return { socket, calls };
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

describe('ApiSessionClient socket message commits', () => {
  it('requests sender echo so broadcasts can clear pending localIds', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' } });
    userSocketStub = createSocketStub({ emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array([1, 2, 3]),
      encryptionVariant: 'legacy',
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

    const client = new ApiSessionClient('tok', session);
    await client.sendUserTextMessageCommitted('hello', { localId: 'l1' });

    expect(sessionSocketStub.calls.emitWithAck.length).toBe(1);
    expect(sessionSocketStub.calls.emitWithAck[0]!.event).toBe('message');
    expect(sessionSocketStub.calls.emitWithAck[0]!.payload).toMatchObject({ echoToSender: true });
  });
});
