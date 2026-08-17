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
      initialAgentStateCiphertextBase64: null,
    });

    // Advance past the socket wait deadline; without the busy recheck logic this will reject with `timeout`.
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('does not resolve initially idle when the confirmation recheck fails', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const recheckTurnActivity = vi.fn(async () => {
      throw new Error('transcript unavailable');
    });
    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false },
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      recheckTurnActivity,
      initialAgentStateCiphertextBase64: null,
    });
    const timeoutExpectation = expect(promise).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(300);

    expect(recheckTurnActivity).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await timeoutExpectation;
  });

  it('keeps waiting when the busy-turn recheck fetch returns a fresh busy agentState', async () => {
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
      initialAgentStateCiphertextBase64: null,
    });
    const timeoutExpectation = expect(promise).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(1_500);

    await timeoutExpectation;
  });

  it('keeps waiting when the busy-turn recheck fetch fails before any fresh agentState arrives', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockRejectedValue(new Error('transient fetch failure')),
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
      initialAgentStateCiphertextBase64: JSON.stringify({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }),
    });
    const timeoutExpectation = expect(promise).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(1_500);

    await timeoutExpectation;
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

  it('does not resolve from a projection-only completed update while transcript recheck remains busy', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const recheckTurnActivity = vi.fn(async () => ({
      pendingUserTurns: 1,
      activeTaskInFlight: true,
      turnInFlight: true,
    }));
    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: true, turnInFlight: true },
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
      initialTurnActivityRequiresTranscriptIdleEvidence: true,
      recheckTurnActivity,
    });
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    socket.emit('update', {
      id: 'u_projection_completed_without_transcript_idle',
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

    await vi.advanceTimersByTimeAsync(0);

    expect(recheckTurnActivity).toHaveBeenCalled();
    expect(settled).toBe(false);

    const timeoutExpectation = expect(promise).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1_500);
    await timeoutExpectation;
  });

  it('resolves a projection-only completed update after a fresh transcript recheck observes idle', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        agentState: null,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    let resolveRecheck: (activity: { pendingUserTurns: number; activeTaskInFlight: boolean; turnInFlight: boolean }) => void =
      () => undefined;
    const recheckTurnActivity = vi.fn(() => new Promise<{
      pendingUserTurns: number;
      activeTaskInFlight: boolean;
      turnInFlight: boolean;
    }>((resolve) => {
      resolveRecheck = resolve;
    }));
    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: true, turnInFlight: true },
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
      initialTurnActivityRequiresTranscriptIdleEvidence: true,
      recheckTurnActivity,
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    socket.emit('update', {
      id: 'u_projection_completed_after_transcript_idle',
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

    await vi.advanceTimersByTimeAsync(0);

    expect(recheckTurnActivity).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    resolveRecheck?.({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('resolves from transcript ready evidence while projection updates are preferred after transcript-busy evidence', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
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
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
      initialTurnActivityRequiresTranscriptIdleEvidence: true,
    });

    socket.emit('update', {
      id: 'u_ready_after_transcript_busy',
      seq: 3,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-ready',
          seq: 3,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                id: 'ready_evt_socket_projection',
                type: 'event',
                data: { type: 'ready' },
              },
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
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

  it('does not report idle while the fresh AgentState says the Session is controlled by a local user', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const controlledAgentState = JSON.stringify({ controlledByUser: true, requests: {} });
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: controlledAgentState,
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false },
      recheckTurnActivity: async () => ({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false }),
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: controlledAgentState,
      preferProjectionUpdates: true,
    });

    const rejection = expect(promise).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(1_500);

    await rejection;
  });

  it('still reports idle from the projected pending-request count when no local user controls the Session', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const uncontrolledAgentState = JSON.stringify({ controlledByUser: false, requests: {} });
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: uncontrolledAgentState,
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false },
      recheckTurnActivity: async () => ({ pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false }),
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: uncontrolledAgentState,
      preferProjectionUpdates: true,
    });

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('keeps a locally controlled Session busy when a projection update carries no AgentState', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const controlledAgentState = JSON.stringify({ controlledByUser: true, requests: {} });
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: controlledAgentState,
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
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
      initialAgentStateCiphertextBase64: controlledAgentState,
      preferProjectionUpdates: true,
    });

    const rejection = expect(promise).rejects.toThrow('timeout');

    socket.emit('update', {
      id: 'u_completed_projection_without_agent_state',
      seq: 1,
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

    await rejection;
  });
});
