import { describe, expect, it } from 'vitest';

import {
  DiscordIngressBackpressureError,
  DiscordIngressCancelledError,
  createDiscordIngressScheduler,
} from './discordIngressScheduler.js';

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Discord inbound scheduler', () => {
  it('serializes one connection and endpoint lane while preserving that lane’s order', async () => {
    const scheduler = createDiscordIngressScheduler({
      maxConcurrent: 2,
      maxQueuedPerKey: 2,
      maxQueuedTotal: 4,
    });
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('first');
        await first.promise;
        return 'first-result';
      },
    });
    const secondResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('second');
        return 'second-result';
      },
    });

    expect(started).toEqual(['first']);
    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    await expect(secondResult).resolves.toBe('second-result');
    expect(started).toEqual(['first', 'second']);
  });

  it('runs independent endpoint lanes concurrently instead of serializing a whole connection', async () => {
    const scheduler = createDiscordIngressScheduler({
      maxConcurrent: 2,
      maxQueuedPerKey: 1,
      maxQueuedTotal: 2,
    });
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];

    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('one');
        await first.promise;
        return 'one-result';
      },
    });
    const secondResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:two',
      run: async () => {
        started.push('two');
        await second.promise;
        return 'two-result';
      },
    });

    expect(started).toEqual(['one', 'two']);
    first.resolve();
    second.resolve();
    await expect(firstResult).resolves.toBe('one-result');
    await expect(secondResult).resolves.toBe('two-result');
  });

  it('rejects bounded queued work without dropping the existing lane', async () => {
    const scheduler = createDiscordIngressScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 1,
      maxQueuedTotal: 1,
    });
    const first = deferred<void>();
    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        await first.promise;
        return 'first-result';
      },
    });
    const queuedResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => 'queued-result',
    });

    await expect(scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => 'over-capacity',
    })).rejects.toEqual(expect.objectContaining({
      name: 'DiscordIngressBackpressureError',
      scope: 'lane',
    } satisfies Partial<DiscordIngressBackpressureError>));

    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    await expect(queuedResult).resolves.toBe('queued-result');
  });

  it('enforces the global queue bound across distinct endpoint lanes', async () => {
    const scheduler = createDiscordIngressScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 2,
      maxQueuedTotal: 1,
    });
    const first = deferred<void>();
    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        await first.promise;
        return 'first-result';
      },
    });
    const queuedResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:two',
      run: async () => 'queued-result',
    });

    await expect(scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:three',
      run: async () => 'over-capacity',
    })).rejects.toEqual(expect.objectContaining({
      name: 'DiscordIngressBackpressureError',
      scope: 'global',
    } satisfies Partial<DiscordIngressBackpressureError>));

    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    await expect(queuedResult).resolves.toBe('queued-result');
  });

  it('cancels queued work before it can enter a later current lane', async () => {
    const scheduler = createDiscordIngressScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 1,
      maxQueuedTotal: 2,
    });
    const first = deferred<void>();
    const controller = new AbortController();
    let cancelledTaskRan = false;
    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        await first.promise;
        return 'first-result';
      },
    });
    const cancelledResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:two',
      signal: controller.signal,
      run: async () => {
        cancelledTaskRan = true;
        return 'cancelled-result';
      },
    });

    controller.abort();
    await expect(cancelledResult).rejects.toBeInstanceOf(DiscordIngressCancelledError);
    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    expect(cancelledTaskRan).toBe(false);
  });
});
