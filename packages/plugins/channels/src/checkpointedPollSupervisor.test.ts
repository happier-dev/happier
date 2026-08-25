import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import {
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createIngressSupervisor, type IngressSupervisorOptions } from './checkpointedPollSupervisor.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
function connectionRows(count: number): readonly Readonly<{
  rowId: string;
  revision: number;
  value: Readonly<Record<string, string>>;
}>[] {
  return Array.from({ length: count }, (_unused, index) => {
    const connectionId = `connection-${index + 1}`;
    return {
      rowId: connectionId,
      revision: 1,
      value: {
        id: connectionId,
        'record-kind': 'connection',
        'connection-id': connectionId,
      },
    };
  });
}

function backgroundContext(
  signal: AbortSignal,
  query?: () => Promise<Readonly<{
    rows: readonly Readonly<{ rowId: string; revision: number; value: Readonly<Record<string, string>> }>[];
    changeCursor: number;
  }>>,
  logger?: Pick<PluginServices['logger'], 'warn'>,
): BackgroundServiceContext {
  const collection = {
    async query(request: Readonly<{ limit?: number }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (query !== undefined) return await query();
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    },
  };
  return {
    plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: {
      id: 'ingress-supervisor',
      qualifiedId: 'happier.channels/backgroundServices/ingress-supervisor',
    },
    signal,
    services: {
      storage: { account: { collection: () => collection } },
      logger: logger ?? { warn: vi.fn() },
    } as unknown as PluginServices,
  } as BackgroundServiceContext;
}

