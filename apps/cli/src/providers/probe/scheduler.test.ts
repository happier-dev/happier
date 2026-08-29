import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
  PROVIDER_PROBE_REFRESH_TRIGGERS,
  ProviderProbeAdmissionCapacityError,
  createProviderProbeScheduler,
} from './scheduler';

type TestScheduledResult =
  | Readonly<{ status: 'success' }>
  | Readonly<{
      status: 'error';
      error: Readonly<{
        code: 'provider_endpoint_unavailable' | 'provider_probe_capacity_exhausted';
      }>;
    }>;

function unavailable(): Extract<TestScheduledResult, { status: 'error' }> {
  return { status: 'error', error: { code: 'provider_endpoint_unavailable' } };
}

const noCancellation = {
  unavailable: (): never => { throw new Error('unexpected scheduler refusal'); },
} as const;

describe('provider probe scheduler', () => {
  it('globally bounds DNS resolver work across concurrent picker operations', async () => {
    const scheduler = createProviderProbeScheduler();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const resolveAddress = async (value: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value;
    };
    const lifetime = { wallDeadlineAtMs: Date.now() + 60_000 };
    const runPickerOperation = (prefix: string) => Promise.all(
      Array.from({ length: 8 }, (_, index) => scheduler.runDns(
        () => resolveAddress(`${prefix}-${index}`),
        lifetime,
      )),
    );

    const first = runPickerOperation('first');
    const second = runPickerOperation('second');
    await vi.waitFor(() => expect(active).toBe(
      PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS,
    ));
    while (releases.length > 0 || active > 0) {
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(peak).toBe(PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS);
  });

  it('refuses DNS work when the shared Provider admission owner is full', async () => {
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });
    const lifetime = { wallDeadlineAtMs: Date.now() + 60_000 };
    const releases: Array<() => void> = [];
    const operation = () => new Promise<string>((resolve) => releases.push(() => resolve('ok')));
    const active = scheduler.runDns(operation, lifetime);
    const queued = scheduler.runDns(operation, lifetime);

    await expect(scheduler.runDns(operation, lifetime))
      .rejects.toBeInstanceOf(ProviderProbeAdmissionCapacityError);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await expect(active).resolves.toBe('ok');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await expect(queued).resolves.toBe('ok');
  });

  it('does not dispatch queued DNS work after its operation becomes non-current', async () => {
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });
    const lifetime = { wallDeadlineAtMs: Date.now() + 60_000 };
    let releaseActive!: () => void;
    const active = scheduler.runDns(
      () => new Promise<string>((resolve) => { releaseActive = () => resolve('active'); }),
      lifetime,
    );
    let current = true;
    const resolver = vi.fn(async () => 'obsolete');
    const queued = scheduler.runDns(resolver, lifetime, () => current);
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf('function'));

    current = false;
    releaseActive();
    await expect(active).resolves.toBe('active');
    await expect(queued).rejects.toMatchObject({ reason: 'cancelled' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('single-flights identical work and releases the successful payload once its callers settle', async () => {
    let resolve!: (value: { status: 'success' }) => void;
    const operation = vi.fn(() => new Promise<{ status: 'success' }>((done) => { resolve = done; }));
    const scheduler = createProviderProbeScheduler({ now: () => 1_000, random: () => 0.5 });
    const first = scheduler.runCatalog('connection-a', 'picker_open', operation, noCancellation);
    const second = scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(1);
    resolve({ status: 'success' });
    await expect(first).resolves.toEqual({ status: 'success' });
    await expect(second).resolves.toEqual({ status: 'success' });

    // Catalog and health freshness belong to the persisted runtime state that
    // every demand caller consults before scheduling, so no successful payload
    // is retained here for a second freshness decision to read.
    operation.mockResolvedValueOnce({ status: 'success' });
    await scheduler.runCatalog('connection-a', 'picker_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(2);

    const health = vi.fn().mockResolvedValue({ status: 'success' as const });
    await scheduler.runHealth('connection-a', 'detail_open', health, noCancellation);
    await scheduler.runHealth('connection-a', 'picker_open', health, noCancellation);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('does not retain successful catalog payloads after manual, enable, or post-mutation refreshes', async () => {
    const scheduler = createProviderProbeScheduler({ now: () => 1_000, random: () => 0.5 });
    const forced = vi.fn().mockResolvedValue({ status: 'success' as const, models: ['forced'] });
    const demand = vi.fn().mockResolvedValue({ status: 'success' as const, models: ['demand'] });

    await scheduler.runCatalog('manual', 'manual_refresh', forced, noCancellation);
    await expect(scheduler.runCatalog('manual', 'picker_open', demand, noCancellation))
      .resolves.toEqual({ status: 'success', models: ['demand'] });

    await scheduler.runCatalog('enable', 'enable', forced, noCancellation);
    await expect(scheduler.runCatalog('enable', 'picker_open', demand, noCancellation))
      .resolves.toEqual({ status: 'success', models: ['demand'] });

    await scheduler.runCatalogAfter('mutation', 'model-load', forced, noCancellation);
    await expect(scheduler.runCatalog('mutation', 'picker_open', demand, noCancellation))
      .resolves.toEqual({ status: 'success', models: ['demand'] });

    expect(forced).toHaveBeenCalledTimes(3);
    expect(demand).toHaveBeenCalledTimes(3);
  });

  it('retains a completed failure only under its effective post-operation identity', async () => {
    const operation = vi.fn().mockResolvedValue({
      status: 'error' as const,
      completedKey: 'revision-b',
      identity: 'revision-b',
    });
    const scheduler = createProviderProbeScheduler({ now: () => 1_000, random: () => 0.5 });

    await scheduler.runCatalog(
      'revision-a',
      'picker_open',
      operation,
      noCancellation,
    );
    await scheduler.runCatalog('revision-b', 'picker_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(1);

    await scheduler.runCatalog('revision-a', 'picker_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('backs failures off, while explicit manual refresh bypasses the delay', async () => {
    let now = 1_000;
    const operation = vi.fn().mockResolvedValue({ status: 'error' });
    const scheduler = createProviderProbeScheduler({ now: () => now, random: () => 0.5 });
    await scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    await scheduler.runCatalog('connection-a', 'picker_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(1);
    await scheduler.runCatalog('connection-a', 'manual_refresh', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(2);
    now += 60_001;
    await scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('admits only reachable demand triggers and treats enable as an explicit forced refresh', async () => {
    expect(PROVIDER_PROBE_REFRESH_TRIGGERS).toEqual([
      'enable',
      'detail_open',
      'picker_open',
      'manual_refresh',
    ]);
    const operation = vi.fn().mockResolvedValue({ status: 'success' });
    const scheduler = createProviderProbeScheduler({ now: () => 1_000 });
    await scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    await scheduler.runCatalog('connection-a', 'enable', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('bounds completed request identities so draft/config churn cannot grow daemon memory without limit', async () => {
    const operation = vi.fn().mockResolvedValue({ status: 'error' });
    const scheduler = createProviderProbeScheduler({
      now: () => 1_000,
      random: () => 0.5,
      maxCompletedEntriesPerLane: 3,
    });
    await scheduler.runCatalog('request-a', 'picker_open', operation, noCancellation);
    await scheduler.runCatalog('request-b', 'picker_open', operation, noCancellation);
    await scheduler.runCatalog('request-c', 'picker_open', operation, noCancellation);
    await scheduler.runCatalog('request-d', 'picker_open', operation, noCancellation);
    await scheduler.runCatalog('request-a', 'picker_open', operation, noCancellation);

    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('bounds catalog and health work through one daemon-wide concurrency owner', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const operation = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { status: 'success' as const };
    });
    const scheduler = createProviderProbeScheduler({ maxConcurrentOperations: 2 });
    const pending = [
      scheduler.runCatalog('catalog-a', 'manual_refresh', operation, noCancellation),
      scheduler.runHealth('health-a', 'manual_refresh', operation, noCancellation),
      scheduler.runCatalog('catalog-b', 'manual_refresh', operation, noCancellation),
    ];
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(pending);
    expect(peak).toBe(2);
  });

  it('honors a longer server Retry-After before a demand read retries failed work', async () => {
    let now = 1_000;
    const operation = vi.fn().mockResolvedValue({
      status: 'error', error: { retryAfterMs: 120_000 },
    });
    const scheduler = createProviderProbeScheduler({ now: () => now, random: () => 0.5 });
    await scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    now += 60_000;
    await scheduler.runCatalog('connection-a', 'picker_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(1);
    now += 60_001;
    await scheduler.runCatalog('connection-a', 'detail_open', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('serializes causal refresh frontiers after older demand without coalescing distinct mutations', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 'success' as const };
    });
    const scheduler = createProviderProbeScheduler();
    const demand = scheduler.runCatalog('connection-a', 'picker_open', operation, noCancellation);
    const firstMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation, noCancellation);
    const sameMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation, noCancellation);
    const retryMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-b', operation, noCancellation);
    expect(operation).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await Promise.all([demand, firstMutation, sameMutation, retryMutation]);
  });

  it('keeps a causal successor after a cancelled waiter leaves an active coalesced frontier', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releases.push(() => resolve({ status: 'success' }));
    }));
    const scheduler = createProviderProbeScheduler({ maxConcurrentOperations: 1 });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation, {
      unavailable,
      signal: firstController.signal,
    });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    const second = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation, {
      unavailable,
      signal: secondController.signal,
    });
    const successor = scheduler.runCatalogAfter('connection-a', 'dispatch-b', operation, {
      unavailable,
      signal: secondController.signal,
    });

    firstController.abort();
    await expect(first).resolves.toEqual(unavailable());
    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();

    await expect(Promise.all([second, successor])).resolves.toEqual([
      { status: 'success' },
      { status: 'success' },
    ]);
  });

  it('keeps a later causal frontier behind an active predecessor when its intermediate frontier is cancelled', async () => {
    let releaseOlder!: () => void;
    let releaseSuccessor!: () => void;
    const olderOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releaseOlder = () => resolve({ status: 'success' });
    }));
    const intermediateOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const successorOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releaseSuccessor = () => resolve({ status: 'success' });
    }));
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 2,
      maxPendingOperations: 2,
    });
    const intermediateController = new AbortController();

    const older = scheduler.runCatalogAfter('connection-a', 'dispatch-a', olderOperation, { unavailable });
    await vi.waitFor(() => expect(olderOperation).toHaveBeenCalledTimes(1));
    const intermediate = scheduler.runCatalogAfter(
      'connection-a',
      'dispatch-b',
      intermediateOperation,
      { unavailable, signal: intermediateController.signal },
    );
    const successor = scheduler.runCatalogAfter(
      'connection-a',
      'dispatch-c',
      successorOperation,
      { unavailable },
    );

    intermediateController.abort();
    await expect(intermediate).resolves.toEqual(unavailable());
    expect(intermediateOperation).not.toHaveBeenCalled();
    expect(successorOperation).not.toHaveBeenCalled();

    releaseOlder();
    await expect(older).resolves.toEqual({ status: 'success' });
    await vi.waitFor(() => expect(successorOperation).toHaveBeenCalledTimes(1));
    releaseSuccessor();
    await expect(successor).resolves.toEqual({ status: 'success' });
  });

  it('refuses a unique queue overflow without retaining it and admits it after capacity drains', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releases.push(() => resolve({ status: 'success' }));
    }));
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', operation, { unavailable });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    const queued = scheduler.runCatalog('queued', 'manual_refresh', operation, { unavailable });
    const refused = scheduler.runCatalog('refused', 'manual_refresh', operation, { unavailable });

    await expect(refused).resolves.toEqual(unavailable());
    expect(operation).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(Promise.all([active, queued])).resolves.toEqual([
      { status: 'success' },
      { status: 'success' },
    ]);

    const admittedAfterDrain = scheduler.runCatalog('refused', 'manual_refresh', operation, { unavailable });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await expect(admittedAfterDrain).resolves.toEqual({ status: 'success' });
  });

  it('does not spend a second unique pending slot when another caller joins the same key', async () => {
    const activeReleases: Array<() => void> = [];
    const activeOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      activeReleases.push(() => resolve({ status: 'success' }));
    }));
    const queuedOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', activeOperation, { unavailable });
    await vi.waitFor(() => expect(activeOperation).toHaveBeenCalledTimes(1));
    const first = scheduler.runCatalog('same-key', 'manual_refresh', queuedOperation, { unavailable });
    const second = scheduler.runCatalog('same-key', 'manual_refresh', queuedOperation, { unavailable });
    const overflow = scheduler.runCatalog('another-key', 'manual_refresh', queuedOperation, { unavailable });

    await expect(overflow).resolves.toEqual(unavailable());
    activeReleases.shift()?.();
    await expect(active).resolves.toEqual({ status: 'success' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'success' },
      { status: 'success' },
    ]);
    expect(queuedOperation).toHaveBeenCalledTimes(1);
  });

  it('removes a cancelled queued waiter and never executes its obsolete work', async () => {
    const activeReleases: Array<() => void> = [];
    const activeOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      activeReleases.push(() => resolve({ status: 'success' }));
    }));
    const queuedOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const controller = new AbortController();
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', activeOperation, { unavailable });
    await vi.waitFor(() => expect(activeOperation).toHaveBeenCalledTimes(1));
    const queued = scheduler.runCatalog('cancelled', 'manual_refresh', queuedOperation, {
      unavailable,
      signal: controller.signal,
    });
    controller.abort();

    await expect(queued).resolves.toEqual(unavailable());
    activeReleases.shift()?.();
    await expect(active).resolves.toEqual({ status: 'success' });
    expect(queuedOperation).not.toHaveBeenCalled();

    await expect(scheduler.runCatalog('cancelled', 'manual_refresh', queuedOperation, { unavailable }))
      .resolves.toEqual({ status: 'success' });
    expect(queuedOperation).toHaveBeenCalledTimes(1);
  });

  it('keeps queued same-key work alive for a second caller when the first caller cancels', async () => {
    const activeReleases: Array<() => void> = [];
    const activeOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      activeReleases.push(() => resolve({ status: 'success' }));
    }));
    const queuedOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const controller = new AbortController();
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', activeOperation, { unavailable });
    await vi.waitFor(() => expect(activeOperation).toHaveBeenCalledTimes(1));
    const cancelled = scheduler.runCatalog('same-key', 'manual_refresh', queuedOperation, {
      unavailable,
      signal: controller.signal,
    });
    const retained = scheduler.runCatalog('same-key', 'manual_refresh', queuedOperation, { unavailable });
    controller.abort();

    await expect(cancelled).resolves.toEqual(unavailable());
    activeReleases.shift()?.();
    await expect(active).resolves.toEqual({ status: 'success' });
    await expect(retained).resolves.toEqual({ status: 'success' });
    expect(queuedOperation).toHaveBeenCalledTimes(1);
  });

  it('keeps started work alive after every waiter detaches', async () => {
    let releaseStartedWork!: () => void;
    const startedOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releaseStartedWork = () => resolve({ status: 'success' });
    }));
    const replacementOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const controller = new AbortController();
    const scheduler = createProviderProbeScheduler();

    const detached = scheduler.runCatalog('connection-a', 'picker_open', startedOperation, {
      unavailable,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(startedOperation).toHaveBeenCalledOnce());
    controller.abort();
    await expect(detached).resolves.toEqual(unavailable());

    const retained = scheduler.runCatalog('connection-a', 'detail_open', replacementOperation, { unavailable });
    releaseStartedWork();

    await expect(retained).resolves.toEqual({ status: 'success' });
    expect(startedOperation).toHaveBeenCalledOnce();
    expect(replacementOperation).not.toHaveBeenCalled();
  });

  it('refuses a waiter that loses currentness before dispatch without probing', async () => {
    const activeReleases: Array<() => void> = [];
    const activeOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      activeReleases.push(() => resolve({ status: 'success' }));
    }));
    const staleOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    let current = true;
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', activeOperation, { unavailable });
    await vi.waitFor(() => expect(activeOperation).toHaveBeenCalledTimes(1));
    const stale = scheduler.runCatalog('stale', 'manual_refresh', staleOperation, {
      unavailable,
      isCurrent: () => current,
    });
    current = false;
    activeReleases.shift()?.();

    await expect(active).resolves.toEqual({ status: 'success' });
    await expect(stale).resolves.toEqual(unavailable());
    expect(staleOperation).not.toHaveBeenCalled();
  });

  it('does not retain a unique pending key when currentness flips during admission', async () => {
    let releaseActive!: () => void;
    const activeOperation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releaseActive = () => resolve({ status: 'success' });
    }));
    const staleOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    const nextOperation = vi.fn().mockResolvedValue({ status: 'success' } as const);
    let currentChecks = 0;
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', activeOperation, { unavailable });
    await vi.waitFor(() => expect(activeOperation).toHaveBeenCalledTimes(1));
    const stale = scheduler.runCatalog('stale', 'manual_refresh', staleOperation, {
      unavailable,
      isCurrent: () => ++currentChecks === 1,
    });
    await expect(stale).resolves.toEqual(unavailable());

    const next = scheduler.runCatalog('next', 'manual_refresh', nextOperation, { unavailable });
    releaseActive();
    await expect(active).resolves.toEqual({ status: 'success' });
    await expect(next).resolves.toEqual({ status: 'success' });
    expect(staleOperation).not.toHaveBeenCalled();
    expect(nextOperation).toHaveBeenCalledOnce();
  });

  it('separates exhausted local admission from a caller that stopped waiting', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(() => new Promise<TestScheduledResult>((resolve) => {
      releases.push(() => resolve({ status: 'success' }));
    }));
    const capacityExhausted = (): TestScheduledResult => ({
      status: 'error',
      error: { code: 'provider_probe_capacity_exhausted' },
    });
    const waiter = { unavailable, localCapacityUnavailable: capacityExhausted } as const;
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });

    const active = scheduler.runCatalog('active', 'manual_refresh', operation, waiter);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    const queued = scheduler.runCatalog('queued', 'manual_refresh', operation, waiter);

    // No endpoint request is attempted for either refusal below.
    await expect(scheduler.runCatalog('refused', 'manual_refresh', operation, waiter))
      .resolves.toEqual(capacityExhausted());
    await expect(scheduler.runCatalogAfter('active', 'frontier', operation, waiter))
      .resolves.toEqual(capacityExhausted());

    const controller = new AbortController();
    controller.abort();
    await expect(scheduler.runCatalog('cancelled', 'manual_refresh', operation, {
      ...waiter,
      signal: controller.signal,
    })).resolves.toEqual(unavailable());

    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(Promise.all([active, queued])).resolves.toEqual([
      { status: 'success' },
      { status: 'success' },
    ]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('drains keyed state after success, failure, and queued cancellation', async () => {
    const scheduler = createProviderProbeScheduler({
      maxConcurrentOperations: 1,
      maxPendingOperations: 1,
    });
    const success = vi.fn().mockResolvedValue({ status: 'success' } as const);
    await expect(scheduler.runCatalog('success', 'manual_refresh', success, { unavailable }))
      .resolves.toEqual({ status: 'success' });
    await expect(scheduler.runCatalog('success', 'manual_refresh', success, { unavailable }))
      .resolves.toEqual({ status: 'success' });
    expect(success).toHaveBeenCalledTimes(2);

    const failing = vi.fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ status: 'success' } as const);
    await expect(scheduler.runCatalog('failure', 'manual_refresh', failing, { unavailable }))
      .rejects.toThrow('probe failed');
    await expect(scheduler.runCatalog('failure', 'manual_refresh', failing, { unavailable }))
      .resolves.toEqual({ status: 'success' });
    expect(failing).toHaveBeenCalledTimes(2);

    let releaseActive!: () => void;
    const active = scheduler.runCatalog('active', 'manual_refresh', () => new Promise<TestScheduledResult>((resolve) => {
      releaseActive = () => resolve({ status: 'success' });
    }), { unavailable });
    const controller = new AbortController();
    const aborted = scheduler.runCatalog('aborted', 'manual_refresh', success, {
      unavailable,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).resolves.toEqual(unavailable());
    releaseActive();
    await expect(active).resolves.toEqual({ status: 'success' });
    await expect(scheduler.runCatalog('aborted', 'manual_refresh', success, { unavailable }))
      .resolves.toEqual({ status: 'success' });
  });
});
