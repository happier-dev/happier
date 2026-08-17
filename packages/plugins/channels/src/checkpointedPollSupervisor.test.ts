import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createIngressSupervisor } from './checkpointedPollSupervisor.js';

function backgroundContext(
  signal: AbortSignal,
  query?: () => Promise<Readonly<{
    rows: readonly Readonly<{ rowId: string; revision: number; value: Readonly<Record<string, string>> }>[];
    changeCursor: number;
  }>>,
  logger?: Pick<PluginServices['logger'], 'warn'>,
): BackgroundServiceContext {
  const collection = {
    async query() {
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
});
