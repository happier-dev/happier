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
      initialTurnActivity: { pendingUserTurns: 1, activeTaskInFlight: false, turnInFlight: true },
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
                agentId: 'opencode',
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

  it('waits through pending-input materialization until the successor turn reaches a terminal projection', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({ agentState: null }),
    }));

    const { waitForIdleViaSocket } = await import('./sessionSocketAgentState');

    const promise = waitForIdleViaSocket({
      token: 'token',
      sessionId: 'sess-1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
      sessionEncryptionMode: 'plain',
      timeoutMs: 1_000,
      initialTurnActivity: { pendingUserTurns: 0, activeTaskInFlight: false, turnInFlight: false },
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    socket.emit('update', {
      id: 'u_pending_input',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 'sess-1',
        sessionId: 'sess-1',
        pendingCount: 1,
        pendingVersion: 1,
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    socket.emit('update', {
      id: 'u_pending_materialized',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 'sess-1',
        sessionId: 'sess-1',
        pendingCount: 0,
        pendingVersion: 2,
      },
    });
    socket.emit('update', {
      id: 'u_successor_task_started',
      seq: 3,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-successor-task-started',
          seq: 3,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'task_started', id: 'task-successor' },
              },
            },
          },
        },
      },
    });
    socket.emit('update', {
      id: 'u_successor_active',
      seq: 4,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'in_progress',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    socket.emit('update', {
      id: 'u_successor_completed',
      seq: 5,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('does not let a pending-input recheck resolve through delivery before the successor turn starts', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById: vi.fn().mockResolvedValue({
        agentState: null,
        latestTurnStatus: null,
        pendingCount: 0,
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
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // The server clears queued pending count when the row is claimed for delivery; no successor
    // lifecycle projection exists yet. That is not idle evidence.
    socket.emit('update', {
      id: 'u_pending_claimed',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 'sess-1',
        sessionId: 'sess-1',
        pendingCount: 0,
        pendingVersion: 2,
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    socket.emit('update', {
      id: 'u_successor_task_started_after_claim',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-successor-task-started-after-claim',
          seq: 2,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'task_started', id: 'task-successor-after-claim' },
              },
            },
          },
        },
      },
    });
    socket.emit('update', {
      id: 'u_successor_active_after_claim',
      seq: 3,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'in_progress',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    socket.emit('update', {
      id: 'u_successor_completed_after_claim',
      seq: 4,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('does not let a bare ready event consume an unstarted pending user turn when disabled', async () => {
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
      initialAgentStateCiphertextBase64: JSON.stringify({ controlledByUser: false, requests: {} }),
      readyCompletesPendingUserTurns: false,
    });

    let settled = false;
    void promise.finally(() => {
      settled = true;
    });

    socket.emit('update', {
      id: 'u_stale_ready',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-stale-ready',
          seq: 1,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                id: 'ready_evt_before_turn_start',
                type: 'event',
                data: { type: 'ready' },
              },
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);

    socket.emit('update', {
      id: 'u_task_started',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-task-started',
          seq: 2,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'task_started', id: 'task-1' },
              },
            },
          },
        },
      },
    });

    socket.emit('update', {
      id: 'u_task_complete',
      seq: 3,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-task-complete',
          seq: 3,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'task_complete', id: 'task-1' },
              },
            },
          },
        },
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('uses terminal turn projection after stale ready once agent output is observed', async () => {
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
      initialAgentStateCiphertextBase64: JSON.stringify({ controlledByUser: false, requests: {} }),
      readyCompletesPendingUserTurns: false,
    });

    socket.emit('update', {
      id: 'u_stale_ready',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-stale-ready',
          seq: 1,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                id: 'ready_evt_before_agent_output',
                type: 'event',
                data: { type: 'ready' },
              },
            },
          },
        },
      },
    });
    socket.emit('update', {
      id: 'u_agent_message',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-agent-message',
          seq: 2,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'message', message: 'done' },
              },
            },
          },
        },
      },
    });
    socket.emit('update', {
      id: 'u_terminal_projection',
      seq: 3,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        id: 'sess-1',
        latestTurnStatus: 'completed',
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('allows ready to settle a pending user turn after agent output was observed when bare ready is disabled', async () => {
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
      initialAgentStateCiphertextBase64: JSON.stringify({ controlledByUser: false, requests: {} }),
      readyCompletesPendingUserTurns: false,
    });

    socket.emit('update', {
      id: 'u_agent_text',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-agent-text',
          seq: 1,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: { type: 'text', text: 'current answer' },
            },
          },
        },
      },
    });

    socket.emit('update', {
      id: 'u_ready_after_agent_text',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess-1',
        message: {
          id: 'msg-ready-after-agent-text',
          seq: 2,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                id: 'ready-after-agent-text',
                type: 'event',
                data: { type: 'ready' },
              },
            },
          },
        },
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({ idle: true, observedAt: expect.any(Number) }));
  });

  it('does not let projection-only completion resolve while transcript recheck is still busy', async () => {
    vi.useFakeTimers();

    const socket = createSocketStub();
    const recheckTurnActivity = vi.fn(async () => ({
      pendingUserTurns: 1,
      activeTaskInFlight: false,
      turnInFlight: true,
    }));
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
      recheckTurnActivity,
      initialAgentStateSummary: { pendingRequestsCount: 0 },
      initialAgentStateCiphertextBase64: null,
      preferProjectionUpdates: true,
      initialTurnActivityRequiresTranscriptIdleEvidence: true,
    });

    const rejection = expect(promise).rejects.toThrow('timeout');

    socket.emit('update', {
      id: 'u_completed_projection',
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
    expect(recheckTurnActivity).toHaveBeenCalled();
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
