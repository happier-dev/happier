import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { withCursorEmptyResponseFailure } from './emptyResponse.js';

type EventListener = Parameters<AgentSessionRuntime['watch']>[0];

function createRuntimeFixture(): Readonly<{
  runtime: AgentSessionRuntime;
  emit(event: AgentSessionRuntimeEvent): void;
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  updateConfiguration: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscriptionDispose: ReturnType<typeof vi.fn>;
}> {
  const listeners = new Set<EventListener>();
  const send = vi.fn(async () => ({ status: 'admitted' as const }));
  const cancel = vi.fn(async (request: Readonly<{ turnId: string }>) => ({
    status: 'requested' as const,
    turnId: request.turnId,
  }));
  const updateConfiguration = vi.fn(async () => ({
    status: 'applied' as const,
    changed: [] as const,
  }));
  const compact = vi.fn(async () => ({ status: 'admitted' as const }));
  const dispose = vi.fn(async () => undefined);
  const subscriptionDispose = vi.fn(() => undefined);
  const runtime: AgentSessionRuntime = {
    send,
    cancel,
    updateConfiguration,
    compact,
    watch(listener) {
      listeners.add(listener);
      return {
        dispose() {
          subscriptionDispose();
          listeners.delete(listener);
        },
      };
    },
    dispose,
  };
  return {
    runtime,
    emit(event) {
      for (const listener of Array.from(listeners)) listener(event);
    },
    send,
    cancel,
    updateConfiguration,
    compact,
    dispose,
    subscriptionDispose,
  };
}

function eventBase(sequence: number): Readonly<{
  sequence: number;
  sessionId: string;
  emittedAtMs: number;
}> {
  return {
    sequence,
    sessionId: 'happier-session-1',
    emittedAtMs: 1_000 + sequence,
  };
}

function turnStart(sequence = 1, turnId = 'host-turn-1'): AgentSessionRuntimeEvent {
  return {
    ...eventBase(sequence),
    kind: 'turn-start',
    turnId,
    startedBy: 'provider',
  };
}

function turnComplete(sequence = 2, turnId = 'host-turn-1'): AgentSessionRuntimeEvent {
  return {
    ...eventBase(sequence),
    kind: 'turn-complete',
    turnId,
    agentTurnId: 'cursor-provider-turn-1',
  };
}

describe('withCursorEmptyResponseFailure', () => {
  it('rewrites an empty successful terminal event as a Cursor provider failure', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const start = turnStart();
    const complete = turnComplete();

    fixture.emit(start);
    fixture.emit(complete);

    expect(events).toEqual([
      start,
      {
        ...complete,
        kind: 'turn-failed',
        diagnostic: {
          code: 'cursor_empty_provider_response',
          severity: 'error',
          message: 'Cursor completed the turn without returning an assistant message.',
        },
      },
    ]);
  });

  it('does not treat lifecycle-only progress as visible output', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    fixture.emit(turnStart());
    fixture.emit({
      ...eventBase(2),
      kind: 'turn-progress',
      turnId: 'host-turn-1',
    });
    fixture.emit({
      ...eventBase(3),
      kind: 'turn-agent-id-observed',
      turnId: 'host-turn-1',
      agentTurnId: 'cursor-provider-turn-1',
    });
    fixture.emit(turnComplete(4));

    expect(events.at(-1)).toMatchObject({
      kind: 'turn-failed',
      diagnostic: { code: 'cursor_empty_provider_response' },
    });
  });

  it('does not treat tool-only activity as visible output', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));

    fixture.emit(turnStart());
    fixture.emit({
      ...eventBase(2),
      kind: 'tool-call',
      turnId: 'host-turn-1',
      toolCallId: 'tool-1',
      toolName: 'change_title',
      input: { title: 'Session setup' },
    });
    fixture.emit({
      ...eventBase(3),
      kind: 'tool-result',
      turnId: 'host-turn-1',
      toolCallId: 'tool-1',
      output: { ok: true },
    });
    fixture.emit(turnComplete(4));

    expect(events.at(-1)).toMatchObject({
      kind: 'turn-failed',
      diagnostic: { code: 'cursor_empty_provider_response' },
    });
  });

  it('preserves a successful terminal event after visible message output', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const complete = turnComplete(3);

    fixture.emit(turnStart());
    fixture.emit({
      ...eventBase(2),
      kind: 'message-delta',
      turnId: 'host-turn-1',
      channel: 'assistant',
      text: 'Hello from Cursor',
    });
    fixture.emit(complete);

    expect(events.at(-1)).toBe(complete);
  });

  it('uses the successful terminal event identity when Cursor reports a differing turn id', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const complete = turnComplete(3, 'provider-turn-1');

    fixture.emit(turnStart(1, 'host-turn-1'));
    fixture.emit({
      ...eventBase(2),
      kind: 'tool-progress',
      turnId: 'provider-turn-1',
      toolCallId: 'tool-1',
      progress: { status: 'running' },
    });
    fixture.emit(complete);

    expect(events.at(-1)).toEqual({
      ...complete,
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({ code: 'cursor_empty_provider_response' }),
    });
  });

  it('preserves existing failures and completions outside an observed turn', () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(event));
    const failure: AgentSessionRuntimeEvent = {
      ...eventBase(2),
      kind: 'turn-failed',
      turnId: 'host-turn-1',
      diagnostic: {
        code: 'cursor_provider_failure',
        severity: 'error',
        message: 'Cursor reported a provider failure.',
      },
    };
    const unmatchedComplete = turnComplete(3, 'provider-turn-2');

    fixture.emit(turnStart());
    fixture.emit(failure);
    fixture.emit(unmatchedComplete);

    expect(events.at(-2)).toBe(failure);
    expect(events.at(-1)).toBe(unmatchedComplete);
  });

  it('delegates session operations and preserves subscription disposal', async () => {
    const fixture = createRuntimeFixture();
    const runtime = withCursorEmptyResponseFailure(fixture.runtime);
    const listener = vi.fn();
    const subscription = runtime.watch(listener);
    const abortController = new AbortController();
    const sendRequest = {
      inputIds: ['input-1'],
      input: { text: 'hello cursor' },
      delivery: { kind: 'newTurn' as const, turnId: 'host-turn-1' },
    };

    await runtime.send(sendRequest, { signal: abortController.signal });
    await runtime.cancel?.({ turnId: 'host-turn-1', reason: 'user' }, { signal: abortController.signal });
    const configuration = {
      mode: { value: null, updatedAtMs: 1 },
      model: { value: null, updatedAtMs: 1 },
      permissionIntent: { value: null, updatedAtMs: 1 },
      options: {},
    };
    await runtime.updateConfiguration?.(configuration, { signal: abortController.signal });
    const compactRequest = { turnId: 'host-turn-1' };
    await runtime.compact?.(compactRequest, { signal: abortController.signal });

    expect(fixture.send).toHaveBeenCalledWith(sendRequest, { signal: abortController.signal });
    expect(fixture.cancel).toHaveBeenCalledWith(
      { turnId: 'host-turn-1', reason: 'user' },
      { signal: abortController.signal },
    );
    expect(fixture.updateConfiguration).toHaveBeenCalledWith(
      configuration,
      { signal: abortController.signal },
    );
    expect(fixture.compact).toHaveBeenCalledWith(
      compactRequest,
      { signal: abortController.signal },
    );

    subscription.dispose();
    fixture.emit(turnStart());
    expect(listener).not.toHaveBeenCalled();
    expect(fixture.subscriptionDispose).toHaveBeenCalledTimes(1);
    expect(fixture.dispose).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });
});
