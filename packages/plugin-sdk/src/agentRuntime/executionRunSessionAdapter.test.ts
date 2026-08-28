import { describe, expect, it, vi } from 'vitest';

import {
  createExecutionRunHostBackendFromSessionRuntime as createSessionRunAdapter,
  type AgentExecutionRunEvent,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunSessionAdapterOptions,
} from './executionRun.js';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from './session.js';

type SessionSend = AgentSessionRuntime['send'];
type SessionCancel = NonNullable<AgentSessionRuntime['cancel']>;
type SessionWatch = AgentSessionRuntime['watch'];

function createExecutionRunHostBackendFromSessionRuntime(
  options: Omit<AgentExecutionRunSessionAdapterOptions, 'sessionId'>,
) {
  return createSessionRunAdapter({ ...options, sessionId: 'session-1' });
}

function createRequest(runId = 'run-1'): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  return {
    kind: 'create',
    runId,
    cwd: '/repo',
    profile: { pluginId: 'happier.agent.test', localId: 'default' },
    input: { text: 'Start the run.' },
  };
}

function createResumeRequest(runId = 'run-resume'): Extract<AgentExecutionRunOpenRequest, { kind: 'resume' }> {
  return {
    kind: 'resume',
    runId,
    cwd: '/repo',
    profile: { pluginId: 'happier.agent.test', localId: 'default' },
    checkpointId: 'provider-checkpoint-1',
  };
}

