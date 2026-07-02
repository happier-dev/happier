import { afterEach, describe, expect, it, vi } from 'vitest';

type SocketHandler = (value: unknown) => void;

function createSocketStub() {
  const handlers = new Map<string, Set<SocketHandler>>();
  const on = (event: string, handler: SocketHandler) => {
    const set = handlers.get(event) ?? new Set<SocketHandler>();
    set.add(handler);
    handlers.set(event, set);
  };
  const off = (event: string, handler: SocketHandler) => {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(handler);
  };
  const emit = (event: string, value: unknown) => {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      handler(value);
    }
  };
  return {
    on,
    off,
    connect: () => undefined,
    disconnect: () => undefined,
    close: () => undefined,
    emit,
  };
}

describe('waitForIdleViaSocket', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('resolves idle when initially busy but recheckTurnActivity confirms idle without socket updates', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const busyAgentStateCiphertext = JSON.stringify({ controlledByUser: false, requests: { r1: { createdAt: 1 } } });
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: false, turnInFlight: true },
      recheckTurnActivity: async () => ({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false }),
      initialAgentStateCiphertextBase64: busyAgentStateCiphertext,
    });

    // Advance past the socket wait deadline; without the busy recheck logic this will reject with `timeout`.
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('keeps waiting when a fresh recheck still reports busy agent state', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const busyAgentStateCiphertext = JSON.stringify({ controlledByUser: false, requests: { r1: { createdAt: 1 } } });
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: busyAgentStateCiphertext,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: false, turnInFlight: true },
      recheckTurnActivity: async () => ({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false }),
      initialAgentStateCiphertextBase64: busyAgentStateCiphertext,
    });

    const rejection = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1_500);
    await rejection;
  });

  it('treats a completion event as idle when only a stale initial busy snapshot remains after reconnect', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: JSON.stringify({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }),
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: true, turnInFlight: true },
      recheckTurnActivity: async () => ({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false }),
      initialAgentStateCiphertextBase64: JSON.stringify({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }),
    });

    socket.emit('update', {
      id: 'u_task_complete_stale_busy',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-1',
          seq: 1,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'opencode',
                data: { type: 'task_complete', id: 'task-1' },
              },
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('resolves idle from update-session projection without message decrypt', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const decrypt = vi.fn(() => null);
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/api/encryption', () => ({
      decodeBase64: vi.fn(() => new Uint8Array()),
      decrypt,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: true, turnInFlight: true },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
    });

    socket.emit('update', {
      id: 'u_message_with_encrypted_content',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-1',
          seq: 1,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: { t: 'encrypted', c: 'ciphertext' },
        },
      },
    });
    socket.emit('update', {
      id: 'u_task_complete_projection',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('resolves idle from terminal projection updates that omit pending counts', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const decrypt = vi.fn(() => null);
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/api/encryption', () => ({
      decodeBase64: vi.fn(() => new Uint8Array()),
      decrypt,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: true, turnInFlight: true },
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
    });

    socket.emit('update', {
      id: 'u_terminal_projection',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: Date.now(),
      },
    });

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
    expect(decrypt).not.toHaveBeenCalled();
  });
});
