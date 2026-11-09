import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createExecutionRunHostBackendFromConversationRuntime,
  type AgentExecutionRunConversationRuntimeV1,
  type AgentExecutionRunEvent,
  type AgentExecutionRunOpenRequest,
} from './executionRun.js';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from './session.js';

type SessionSend = AgentSessionRuntime['send'];
type SessionCancel = NonNullable<AgentSessionRuntime['cancel']>;
type SessionWatch = AgentSessionRuntime['watch'];
type ConversationSendOptions = NonNullable<Parameters<AgentExecutionRunConversationRuntimeV1['send']>[1]>;

expectTypeOf<ConversationSendOptions>().toHaveProperty('localInputId').toEqualTypeOf<string | undefined>();
expectTypeOf<ConversationSendOptions>().toHaveProperty('resultContract');
expectTypeOf<ConversationSendOptions>().toHaveProperty('causalPermissionAuthority');

function createRequest(runId = 'run-1'): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  return {
    kind: 'create',
    runId,
    cwd: '/repo',
    profile: { pluginId: 'happier.agent.test', localId: 'default' },
    input: { text: 'Start the run.' },
  };
}

const causalPermissionAuthority = Object.freeze({
  kind: 'admittedSessionInputV1' as const,
  admittedPermissionCeiling: 'read-only' as const,
});

it('adapts a scope-neutral provider conversation without manufacturing a Session identity', async () => {
  const send = vi.fn<AgentExecutionRunConversationRuntimeV1['send']>(async () => {
    queueMicrotask(() => {
      for (const listener of listeners) {
        listener({ kind: 'turn-complete', turnId: 'run-1-turn-1' });
      }
    });
    return { status: 'admitted' };
  });
  const listeners = new Set<(event: Parameters<AgentExecutionRunConversationRuntimeV1['watch']>[0] extends (event: infer Event) => void ? Event : never) => void>();
  const conversation: AgentExecutionRunConversationRuntimeV1 = {
    send,
    async cancel(request) {
      return { status: 'requested', turnId: request.turnId };
    },
    watch(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {},
  };

  const request = {
    ...createRequest(),
    localInputId: 'authored-input-1',
    resultContract: { kind: 'json' as const, schema: { type: 'object' as const } },
    causalPermissionAuthority,
  };
  const runtime = await createExecutionRunHostBackendFromConversationRuntime({
    request,
    openConversation: async () => conversation,
  });
  const events: AgentExecutionRunEvent[] = [];
  runtime.watch((event) => { events.push(event); });
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'run-complete')).toBe(true));

  expect(events.every((event) => !('sessionId' in event))).toBe(true);
  expect(events.map((event) => event.runId)).toEqual(['run-1', 'run-1']);
  expect(send).toHaveBeenCalledWith({
    inputIds: ['authored-input-1'],
    input: request.input,
    delivery: { kind: 'newTurn', turnId: 'run-1-turn-1' },
    causalPermissionAuthority,
  }, {
    localInputId: 'authored-input-1',
    resultContract: request.resultContract,
    causalPermissionAuthority,
  });
  await runtime.dispose();
});

it('passes the exact resumed-turn input contract through the neutral conversation seam', async () => {
  const send = vi.fn<AgentExecutionRunConversationRuntimeV1['send']>(async () => ({ status: 'admitted' }));
  const conversation: AgentExecutionRunConversationRuntimeV1 = {
    send,
    watch: () => ({ dispose() {} }),
    async dispose() {},
  };
  const runtime = await createExecutionRunHostBackendFromConversationRuntime({
    request: createResumeRequest(),
    openConversation: async () => conversation,
  });
  const resultContract = { kind: 'decision' as const, decisions: ['accept', 'reject'] };

  await runtime.send({ text: 'Continue.' }, {
    localInputId: 'resumed-input-1',
    resultContract,
    causalPermissionAuthority,
  });

  expect(send).toHaveBeenCalledWith({
    inputIds: ['resumed-input-1'],
    input: { text: 'Continue.' },
    delivery: { kind: 'newTurn', turnId: 'run-resume-turn-1' },
    causalPermissionAuthority,
  }, {
    localInputId: 'resumed-input-1',
    resultContract,
    causalPermissionAuthority,
  });
  await runtime.dispose();
});

