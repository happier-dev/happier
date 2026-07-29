import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createAgentSessionRuntimeEventStream,
  measureAgentSessionRuntimeEventJsonBytes,
} from './agentSessionRuntimeEventStream';
import type { AgentSessionRuntimeEventStreamFailure } from './agentSessionRuntimeEventStream';

function progressEvent(sequence: number): AgentSessionRuntimeEvent {
  return {
    kind: 'turn-progress',
    sequence,
    sessionId: 'session-1',
    emittedAtMs: sequence,
    turnId: 'turn-1',
  };
}

function transcriptEvent(sequence: number, text: string): AgentSessionRuntimeEvent {
  return {
    kind: 'transcript-message-committed',
    sequence,
    sessionId: 'session-1',
    emittedAtMs: sequence,
    messageId: `message-${sequence}`,
    role: 'assistant',
    text,
  };
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AgentSessionRuntime event stream', () => {
  it('replays events emitted before the first watcher in exact sequence order', async () => {
    const stream = createAgentSessionRuntimeEventStream();

    await expect(stream.publish(progressEvent(1))).resolves.toEqual({
      status: 'accepted',
      delivery: 'buffered',
    });
    await expect(stream.publish(progressEvent(2))).resolves.toEqual({
      status: 'accepted',
      delivery: 'buffered',
    });

    const observed: number[] = [];
    const subscription = stream.watch(async (event) => {
      observed.push(event.sequence);
    });
    await stream.whenIdle();

    expect(observed).toEqual([1, 2]);
    await subscription.dispose();
    await stream.dispose();
  });

  it('accepts the exact count bound, rejects +1, and never evicts accepted custody or lifecycle facts', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const countLimit = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
      .p0MeasuredCandidates.preWatchReplayBufferMaxEvents;
    const accepted: AgentSessionRuntimeEvent[] = Array.from(
      { length: countLimit },
      (_, index) => progressEvent(index + 1),
    );
    accepted[0] = {
      kind: 'input-custody-unknown',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      inputIds: ['input-1'],
      issue: { code: 'custody_unknown', severity: 'warning' },
    };
    accepted[countLimit - 1] = {
      kind: 'runtime-ended',
      sequence: countLimit,
      sessionId: 'session-1',
      emittedAtMs: countLimit,
      cause: 'connectionLost',
      retryable: true,
    };

    for (const event of accepted) {
      expect(await stream.publish(event)).toEqual({
        status: 'accepted',
        delivery: 'buffered',
      });
    }
    await expect(stream.publish(progressEvent(countLimit + 1))).resolves.toMatchObject({
      status: 'overflow',
      reason: 'count',
    });

    const observed: AgentSessionRuntimeEvent[] = [];
    stream.watch((event) => {
      observed.push(event);
    });
    await stream.whenIdle();

    expect(observed).toHaveLength(countLimit);
    expect(observed[0]?.kind).toBe('input-custody-unknown');
    expect(observed.at(-1)?.kind).toBe('runtime-ended');
    await stream.dispose();
  });

  it('reserves bounded recovery admission after normal cold-watch capacity is exhausted', async () => {
    const countLimit = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
      .p0MeasuredCandidates.preWatchReplayBufferMaxEvents;
    const stream = createAgentSessionRuntimeEventStream({
      recoveryReserve: { maxEvents: 2, maxJsonBytes: 1_024 },
    });

    for (let sequence = 1; sequence <= countLimit - 2; sequence += 1) {
      expect(stream.admit(progressEvent(sequence))).toMatchObject({ status: 'accepted' });
    }
    expect(stream.admit(progressEvent(countLimit - 1))).toMatchObject({
      status: 'overflow',
      reason: 'count',
    });
    expect(stream.admit({
      kind: 'runtime-ended',
      sequence: countLimit - 1,
      sessionId: 'session-1',
      emittedAtMs: countLimit - 1,
      cause: 'protocolError',
      retryable: true,
    }, { useRecoveryReserve: true })).toEqual({
      status: 'accepted',
      delivery: 'buffered',
    });

    const observed: AgentSessionRuntimeEvent[] = [];
    stream.watch((event) => { observed.push(event); });
    await stream.whenIdle();
    expect(observed.at(-1)).toMatchObject({ kind: 'runtime-ended', cause: 'protocolError' });
    await stream.dispose();
  });

  it('accepts the exact byte bound and rejects one additional byte-bearing event', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const byteLimit = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
      .p0MeasuredCandidates.preWatchReplayBufferMaxJsonBytes;
    const textLimit = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
      .p0MeasuredCandidates.transcriptTextMaxCodeUnits;
    const events: AgentSessionRuntimeEvent[] = [];
    let totalBytes = 0;
    let sequence = 1;

    while (events.length < 15) {
      const event = transcriptEvent(sequence, 'x'.repeat(textLimit));
      events.push(event);
      totalBytes += measureAgentSessionRuntimeEventJsonBytes(event);
      sequence += 1;
    }
    const emptyFinal = transcriptEvent(sequence, '');
    const finalTextCodeUnits = byteLimit
      - totalBytes
      - measureAgentSessionRuntimeEventJsonBytes(emptyFinal);
    expect(finalTextCodeUnits).toBeGreaterThanOrEqual(0);
    expect(finalTextCodeUnits).toBeLessThanOrEqual(textLimit);
    events.push(transcriptEvent(sequence, 'x'.repeat(finalTextCodeUnits)));

    expect(events.reduce(
      (sum, event) => sum + measureAgentSessionRuntimeEventJsonBytes(event),
      0,
    )).toBe(byteLimit);
    for (const event of events) {
      expect(await stream.publish(event)).toMatchObject({ status: 'accepted' });
    }
    await expect(stream.publish(progressEvent(sequence + 1))).resolves.toMatchObject({
      status: 'overflow',
      reason: 'bytes',
    });
    await stream.dispose();
  });

  it('serializes a slow listener and applies the same count backpressure while delivery is pending', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const firstDelivery = deferred();
    const observed: number[] = [];
    stream.watch(async (event) => {
      observed.push(event.sequence);
      if (event.sequence === 1) await firstDelivery.promise;
    });

    const countLimit = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1
      .p0MeasuredCandidates.preWatchReplayBufferMaxEvents;
    const accepted = Array.from(
      { length: countLimit },
      (_, index) => stream.publish(progressEvent(index + 1)),
    );
    await expect(stream.publish(progressEvent(countLimit + 1))).resolves.toMatchObject({
      status: 'overflow',
      reason: 'count',
    });

    firstDelivery.resolve();
    await expect(Promise.all(accepted)).resolves.toHaveLength(countLimit);
    await stream.whenIdle();
    expect(observed).toEqual(Array.from({ length: countLimit }, (_, index) => index + 1));
    await stream.dispose();
  });

  it('serializes a recursive publication without redelivering or overtaking the current event', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const observed: number[] = [];
    let recursivePublication: Promise<unknown> | undefined;
    stream.watch((event) => {
      observed.push(event.sequence);
      if (event.sequence === 1) recursivePublication = stream.publish(progressEvent(2));
    });

    await expect(stream.publish(progressEvent(1))).resolves.toMatchObject({
      status: 'accepted',
      delivery: 'delivered',
    });
    await recursivePublication;
    await stream.whenIdle();
    expect(observed).toEqual([1, 2]);
    await stream.dispose();
  });

  it('does not deadlock when a listener awaits a recursive publication', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const observed: number[] = [];
    let recursiveResult: unknown;
    stream.watch(async (event) => {
      observed.push(event.sequence);
      if (event.sequence === 1) {
        let recursiveSettled = false;
        const recursivePublication = stream.publish(progressEvent(2)).then((result) => {
          recursiveSettled = true;
          return result;
        });
        await Promise.resolve();
        expect(recursiveSettled).toBe(true);
        recursiveResult = await recursivePublication;
      }
    });

    await expect(stream.publish(progressEvent(1))).resolves.toMatchObject({
      status: 'accepted',
      delivery: 'delivered',
    });
    expect(recursiveResult).toEqual({ status: 'accepted', delivery: 'buffered' });
    await stream.whenIdle();
    expect(observed).toEqual([1, 2]);
    await stream.dispose();
  });

  it('turns a throwing listener into one observable stream failure without an unhandled rejection', async () => {
    const failures: AgentSessionRuntimeEventStreamFailure[] = [];
    const stream = createAgentSessionRuntimeEventStream({
      onFailure(failure) {
        failures.push(failure);
      },
    });
    stream.watch(() => {
      throw new Error('listener failed');
    });

    await expect(stream.publish(progressEvent(1))).resolves.toMatchObject({
      status: 'listenerFailed',
    });
    await expect(stream.publish(progressEvent(2))).resolves.toMatchObject({
      status: 'listenerFailed',
    });
    expect(failures).toEqual([
      expect.objectContaining({
        status: 'listenerFailed',
        diagnostic: expect.objectContaining({
          details: expect.objectContaining({ undeliveredEvents: 1 }),
        }),
      }),
    ]);
    await stream.dispose();
  });

  it('isolates an asynchronous failure observer from the owning stream failure', async () => {
    let rejectionHandlerAttached = false;
    const observation = Promise.reject<void>(new Error('failure observer failed'));
    const originalCatch = observation.catch.bind(observation);
    observation.catch = ((onRejected) => {
      rejectionHandlerAttached = true;
      return originalCatch(onRejected);
    }) as typeof observation.catch;
    const stream = createAgentSessionRuntimeEventStream({
      onFailure() {
        return observation;
      },
    });

    await expect(stream.publish({
      ...progressEvent(1),
      legacyPayload: true,
      // Boundary fixture deliberately violates the canonical event schema.
    } as unknown as AgentSessionRuntimeEvent)).resolves.toMatchObject({ status: 'invalidEvent' });

    expect(rejectionHandlerAttached).toBe(true);
    await stream.dispose();
  });

  it('still drains previously accepted facts after a later invalid event fails the stream', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const custody: AgentSessionRuntimeEvent = {
      kind: 'input-custody-unknown',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      inputIds: ['input-1'],
      issue: { code: 'custody_unknown', severity: 'warning' },
    };
    await stream.publish(custody);
    await expect(stream.publish({
      ...progressEvent(2),
      legacyPayload: true,
      // Boundary fixture deliberately violates the canonical event schema.
    } as unknown as AgentSessionRuntimeEvent)).resolves.toMatchObject({ status: 'invalidEvent' });

    const observed: AgentSessionRuntimeEvent[] = [];
    stream.watch((event) => {
      observed.push(event);
    });
    await stream.whenIdle();
    expect(observed).toEqual([custody]);
    await stream.dispose();
  });

  it('rejects a non-increasing sequence without disturbing previously accepted order', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    await stream.publish(progressEvent(2));
    await expect(stream.publish(progressEvent(1))).resolves.toMatchObject({
      status: 'invalidEvent',
    });

    const observed: number[] = [];
    stream.watch((event) => {
      observed.push(event.sequence);
    });
    await stream.whenIdle();
    expect(observed).toEqual([2]);
    await stream.dispose();
  });

  it('binds one stream to the first accepted session identity', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    await expect(stream.publish(progressEvent(1))).resolves.toMatchObject({ status: 'accepted' });
    await expect(stream.publish({
      ...progressEvent(2),
      sessionId: 'session-2',
    })).resolves.toMatchObject({ status: 'invalidEvent' });

    const observed: AgentSessionRuntimeEvent[] = [];
    stream.watch((event) => {
      observed.push(event);
    });
    await stream.whenIdle();
    expect(observed).toEqual([progressEvent(1)]);
    await stream.dispose();
  });

  it('reports every buffered event on disposal and rejects later publication explicitly', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const first = progressEvent(1);
    const second = progressEvent(2);
    await stream.publish(first);
    await stream.publish(second);

    await expect(stream.dispose()).resolves.toEqual({
      status: 'disposed',
      undeliveredEvents: 2,
      undeliveredJsonBytes:
        measureAgentSessionRuntimeEventJsonBytes(first)
        + measureAgentSessionRuntimeEventJsonBytes(second),
      listenerDrainTimedOut: false,
    });
    await expect(stream.publish(progressEvent(3))).resolves.toMatchObject({
      status: 'disposed',
    });
  });

  it('bounds disposal when an async listener never completes and reports the undelivered fact', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const blocked = deferred();
    const started = deferred();
    const subscription = stream.watch(async () => {
      started.resolve();
      await blocked.promise;
    });
    const publication = stream.publish(progressEvent(1));
    await started.promise;
    expect(subscription.dispose()).toBeUndefined();

    await expect(stream.dispose({ timeoutMs: 5 })).resolves.toMatchObject({
      status: 'disposed',
      undeliveredEvents: 1,
      listenerDrainTimedOut: true,
    });
    await expect(publication).resolves.toMatchObject({ status: 'disposed' });
    blocked.resolve();
  });

  it('joins concurrent disposal callers to the same truthful terminal result', async () => {
    const stream = createAgentSessionRuntimeEventStream();
    const blocked = deferred();
    const started = deferred();
    stream.watch(async () => {
      started.resolve();
      await blocked.promise;
    });
    const publication = stream.publish(progressEvent(1));
    await started.promise;

    const firstDisposal = stream.dispose({ timeoutMs: 5 });
    const secondDisposal = stream.dispose({ timeoutMs: 5 });
    await expect(Promise.all([firstDisposal, secondDisposal])).resolves.toEqual([
      {
        status: 'disposed',
        undeliveredEvents: 1,
        undeliveredJsonBytes: measureAgentSessionRuntimeEventJsonBytes(progressEvent(1)),
        listenerDrainTimedOut: true,
      },
      {
        status: 'disposed',
        undeliveredEvents: 1,
        undeliveredJsonBytes: measureAgentSessionRuntimeEventJsonBytes(progressEvent(1)),
        listenerDrainTimedOut: true,
      },
    ]);
    await expect(publication).resolves.toMatchObject({ status: 'disposed' });
    blocked.resolve();
  });
});
