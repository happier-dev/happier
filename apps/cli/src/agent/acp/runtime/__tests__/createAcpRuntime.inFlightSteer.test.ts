import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (in-flight steer)', () => {
  it('exposes turn-in-flight state and steerPrompt when enabled', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    expect(typeof (runtime as any).supportsInFlightSteer).toBe('function');
    expect((runtime as any).supportsInFlightSteer()).toBe(true);

    expect(typeof (runtime as any).isTurnInFlight).toBe('function');
    expect((runtime as any).isTurnInFlight()).toBe(false);

    runtime.beginTurn();
    expect((runtime as any).isTurnInFlight()).toBe(true);

    await (runtime as any).startOrLoad({});
    await (runtime as any).steerPrompt('steer text');

    expect(backend.sendSteerPrompt).toHaveBeenCalledWith('sess_1', 'steer text');

    await runtime.flushTurn();
    expect((runtime as any).isTurnInFlight()).toBe(false);
  });

  it('forwards steerPrompt delivery identity to the backend when provided', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});
    const confirmUserMessageDeliveredToProvider = vi.fn();

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({
        confirmUserMessageDeliveredToProvider,
      } as any),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    await (runtime as any).startOrLoad({});
    await (runtime as any).steerPrompt('steer text', {
      localId: 'local-1',
      localIds: ['local-1'],
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });

    expect(backend.sendSteerPrompt).toHaveBeenCalledWith('sess_1', 'steer text', {
      localId: 'local-1',
      localIds: ['local-1'],
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
    expect(confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith(1, {
      localIds: ['local-1'],
    });
  });

  it('does not leak pendingQueue metadata listeners when poll wake wins', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});

    let activeMetadataWaits = 0;
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
      pendingQueue: {
        drainDuringTurn: true,
        pollIntervalMs: 5,
        inputConsumer: {
          drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' }),
        },
        waitForMetadataUpdate: async (signal?: AbortSignal) => {
          activeMetadataWaits += 1;
          return await new Promise<boolean>((resolve) => {
            const onAbort = () => {
              activeMetadataWaits -= 1;
              resolve(false);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
      },
    } as any);

    runtime.beginTurn();
    await (runtime as any).startOrLoad({});

    // Let the pump spin a few times. If poll wake does not cancel the metadata wait,
    // this counter will grow quickly and trip the assertion.
    await vi.waitFor(
      () => {
        expect(activeMetadataWaits).toBeLessThanOrEqual(1);
      },
      { timeout: 250 },
    );

    await runtime.flushTurn();
    await vi.waitFor(() => {
      expect(activeMetadataWaits).toBe(0);
    });
  });

  it('publishes in-flight steer capability state for UI submit routing', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});
    let agentState: any = { requests: {}, completedRequests: {} };
    const session = createBasicSessionClientWithOverrides({
      updateAgentState: (updater: (state: any) => any) => {
        agentState = updater(agentState);
      },
    } as any);

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    expect(agentState.capabilities).toMatchObject({
      inFlightSteer: true,
      inFlightSteerSupported: true,
      inFlightSteerAvailable: false,
    });

    runtime.beginTurn();
    expect(agentState.capabilities).toMatchObject({
      inFlightSteer: true,
      inFlightSteerSupported: true,
      inFlightSteerAvailable: true,
    });

    await runtime.flushTurn();
    expect(agentState.capabilities).toMatchObject({
      inFlightSteer: true,
      inFlightSteerSupported: true,
      inFlightSteerAvailable: false,
    });
  });

  it('throws when sendSteerPrompt is unavailable', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendPrompt = vi.fn(async () => {});

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    runtime.beginTurn();
    await (runtime as any).startOrLoad({});
    await expect((runtime as any).steerPrompt('steer fallback')).rejects.toThrow(
      /does not support in-flight steer/i,
    );

    expect(backend.sendPrompt).not.toHaveBeenCalled();

    await runtime.flushTurn();
  });
});

describe('createAcpRuntime (in-flight steer unavailable-reason seam, lane P)', () => {
  function createRuntimeWithStateCapture(enabled: boolean) {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});
    let state: any = {};
    const session = createBasicSessionClientWithOverrides({
      updateAgentState: ((updater: any) => {
        state = updater(state);
      }) as any,
    } as any);
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled },
    } as any);
    return { runtime, getState: () => state };
  }

  it('publishes backend_unsupported when in-flight steer is disabled', () => {
    const { getState } = createRuntimeWithStateCapture(false);
    expect(getState().capabilities?.inFlightSteerUnavailableReason).toBe('backend_unsupported');
    expect(typeof getState().capabilities?.inFlightSteerStateAt).toBe('number');
  });

  it('publishes unsafe_window between turns and clears the reason while a turn is in flight', async () => {
    const { runtime, getState } = createRuntimeWithStateCapture(true);

    expect(getState().capabilities?.inFlightSteerAvailable).toBe(false);
    expect(getState().capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');

    runtime.beginTurn();
    expect(getState().capabilities?.inFlightSteerAvailable).toBe(true);
    expect(getState().capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();

    await runtime.flushTurn();
    expect(getState().capabilities?.inFlightSteerAvailable).toBe(false);
    expect(getState().capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
  });
});
