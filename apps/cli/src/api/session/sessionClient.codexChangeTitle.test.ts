import { describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  createApiSessionSocketStub,
  flushApiSessionClientMessageCommitQueue,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

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

import { ApiSessionClient } from './sessionClient';

describe('ApiSessionClient sendCodexMessage change_title', () => {
  it('does not update session metadata summary when Codex emits a change_title tool call (action handlers own metadata updates)', async () => {
    const emitted: Array<{ event: string; payload: any }> = [];

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload: any) => {
        emitted.push({ event, payload });
        if (event === 'update-metadata') {
          return { result: 'success', metadata: payload.metadata, version: (payload.expectedVersion ?? 0) + 1 };
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendCodexMessage({
      type: 'tool-call',
      name: 'change_title',
      callId: 'call-1',
      input: { title: 'New title' },
      id: 'msg-1',
    });

    await flushApiSessionClientMessageCommitQueue(client as any);
    await new Promise((r) => setTimeout(r, 0));

    const metadataCalls = emitted.filter((e) => e.event === 'update-metadata');
    expect(metadataCalls).toHaveLength(0);
  });
});
