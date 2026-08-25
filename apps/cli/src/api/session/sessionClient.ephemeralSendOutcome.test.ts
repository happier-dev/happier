import { describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { ApiSessionClient } from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as never;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as never,
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
      if (sessionSocketStub?.connected === true) await params.onConnected?.();
    },
    getState: () => ({ phase: sessionSocketStub?.connected === true ? 'online' : 'offline' }),
    reportProbeResult: () => {},
    stop: async () => {},
  }),
}));

describe('ApiSessionClient ephemeral send outcomes', () => {
  it('reports a disconnected send as locally non-accepted', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: false });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const outcome = client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'not sent' },
      { localId: 'segment-1', createdAt: 1_000 },
    );

    expect(outcome).toEqual({
      accepted: false,
      epoch: client.getEphemeralStreamConnectionEpoch(),
      reason: { code: 'socket_disconnected' },
    });
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('transcript-stream-segment', expect.anything());
  });

  it('returns a structured bounded failure when socket emission throws', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event) => {
        if (event === 'transcript-stream-segment') {
          throw new Error(
            'emit failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/live?token=secret',
            { cause: new TypeError('nested failure') },
          );
        }
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await Promise.resolve();

    const outcome = client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'not accepted' },
      { localId: 'segment-1', createdAt: 1_000 },
    );

    expect(outcome).toMatchObject({
      accepted: false,
      epoch: client.getEphemeralStreamConnectionEpoch(),
      reason: {
        code: 'local_failure',
        error: {
          name: 'Error',
          message: 'emit failed for https://api.example.test/live',
          stack: expect.any(String),
          cause: {
            name: 'TypeError',
            message: 'nested failure',
          },
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(outcome)).not.toContain('token=secret');
  });

  it('reports normalization or assistant-observation throws without emitting', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await Promise.resolve();

    const snapshotStore = (client as unknown as {
      turnAssistantTextSnapshotStore: { observe: (candidate: unknown) => void };
    }).turnAssistantTextSnapshotStore;
    snapshotStore.observe = () => {
      throw new Error('snapshot observation failed');
    };

    const outcome = client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'not emitted' },
      { localId: 'segment-1', createdAt: 1_000 },
    );

    expect(outcome).toMatchObject({
      accepted: false,
      reason: {
        code: 'local_failure',
        error: { message: 'snapshot observation failed' },
      },
    });
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('transcript-stream-segment', expect.anything());
  });

  it('reports the current connection epoch only after the complete local send path succeeds', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await Promise.resolve();

    const outcome = client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'accepted' },
      { localId: 'segment-1', createdAt: 1_000 },
    );

    expect(outcome).toEqual({
      accepted: true,
      epoch: client.getEphemeralStreamConnectionEpoch(),
    });
  });
});