function createResumeRequest(runId = 'run-resume'): Extract<AgentExecutionRunOpenRequest, { kind: 'resume' }> {
  return {
    kind: 'resume',
    runId,
    cwd: '/repo',
    profile: { pluginId: 'happier.agent.test', localId: 'default' },
    checkpointId: 'provider-checkpoint-1',
  };
}

it.each(['usage-observed', 'skill-usage'] as const)('observes only active-turn %s through the public conversation adapter by native identity', async kind => {
  const harness = createSessionHarness();
  const observed: AgentSessionRuntimeEvent[] = [];
  const checkpointInputs: AgentSessionRuntimeEvent[] = [];
  const runtime = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
    request: createResumeRequest('run-observer'),
    openConversation: () => harness.session,
    observeUsage(event) { observed.push(event); },
    readCheckpointId(event) {
      checkpointInputs.push(event);
      return event.kind === 'provider-session-id' ? event.providerSessionId : null;
    },
  });
  const usage = kind === 'usage-observed' ? {
    sequence: 2, sessionId: 'session-1', emittedAtMs: 11, turnId: 'run-observer-turn-1',
    kind: 'usage-observed', observationId: 'usage-1', source: 'provider', scope: 'turn_delta',
    modelId: 'model-a',
    tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  } as const satisfies AgentSessionRuntimeEvent : {
    sequence: 2, sessionId: 'session-1', emittedAtMs: 11, turnId: 'run-observer-turn-1',
    kind: 'skill-usage', skills: [{ name: 'happier:contract-skill' }],
  } as const satisfies AgentSessionRuntimeEvent;
  harness.publish(usage);
  await runtime.send({ text: 'Continue.' });
  harness.publish({ ...usage, turnId: 'other-turn' });
  harness.publish(usage);
  harness.publish(completeEvent('run-observer-turn-1'));
  harness.publish(usage);

  expect(observed).toEqual([usage]);
  expect(observed[0]).toBe(usage);
  expect(checkpointInputs.some(event => event.kind === kind)).toBe(false);
  await runtime.dispose();
});

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