describe('Checkpointed poll supervisor', () => {
  it('reconstructs each wake and leaves retry eligibility to the persisted connection owner', async () => {
    let now = 1_000_000;
    const generation = new AbortController();
    const callTimes: number[] = [];
    const calls: string[] = [];
    const runDueWork = vi.fn(async (input: Readonly<{ now: number; limit: number }>) => {
      calls.push('due');
      expect(input).toEqual({ now, limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT });
      return 0;
    });
    const runPoll = vi.fn(async (input: Readonly<{ connectionId: string; waitMs: number }>) => {
      calls.push('poll');
      callTimes.push(now);
      expect(input).toEqual({ connectionId: 'connection-1', waitMs: 1_000 });
      if (callTimes.length === 1) return { kind: 'retry' as const, retryAfterMs: 2_000 };
      generation.abort(new Error('test complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork,
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(callTimes).toEqual([1_000_000, 1_001_000]);
    expect(calls).toEqual(['due', 'poll', 'due', 'poll']);
    await supervisor.dispose();
  });

  it('runs ingress retention through the existing supervisor with a generation-local keyset cursor', async () => {
    let now = 2_000_000;
    const generation = new AbortController();
    const retentionInputs: Array<Readonly<{ now: number; limit: number; cursor?: string }>> = [];
    const runRetention = vi.fn(async (input: Readonly<{ now: number; limit: number; cursor?: string }>) => {
      retentionInputs.push(input);
      if (retentionInputs.length === 2) generation.abort(new Error('retention cursor observed'));
      return retentionInputs.length === 1 ? { nextCursor: 'retention:next' } : {};
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention,
      runPoll: async () => ({ kind: 'ineligible' }),
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(retentionInputs).toEqual([
      { now: 2_000_000, limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT },
      { now: 2_001_000, limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT, cursor: 'retention:next' },
    ]);
    await supervisor.dispose();
  });

  it('sweeps ingress retention once per shortest enforceable horizon instead of on every wake', async () => {
    const wakesPerSweep = MIN_CONVERSATION_OBSERVATION_AGE_MS / 1_000;
    let now = 3_000_000;
    const generation = new AbortController();
    const retentionAt: number[] = [];
    let pollCalls = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async (input) => {
        retentionAt.push(input.now);
        return {};
      },
      runPoll: async () => {
        pollCalls += 1;
        if (pollCalls > wakesPerSweep) generation.abort(new Error('test complete'));
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    // Every one of those wakes polled; only the startup pass and the wake that
    // reached the next coarse deadline re-scanned the census collection.
    expect(pollCalls).toBe(wakesPerSweep + 1);
    expect(retentionAt).toEqual([3_000_000, 3_000_000 + MIN_CONVERSATION_OBSERVATION_AGE_MS]);
    await supervisor.dispose();
  });

  it('holds a failed retention page to the next coarse deadline instead of re-failing every wake', async () => {
    let now = 4_000_000;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    let retentionCalls = 0;
    let pollCalls = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => {
        retentionCalls += 1;
        throw new Error('secret retention detail');
      },
      runPoll: async () => {
        pollCalls += 1;
        if (pollCalls > MIN_CONVERSATION_OBSERVATION_AGE_MS / 1_000) {
          generation.abort(new Error('test complete'));
        }
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal, undefined, logger));

    expect(retentionCalls).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      '[Channels] ingress supervisor work failed',
      { boundary: 'retention' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('retires one generation before admitting a replacement and refuses duplicate or disposed runs', async () => {
    const first = new AbortController();
    const replacement = new AbortController();
    let calls = 0;
    const runPoll = vi.fn(async (_input: unknown, context: BackgroundServiceContext) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(context.signal.reason);
          context.signal.addEventListener('abort', abort, { once: true });
        });
      }
      replacement.abort(new Error('replacement complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runPoll,
      runDueWork: async () => 0,
      runRetention: async () => ({}),
    });
    const firstContext = backgroundContext(first.signal);
    const firstRun = supervisor.run(firstContext);
    await vi.waitFor(() => expect(runPoll).toHaveBeenCalledTimes(1));

    await expect(supervisor.run(firstContext)).rejects.toThrow('already running');
    first.abort(new Error('first generation retired'));
    await firstRun;
    await supervisor.run(backgroundContext(replacement.signal));
    expect(runPoll).toHaveBeenCalledTimes(2);

    await supervisor.dispose();
    await expect(supervisor.run(backgroundContext(new AbortController().signal)))
      .rejects.toThrow('disposed');
  });

  it('redrives a transient Account discovery failure on the next bounded wake', async () => {
    let now = 2_000_000;
    let queryCalls = 0;
    const generation = new AbortController();
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('temporary Account storage failure');
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    });
    const runPoll = vi.fn(async () => {
      generation.abort(new Error('test complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await expect(supervisor.run(context)).resolves.toBeUndefined();

    expect(queryCalls).toBe(2);
    expect(runPoll).toHaveBeenCalledTimes(1);
    expect(now).toBe(2_001_000);
    await supervisor.dispose();
  });

  it('logs redacted non-abort worker failures and keeps abort silent', async () => {
    let now = 3_000_000;
    let queryCalls = 0;
    let dueWorkCalls = 0;
    let pollCalls = 0;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('secret Account discovery detail');
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    }, logger);
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        dueWorkCalls += 1;
        if (dueWorkCalls === 1) throw new Error('secret due-work detail');
        return 0;
      },
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll: async () => {
        pollCalls += 1;
        if (pollCalls === 1) throw new Error('secret provider poll detail');
        generation.abort(new Error('test complete'));
        throw new Error('secret abort detail');
      },
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(context);

    expect(now).toBe(3_002_000);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      '[Channels] ingress supervisor work failed',
      { boundary: 'due-work' },
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      '[Channels] ingress supervisor work failed',
      { boundary: 'connection-discovery' },
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      3,
      '[Channels] ingress supervisor work failed',
      { boundary: 'poll' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('treats an Account that has not released the Channels collection as inactive without warning', async () => {
    let now = 4_000_000;
    let queryCalls = 0;
    let dueWorkCalls = 0;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    const refusal = (): PluginError => new PluginError({
      code: 'collection_unavailable',
      message: 'secret Account Collection rejection detail',
      retryable: false,
    });
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw refusal();
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    }, logger);
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        dueWorkCalls += 1;
        if (dueWorkCalls === 1) throw refusal();
        return 0;
      },
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll: async () => {
        generation.abort(new Error('test complete'));
        return { kind: 'ineligible' as const };
      },
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(context);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(dueWorkCalls).toBe(2);
    expect(queryCalls).toBe(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('starts every current connection poll on the same wake instead of serializing behind a slow provider', async () => {
    const generation = new AbortController();
    const started: string[] = [];
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    const runPoll = vi.fn(async (input: Readonly<{ connectionId: string; waitMs: number }>) => {
      started.push(input.connectionId);
      if (input.connectionId === 'connection-1') await slowPoll;
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll,
      reconciliationIntervalMs: 1_000,
    });

    const run = supervisor.run(backgroundContext(
      generation.signal,
      async () => ({ rows: connectionRows(3), changeCursor: 1 }),
    ));
    // One long-polling provider must not hold the other 31 supported
    // connections behind it: a serial sweep only ever reaches connection-1.
    await vi.waitFor(() => expect(started).toEqual([
      'connection-1',
      'connection-2',
      'connection-3',
    ]));

    releaseSlowPoll?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('keeps one in-flight poll per connection while due work keeps progressing', async () => {
    const generation = new AbortController();
    const polls: string[] = [];
    let dueWorkCalls = 0;
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => { dueWorkCalls += 1; return 0; },
      runRetention: async () => ({}),
      runPoll: async (input) => {
        polls.push(input.connectionId);
        if (input.connectionId === 'connection-1') await slowPoll;
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 20,
    });

    const run = supervisor.run(backgroundContext(
      generation.signal,
      async () => ({ rows: connectionRows(2), changeCursor: 1 }),
    ));
    await vi.waitFor(() => {
      expect(polls.filter((id) => id === 'connection-2').length).toBeGreaterThanOrEqual(3);
      expect(dueWorkCalls).toBeGreaterThanOrEqual(3);
    });
    // Per-connection order is preserved by admitting at most one outstanding
    // poll for each connection key, not by serializing the whole sweep.
    expect(polls.filter((id) => id === 'connection-1')).toEqual(['connection-1']);

    releaseSlowPoll?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('starts connection polls without waiting for a coarse retention page', async () => {
    const generation = new AbortController();
    const polls: string[] = [];
    let retentionCalls = 0;
    let releaseRetention: (() => void) | undefined;
    const slowRetention = new Promise<void>((resolve) => { releaseRetention = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => {
        retentionCalls += 1;
        await slowRetention;
        return {};
      },
      runPoll: async (input) => {
        polls.push(input.connectionId);
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 20,
    });

    const run = supervisor.run(backgroundContext(generation.signal));
    // One retention page can walk a whole census unit per row, so awaiting it
    // inline stopped every connection from being polled for the whole sweep.
    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(3));
    // Still exactly one sweep in flight: the wake that finds one outstanding
    // does not start a second pass over the same cursor.
    expect(retentionCalls).toBe(1);

    releaseRetention?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('keeps polling a connection whose poll fails before its first suspension point', async () => {
    let now = 5_000_000;
    const generation = new AbortController();
    let pollCalls = 0;
    let wakes = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        wakes += 1;
        if (wakes > 5) generation.abort(new Error('test complete'));
        return 0;
      },
      runRetention: async () => ({}),
      // A provider adapter that throws before returning its promise settles
      // the poll inside the same synchronous turn that started it.
      runPoll: (() => {
        pollCalls += 1;
        if (pollCalls === 1) throw new Error('synchronous provider failure');
        generation.abort(new Error('test complete'));
        return Promise.resolve({ kind: 'ineligible' as const });
      }) as IngressSupervisorOptions['runPoll'],
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(pollCalls).toBeGreaterThanOrEqual(2);
    await supervisor.dispose();
  });

  it('keeps sweeping retention after a page that fails before its first suspension point', async () => {
    let now = 6_000_000;
    const generation = new AbortController();
    let retentionCalls = 0;
    let wakes = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        wakes += 1;
        if (wakes > 5) generation.abort(new Error('test complete'));
        return 0;
      },
      runRetention: (() => {
        retentionCalls += 1;
        if (retentionCalls === 1) throw new Error('synchronous retention failure');
        return Promise.resolve({});
      }) as IngressSupervisorOptions['runRetention'],
      runPoll: async () => ({ kind: 'ineligible' as const }),
      // A failed page is held to the next coarse deadline, so the sweep this
      // asserts is the one the failure rescheduled — not an extra wake.
      reconciliationIntervalMs: MIN_CONVERSATION_OBSERVATION_AGE_MS,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(retentionCalls).toBeGreaterThanOrEqual(2);
    await supervisor.dispose();
  });

  it('retires a generation only after the polls it started have settled', async () => {
    const generation = new AbortController();
    let settled = false;
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    let pollStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { pollStarted = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll: async () => {
        pollStarted?.();
        await slowPoll;
        settled = true;
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
    });

    const run = supervisor.run(backgroundContext(generation.signal));
    await started;
    generation.abort(new Error('test complete'));
    let resolvedEarly = false;
    void run.then(() => { resolvedEarly = !settled; });
    await new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 20); });
    // Provider I/O this generation started is still its own: retiring while a
    // poll is outstanding would let a replacement generation poll the same
    // connection concurrently.
    expect(resolvedEarly).toBe(false);

    releaseSlowPoll?.();
    await run;
    expect(settled).toBe(true);
    await supervisor.dispose();
  });
});
