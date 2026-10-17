import { describe, expect, it, vi } from 'vitest';

import {
  createHostRuntimeActivityProjection,
  createInitialHostRuntimeActivityMutation,
} from './createHostRuntimeActivityProjection';

describe('createHostRuntimeActivityProjection', () => {
  it('keeps supported hosts unknown until the bound provider reports its first snapshot', async () => {
    const enqueue = vi.fn(async () => undefined);
    const projection = createHostRuntimeActivityProjection({
      sessionId: 'session-1', agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: enqueue,
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    await projection.reofferCurrentSnapshot();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
    }));
    await runtime.observeEvent({ kind: 'runtime-activity-snapshot', sessionId: 'session-1',
      sequence: 1, emittedAtMs: 1, state: 'idle', activeCount: 0 });
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
    const publicationFailures: unknown[] = [];
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
      onPublicationError: (error) => { publicationFailures.push(error); },
    });
    const runtime = projection.bindAgentRuntime({ applicability: 'supported' });
    const active = {
      kind: 'runtime-activity-snapshot',
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'active',
      activeCount: 1,
    } as const;

    const failedPublications = await Promise.allSettled([
      runtime.observeEvent({ ...active, sequence: 1 }),
      runtime.observeEvent({ ...active, sequence: 2 }),
    ]);
    expect(failedPublications).toEqual([
      { status: 'rejected', reason: enqueueFailure },
      { status: 'rejected', reason: enqueueFailure },
    ]);
    expect(publicationFailures).toEqual([enqueueFailure]);
    await runtime.observeEvent({ ...active, sequence: 3 });
    await runtime.observeEvent({
      ...active,
      sequence: 4,
      emittedAtMs: 2,
      state: 'idle',
      activeCount: 0,
    });

    expect(publicationFailures).toEqual([enqueueFailure]);
    expect(enqueue.mock.calls.map(([mutation]) => mutation.op)).toEqual([
      { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
      { kind: 'set', value: { state: 'active', activeCount: 1 } },
      { kind: 'set', value: { state: 'active', activeCount: 1 } },
      { kind: 'set', value: { state: 'idle', activeCount: 0 } },
    ]);
  });

  it('observes construction publication rejection through the fire-and-forget boundary', async () => {
    const enqueueFailure = new Error('construction enqueue rejected');
    const onPublicationError = vi.fn();

    createHostRuntimeActivityProjection({
      sessionId: 'session-1',
      agentRuntimeApplicability: 'supported',
      enqueueRegisteredSessionStateFieldMutation: async () => {
        throw enqueueFailure;
      },
      onPublicationError,
    });

    await vi.waitFor(() => expect(onPublicationError).toHaveBeenCalledWith(enqueueFailure, { state: 'unknown', activeCount: 0 }));
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
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
    }));
    const successor = projection.bindAgentRuntime({ applicability: 'supported' });
    await predecessor.observeEvent({ ...activeEvent, sequence: 2, activeCount: 9 });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
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
    await projection.reofferCurrentSnapshot();
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
      op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
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
    await projection.reofferCurrentSnapshot();
    projection.notifyRuntimeDetached();
    projection.notifyTransportDisconnected();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

});