function outputEvent(turnId: string): Extract<AgentSessionRuntimeEvent, { kind: 'message-delta' }> {
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

describe('createExecutionRunHostBackendFromConversationRuntime', () => {
  it('projects only proven foreground text into Run output', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(), openConversation: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));
    const turnId = 'run-1-turn-1';
    harness.publish(outputEvent(turnId));
    let sequence = 2;
    for (const scope of [{}, { turnId, sidechainId: 'child' }, { turnId: 'older-turn' }]) {
      for (const channel of ['assistant', 'reasoning'] as const) {
        harness.publish({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence,
          kind: 'message-delta', channel, text: 'Session observation', ...scope });
      }
      harness.publish({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence,
        kind: 'transcript-message-committed', role: 'assistant', messageId: 'session-artifact', text: 'Session replacement', ...scope });
    }
    harness.publish({ sequence: ++sequence, sessionId: 'session-1', emittedAtMs: sequence, turnId,
      kind: 'transcript-message-committed', role: 'assistant', messageId: 'foreground-artifact', text: 'Foreground replacement' });
    harness.publish({ ...completeEvent(turnId), sequence: ++sequence, emittedAtMs: sequence });
    expect(events).toMatchObject([
      { kind: 'run-start' },
      { kind: 'output-delta', text: 'early output' },
      { kind: 'output-message-committed', messageId: 'foreground-artifact', text: 'Foreground replacement' },
      { kind: 'run-complete' },
    ]);
    await execution.dispose();
  });

  it('retains committed assistant artifacts and their identities in the finite Run event stream', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(), openConversation: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));
    const turnId = 'run-1-turn-1';
    harness.publish({ ...outputEvent(turnId), messageId: 'artifact', text: 'Draft report' });
    harness.publish({ sequence: 3, sessionId: 'session-1', emittedAtMs: 12, turnId,
      kind: 'transcript-message-committed', role: 'assistant', messageId: 'artifact', text: 'Corrected report' });
    harness.publish({ sequence: 4, sessionId: 'session-1', emittedAtMs: 13, turnId,
      kind: 'transcript-message-committed', role: 'assistant', messageId: 'acknowledgment', text: 'Artifact delivered.' });
    harness.publish({ sequence: 5, sessionId: 'session-1', emittedAtMs: 14, turnId: 'stale-turn',
      kind: 'transcript-message-committed', role: 'assistant', messageId: 'artifact', text: 'Stale replacement' });
    harness.publish({ sequence: 6, sessionId: 'session-1', emittedAtMs: 15, turnId, sidechainId: 'child-tool',
      kind: 'transcript-message-committed', role: 'assistant', messageId: 'child-artifact', text: 'Child output' });
    harness.publish(completeEvent(turnId));
    expect(events).toMatchObject([
      { kind: 'run-start' },
      { kind: 'output-delta', messageId: 'artifact', text: 'Draft report' },
      { kind: 'output-message-committed', messageId: 'artifact', text: 'Corrected report' },
      { kind: 'output-message-committed', messageId: 'acknowledgment', text: 'Artifact delivered.' },
      { kind: 'run-complete' },
    ]);
    await execution.dispose();
  });

  it.each(['usage-observed', 'skill-usage'] as const)('forwards %s without creating a competing Run event', async kind => {
    const harness = createSessionHarness();
    const observeUsage = vi.fn();
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(),
      openConversation: async () => harness.session,
      observeUsage,
    });
    const runEvents: AgentExecutionRunEvent[] = [];
    execution.watch((event) => runEvents.push(event));

    const usage = kind === 'usage-observed' ? {
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 11,
      turnId: 'run-1-turn-1',
      kind: 'usage-observed',
      observationId: 'usage-1',
      source: 'provider',
      scope: 'turn_delta',
      modelId: 'model-a',
      tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
    } as const satisfies AgentSessionRuntimeEvent : {
      sequence: 2, sessionId: 'session-1', emittedAtMs: 11, turnId: 'run-1-turn-1',
      kind: 'skill-usage', skills: [{ name: 'happier:contract-skill' }],
    } as const satisfies AgentSessionRuntimeEvent;
    harness.publish(usage);
    harness.publish({ ...usage, turnId: 'other-turn' });

    expect(observeUsage).toHaveBeenCalledOnce();
    expect(observeUsage).toHaveBeenCalledWith(usage);
    expect(runEvents.map((event) => event.kind)).toEqual(['run-start']);
    await execution.dispose();
  });

  it('preserves the admitted causal permission authority on the derived Session turn', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: { ...createRequest(), causalPermissionAuthority },
      openConversation: async () => harness.session,
    });

    expect(harness.sendCalls[0]?.[0]).toMatchObject({ causalPermissionAuthority });
    await execution.dispose();
  });

  it('uses the current send authority instead of reusing the Run open authority', async () => {
    const harness = createSessionHarness();
    const currentTurnAuthority = Object.freeze({
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'default' as const,
    });
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: { ...createResumeRequest(), causalPermissionAuthority },
      openConversation: async () => harness.session,
    });

    await execution.send(
      { text: 'Continue under the current turn.' },
      { causalPermissionAuthority: currentTurnAuthority },
    );

    expect(harness.sendCalls[0]?.[0]).toMatchObject({
      causalPermissionAuthority: currentTurnAuthority,
    });
    await execution.dispose();
  });

  it('terminalizes rejected initial admission, clears cancellation state, and disposes once', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => ({
      status: 'rejected',
      retryable: false,
      diagnostic: { code: 'initial_rejected', severity: 'error' },
    }));

    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(),
      openConversation: async () => harness.session,
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

  it('settles terminal disposal without awaiting a never-settling Session cleanup', async () => {
    let publish!: (event: AgentSessionRuntimeEvent) => void;
    let disposeCalls = 0;
    const session: AgentSessionRuntime = {
      async send() {
        return { status: 'admitted' };
      },
      watch(listener) {
        publish = listener;
        return { dispose() {} };
      },
      async dispose() {
        disposeCalls += 1;
        await new Promise<never>(() => undefined);
      },
    };
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createResumeRequest('run-never-settling-cleanup'),
      openConversation: async () => session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => events.push(event));

    await expect(execution.send({ text: 'finish' })).resolves.toMatchObject({
      status: 'admitted',
    });
    publish(completeEvent('run-never-settling-cleanup-turn-1'));
    await expect(execution.dispose()).resolves.toBeUndefined();
    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(disposeCalls).toBe(1);

    await expect(execution.dispose()).resolves.toBeUndefined();
    expect(disposeCalls).toBe(1);
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

    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-synchronous-replay'),
      openConversation: async () => session,
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

    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request,
      openConversation: async () => harness.session,
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

    const lateEvents: AgentExecutionRunEvent[] = [];
    execution.watch((event) => lateEvents.push(event));
    expect(lateEvents.map((event) => event.kind)).toEqual(['run-complete']);
  });

  it('preserves the host-authored local input id across the Execution Run to Session adapter', async () => {
    const harness = createSessionHarness();
    harness.setSend(async (request) => {
      harness.publish(completeEvent(request.delivery.turnId));
      return { status: 'admitted' };
    });

    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: {
        ...createRequest('run-exact-input'),
        localInputId: 'workflow-input-1',
        resultContract: { kind: 'text' },
      },
      openConversation: async () => harness.session,
    });

    expect(harness.sendCalls[0]?.[0].inputIds).toEqual(['workflow-input-1']);
    await execution.dispose();
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

    await expect(createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(),
      openConversation: async () => session,
    })).rejects.toThrow('watch setup failed');
    expect(disposeCalls).toBe(1);
  });

  it('disposes an opened Session if initial send throws', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => {
      throw new Error('initial send failed');
    });

    await expect(createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest(),
      openConversation: async () => harness.session,
    })).rejects.toThrow('initial send failed');
    expect(harness.subscriptionDisposeCalls).toBe(1);
    expect(harness.sessionDisposeCalls).toBe(1);
  });

  it('terminalizes and disposes a resumed Run if its first send throws', async () => {
    const harness = createSessionHarness();
    harness.setSend(async () => {
      throw new Error('resumed send failed');
    });
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createResumeRequest('run-resumed-send-failure'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createResumeRequest('run-listener-isolation'),
      openConversation: async () => harness.session,
    });
    const events: AgentExecutionRunEvent[] = [];
    execution.watch((event) => {
      if (event.kind === 'run-complete') throw new Error('subscriber failed');
    });
    execution.watch((event) => events.push(event));

    await expect(execution.send({ text: 'Continue.' })).resolves.toEqual({ status: 'admitted' });
    await vi.waitFor(() => expect(harness.sessionDisposeCalls).toBe(1));

    expect(events.map((event) => event.kind)).toEqual(['run-complete']);
    expect(events.map((event) => event.sequence)).toEqual([2]);
    expect(harness.subscriptionDisposeCalls).toBe(1);
  });

  it('keeps one finite active turn and refuses a second send without losing terminal correlation', async () => {
    const harness = createSessionHarness();
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-one-turn'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-cancel'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-silent-cancel'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-input-failure'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-runtime-ended'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-already-stopped'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createRequest('run-silent-dispose'),
      openConversation: async () => harness.session,
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
    const execution = await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
      request: createResumeRequest('run-resume-dispose'),
      openConversation: async () => harness.session,
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