function createSessionHarness(sessionId = 'session-1') {
  const listeners = new Set<Parameters<SessionWatch>[0]>();
  const sendCalls: Parameters<SessionSend>[] = [];
  const cancelCalls: Parameters<SessionCancel>[] = [];
  let subscriptionDisposeCalls = 0;
  let sessionDisposeCalls = 0;
  let send: SessionSend = async () => ({ status: 'admitted' });
  let cancel: SessionCancel = async (request) => ({ status: 'requested', turnId: request.turnId });

  const session: AgentSessionRuntime = {
    async send(request, options) {
      sendCalls.push([request, options]);
      return await send(request, options);
    },
    async cancel(request, options) {
      cancelCalls.push([request, options]);
      return await cancel(request, options);
    },
    watch(listener) {
      listeners.add(listener);
      return {
        dispose() {
          subscriptionDisposeCalls += 1;
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      sessionDisposeCalls += 1;
    },
  };

  return {
    session,
    sendCalls,
    cancelCalls,
    get watchCalls() {
      return listeners.size;
    },
    get subscriptionDisposeCalls() {
      return subscriptionDisposeCalls;
    },
    get sessionDisposeCalls() {
      return sessionDisposeCalls;
    },
    setSend(implementation: SessionSend) {
      send = implementation;
    },
    setCancel(implementation: SessionCancel) {
      cancel = implementation;
    },
    publish(event: AgentSessionRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function providerSessionIdEvent(): AgentSessionRuntimeEvent {
  return {
    sequence: 1,
    sessionId: 'session-1',
    emittedAtMs: 10,
    kind: 'provider-session-id',
    providerSessionId: 'provider-checkpoint-1',
  };
}

function outputEvent(turnId: string): AgentSessionRuntimeEvent {
  return {
    sequence: 2,
    sessionId: 'session-1',
    emittedAtMs: 11,
    turnId,
    kind: 'message-delta',
    channel: 'assistant',
    text: 'early output',
  };
}

function completeEvent(turnId: string): AgentSessionRuntimeEvent {
  return {
    sequence: 3,
    sessionId: 'session-1',
    emittedAtMs: 12,
    turnId,
    kind: 'turn-complete',
  };
}

function failedEvent(turnId: string): AgentSessionRuntimeEvent {
  return {
    sequence: 4,
    sessionId: 'session-1',
    emittedAtMs: 13,
    turnId,
    kind: 'turn-failed',
    diagnostic: { code: 'late_failure', severity: 'error' },
  };
}

describe('createExecutionRunHostBackendFromSessionRuntime', () => {
  it('terminalizes rejected initial admission, clears cancellation state, and disposes once', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => ({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'initial_rejected', severity: 'error' },
    }));

    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest(),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-failed']);
    expect(events.filter((event) => (
      event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled'
    ))).toHaveLength(1);
    await expect(execution.stop()).resolves.toEqual({ status: 'notRunning' });
    expect(harness.cancelCalls).toEqual([]);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);

    await execution.dispose();
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('publishes run-start before a synchronously replayed Session checkpoint', async () => {
    const session: AgentSessionRuntime = {
      async send() {
        return { status: 'admitted' };
      },
      watch(listener) {
        listener(providerSessionIdEvent());
        return { dispose() {} };
      },
      async dispose() {},
    };

    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-synchronous-replay'),
      openSession: async (request) => {
        expect(request.sessionId).toBe('session-1');
        return session;
      },
      readCheckpointId: (event) => event.kind === 'provider-session-id'
        ? event.providerSessionId
        : null,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'checkpoint']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    await execution.dispose();
  });

  it('subscribes before initial send, replays early mapped output, and ignores a second terminal', async () => {
    const harness = createSessionHarness();
    const request = createRequest('run-replay');
    harness.setSend(async (sendRequest) => {
      expect(harness.watchCalls).toBe(1);
      const turnId = sendRequest.delivery.turnId;
      harness.publish(providerSessionIdEvent());
      harness.publish(outputEvent('stale-turn'));
      harness.publish(outputEvent(turnId));
      harness.publish(completeEvent(turnId));
      return { status: 'admitted' };
    });

    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request,
      openSession: async () => harness.session,
      readCheckpointId: (event) => event.kind === 'provider-session-id'
        ? event.providerSessionId
        : null,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));
    harness.publish(failedEvent('run-replay-turn-1'));

    expect(harness.sendCalls).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual([
      'run-start',
      'checkpoint',
      'output-delta',
      'run-complete',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.filter((event) => (
      event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled'
    ))).toHaveLength(1);
  });

  it('disposes an opened Session when subscription setup throws', async () => {
    let disposeCalls = 0;
    const session: AgentSessionRuntime = {
      async send() {
        return { status: 'admitted' };
      },
      watch() {
        throw new Error('watch setup failed');
      },
      async dispose() {
        disposeCalls += 1;
      },
    };

    await expect(createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest(),
      openSession: async () => session,
    })).rejects.toThrow('watch setup failed');
    expect(disposeCalls).toBe(1);
  });

  it('disposes an opened Session if initial send throws', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => {
      throw new Error('initial send failed');
    });

    await expect(createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest(),
      openSession: async () => harness.session,
    })).rejects.toThrow('initial send failed');
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('terminalizes and disposes a resumed Run if its first send throws', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => {
      throw new Error('resumed send failed');
    });
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createResumeRequest('run-resumed-send-failure'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.send({ text: 'Continue the run.' })).rejects.toThrow('resumed send failed');

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-failed']);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('isolates a throwing Run subscriber so later listeners receive terminal truth and cleanup settles', async () => {
    const harness = createSessionHarness();
    harness.setSend(async (request) => {
      harness.publish(completeEvent(request.delivery.turnId));
      return { status: 'admitted' };
    });
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createResumeRequest('run-listener-isolation'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => {
      if (event.kind === 'run-complete') throw new Error('subscriber failed');
    });
    execution.watch((event) => events.push(event));

    await expect(execution.send({ text: 'Continue.' })).resolves.toEqual({ status: 'admitted' });
    await vi.waitFor(() => expect(harness.sessionDisposeCalls).toBe(1));

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-complete']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(harness.subscriptionDisposeCalls).toBe(1);
  });

  it('keeps one finite active turn and refuses a second send without losing terminal correlation', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-one-turn'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.send({ text: 'Second turn must not start.' })).resolves.toEqual({
      status: 'unavailable',
    });
    harness.publish(completeEvent('run-one-turn-turn-1'));

    expect(harness.sendCalls).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-complete']);
  });

  it('routes stop through Session cancellation and cleans the subscription and Session once', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-cancel'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.stop()).resolves.toEqual({ status: 'requested' });
    expect(harness.cancelCalls).toEqual([[
      { turnId: 'run-cancel-turn-1', reason: 'user' },
      undefined,
    ]]);
    harness.publish({
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 12,
      turnId: 'run-cancel-turn-1',
      kind: 'turn-cancelled',
      cause: 'user',
    });
    await execution.dispose();
    await execution.dispose();

    expect(events.filter((event) => event.kind === 'run-cancelled')).toHaveLength(1);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('does not terminalize an admitted Run until requested Session cancellation emits terminal truth', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-silent-cancel'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.stop()).resolves.toEqual({ status: 'requested' });

    expect(events.map((event) => event.kind)).toEqual(['run-start']);
    expect(harness.subscriptionDisposeCalls).toBe(0);
    expect(harness.sessionDisposeCalls).toBe(0);
    harness.publish({
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 12,
      turnId: 'run-silent-cancel-turn-1',
      kind: 'turn-cancelled',
      cause: 'user',
    });
    await vi.waitFor(() => expect(harness.sessionDisposeCalls).toBe(1));
    expect(events.filter((event) => event.kind === 'run-cancelled')).toHaveLength(1);
  });

  it.each([
    ['input-rejected', { diagnostic: { code: 'async_rejected', severity: 'error' as const }, retryable: false }],
    ['input-custody-unknown', { issue: { code: 'custody_unknown', severity: 'error' as const } }],
    ['input-delivery-failed', {
      delivery: { kind: 'newTurn' as const, turnId: 'run-input-failure-turn-1' },
      issue: { code: 'delivery_failed', severity: 'error' as const },
      duplicateRisk: 'unknown' as const,
    }],
  ] as const)('maps correlated asynchronous %s to one failed Run and releases the Session', async (kind, details) => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-input-failure'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    harness.publish({
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 13,
      kind,
      inputIds: ['run-input-failure-input-1'],
      ...details,
    } as AgentSessionRuntimeEvent);

    await vi.waitFor(() => expect(harness.sessionDisposeCalls).toBe(1));
    const expectedDiagnostic = 'diagnostic' in details
      ? details.diagnostic
      : details.issue;
    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-failed']);
    expect(events.at(-1)).toMatchObject({
      kind: 'run-failed',
      diagnostic: expectedDiagnostic,
    });
    expect(harness.subscriptionDisposeCalls).toBe(1);
  });

  it('maps a pre-terminal runtime-ended event to one failed Run and releases the Session', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-runtime-ended'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    harness.publish({
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 13,
      kind: 'runtime-ended',
      cause: 'processExited',
      retryable: false,
      diagnostic: { code: 'provider_exited', severity: 'error' },
    });

    await vi.waitFor(() => expect(harness.sessionDisposeCalls).toBe(1));
    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-failed']);
    expect(events.at(-1)).toMatchObject({ diagnostic: { code: 'provider_exited' } });
    expect(harness.subscriptionDisposeCalls).toBe(1);
  });

  it('terminalizes and disposes when Session cancellation reports the active turn is no longer running', async () => {
    const harness = createSessionHarness();
    harness.setCancel(async () => ({ status: 'notRunning' }));
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-already-stopped'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.stop()).resolves.toEqual({ status: 'notRunning' });

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-cancelled']);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
    await execution.dispose();
    expect(events.filter((event) => event.kind === 'run-cancelled')).toHaveLength(1);
  });

  it('terminalizes an admitted Run before disposing a silent Session', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createRequest('run-silent-dispose'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await execution.dispose();

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-cancelled']);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('terminalizes a resumed Run disposed before its first send and keeps reentrant cleanup idempotent', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromSessionRuntime({
      request: createResumeRequest('run-resume-dispose'),
      openSession: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => {
      events.push(event);
      if (event.kind === 'run-cancelled') void execution.dispose();
    });

    await execution.dispose();

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'run-cancelled']);
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });
});
