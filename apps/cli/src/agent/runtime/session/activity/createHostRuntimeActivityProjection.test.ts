import { describe, expect, it, vi } from 'vitest';

import {
  createHostRuntimeActivityProjection,
  createInitialHostRuntimeActivityMutation,
  resolveAgentRuntimeActivitySubscriber,
} from './createHostRuntimeActivityProjection';

describe('createHostRuntimeActivityProjection', () => {
  it('starts supported hosts unknown until the current-runtime observer binds, then publishes idle', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });

    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
    }));

    projection.bindAgentRuntime({ applicability: 'supported' });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    }));
  });

  it('creates the synchronous construction baseline solely from current applicability', () => {
    expect(createInitialHostRuntimeActivityMutation({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      observedAt: 100,
    })).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      mutationId: 'runtime-activity-snapshot:session-1',
      fieldId: 'runtime.activity',
      observedAt: 100,
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
    }));
    expect(createInitialHostRuntimeActivityMutation({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'not_applicable',
      observedAt: 100,
    })).toEqual(expect.objectContaining({
      op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    }));
  });

  it('owns exactly the agent-runtime and execution-run slots with bounded mixed aggregation', async () => {
    const enqueue = vi.fn(async (_mutation: { mutationId: string }) => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    const executionRuns = projection.bindExecutionRuns();

    await runtime.observeEvent({
      kind: 'runtime-activity-snapshot',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 2,
    });
    await executionRuns.observeSnapshot({ state: 'active', activeCount: 3 });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'active', activeCount: 5 } },
    }));

    await executionRuns.observeSnapshot({ state: 'idle', activeCount: 0 });
    expect(enqueue.mock.calls.every(([mutation]) =>
      mutation.mutationId === 'runtime-activity-snapshot:session-1')).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
    }));
  });

  it('retries an identical snapshot after enqueue rejection and continues publishing later state', async () => {
    const enqueueFailure = new Error('durable enqueue rejected');
    let rejectFirstActive = true;
    const enqueue = vi.fn(async (mutation: Parameters<
      Parameters<typeof createHostRuntimeActivityProjection>[0]['enqueueRegisteredSessionStateFieldMutation']
    >[0]) => {
      const value = mutation.op.kind === 'set'
        && typeof mutation.op.value === 'object'
        && mutation.op.value !== null
        ? mutation.op.value as Readonly<{ state?: unknown }>
        : null;
      if (value?.state === 'active'
        && rejectFirstActive) {
        rejectFirstActive = false;
        throw enqueueFailure;
      }
    });
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    const active = {
      kind: 'runtime-activity-snapshot',
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 1,
    } as const;

    await expect(runtime.observeEvent({ ...active, sequence: 1 })).rejects.toBe(enqueueFailure);
    await runtime.observeEvent({ ...active, sequence: 2 });
    await runtime.observeEvent({
      ...active,
      sequence: 3,
      emittedAtMs: 2,
      state: 'idle',
      activeCount: 0,
    });

    expect(enqueue.mock.calls.map(([mutation]) => mutation.op)).toEqual([
      { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
      { kind: 'set', value: { state: 'idle', activeCount: 0 } },
      { kind: 'set', value: { state: 'active', activeCount: 1 } },
      { kind: 'set', value: { state: 'active', activeCount: 1 } },
      { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    ]);
  });

  it('observes construction publication rejection through the fire-and-forget boundary', async () => {
    const enqueueFailure = new Error('construction enqueue rejected');
    const onFireAndForgetPublicationError = vi.fn();

    createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: async () => {
        throw enqueueFailure;
      },
      onFireAndForgetPublicationError,
    });

    await vi.waitFor(() => expect(onFireAndForgetPublicationError).toHaveBeenCalledWith(enqueueFailure));
  });

  it.each([
    ['not_applicable', 'idle'],
    ['unavailable', 'unknown'],
  ] as const)('uses a %s baseline of %s without binding a provider observer', (applicability, state) => {
    const enqueue = vi.fn(async () => undefined);
    createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: applicability,
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state, activeCount: 0 } },
    }));
  });

  it('fences the retired binding and starts replacement with a new empty current-runtime scope', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const predecessor = projection.bindAgentRuntime({ applicability: 'supported' });
    const activeEvent = {
      kind: 'runtime-activity-snapshot',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 1,
    } as const;
    await predecessor.observeEvent(activeEvent);

    await predecessor.revoke();
    const successor = projection.bindAgentRuntime({ applicability: 'supported' });
    await predecessor.observeEvent({ ...activeEvent, sequence: 2, activeCount: 9 });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    }));

    await successor.observeEvent({ ...activeEvent, sequence: 3, activeCount: 2 });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
    }));

    projection.dispose();
    await successor.observeEvent({ ...activeEvent, sequence: 4, activeCount: 3 });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
    }));
  });

  it('reoffers the retained current snapshot without changing Activity truth', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    await runtime.observeEvent({
      kind: 'runtime-activity-snapshot',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 2,
    });
    const callsBeforeReoffer = enqueue.mock.calls.length;

    await projection.reofferCurrentSnapshot();

    expect(enqueue).toHaveBeenCalledTimes(callsBeforeReoffer + 1);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
    }));
  });

  it('ignores runtime snapshots scoped to another session', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    const callsBeforeForeignSnapshot = enqueue.mock.calls.length;

    await runtime.observeEvent({
      kind: 'runtime-activity-snapshot',
      sequence: 1,
      sessionId: 'session-2',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 1,
    });

    expect(enqueue).toHaveBeenCalledTimes(callsBeforeForeignSnapshot);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    }));
  });

  it('does not fabricate a transition from generic detach or transport lifecycle', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    projection.bindAgentRuntime({ applicability: 'supported' });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    projection.notifyRuntimeDetached();
    projection.notifyTransportDisconnected();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it.each([
    'unavailable',
    'not_applicable',
  ] as const)('does not bind a producer-shaped method when applicability is %s', (applicability) => {
    const subscribe = vi.fn(() => () => undefined);
    expect(resolveAgentRuntimeActivitySubscriber({
      applicability,
      subscribeCanonicalAgentSessionEvents: subscribe,
    })).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('fails configuration when supported applicability has no activated producer', () => {
    expect(() => resolveAgentRuntimeActivitySubscriber({
      applicability: 'supported',
    })).toThrow(/activated.*producer/i);
  });

  it('returns the activated producer when applicability is supported', () => {
    const subscribe = vi.fn(() => () => undefined);
    expect(resolveAgentRuntimeActivitySubscriber({
      applicability: 'supported',
      subscribeCanonicalAgentSessionEvents: subscribe,
    })).toBe(subscribe);
  });
});
