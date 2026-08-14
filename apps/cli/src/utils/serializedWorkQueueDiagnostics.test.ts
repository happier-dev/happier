import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSerializedWorkQueueDiagnostics } from './serializedWorkQueueDiagnostics';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('createSerializedWorkQueueDiagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent for normal serialized work', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const diagnostics = createSerializedWorkQueueDiagnostics({
      queueName: 'test-queue',
      slowAfterMs: 30_000,
      report,
    });

    const tracked = diagnostics.track({ operation: 'normal' });
    await tracked.run(async () => 'done');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(report).not.toHaveBeenCalled();
  });

  it('reports one slow incident and one recovery without logging every queued item', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const diagnostics = createSerializedWorkQueueDiagnostics({
      queueName: 'test-queue',
      slowAfterMs: 30_000,
      report,
    });
    const first = createDeferred<void>();
    const second = createDeferred<void>();

    const firstTracked = diagnostics.track({ operation: 'first', details: { localId: 'local-1' } });
    const secondTracked = diagnostics.track({ operation: 'second', details: { localId: 'local-2' } });
    const firstRun = firstTracked.run(async () => await first.promise);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'slow',
      queueName: 'test-queue',
      reason: 'active_duration',
      operation: 'first',
      details: { localId: 'local-1' },
      depth: 2,
    }));

    await vi.advanceTimersByTimeAsync(90_000);
    expect(report).toHaveBeenCalledTimes(1);

    first.resolve();
    await firstRun;
    const secondRun = secondTracked.run(async () => await second.promise);
    second.resolve();
    await secondRun;

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'recovered',
      incidentForMs: 120_000,
      queueName: 'test-queue',
      peakDepth: 2,
    }));
  });

  it('reports cumulative queue wait even when no individual operation crosses the threshold', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const diagnostics = createSerializedWorkQueueDiagnostics({
      queueName: 'test-queue',
      slowAfterMs: 30_000,
      report,
    });

    const firstTracked = diagnostics.track({ operation: 'first' });
    const secondTracked = diagnostics.track({ operation: 'second' });
    const thirdTracked = diagnostics.track({ operation: 'third', details: { eventType: 'tool-result' } });

    await firstTracked.run(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await secondTracked.run(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await thirdTracked.run(async () => undefined);

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'slow',
      reason: 'queue_wait',
      operation: 'third',
      queuedForMs: 40_000,
      details: { eventType: 'tool-result' },
    }));
    expect(report).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'recovered' }));
  });

  it('never lets a diagnostic reporter failure affect queued work', async () => {
    vi.useFakeTimers();
    const diagnostics = createSerializedWorkQueueDiagnostics({
      queueName: 'test-queue',
      slowAfterMs: 30_000,
      report: () => {
        throw new Error('diagnostic sink unavailable');
      },
    });
    const blocked = createDeferred<string>();
    const tracked = diagnostics.track({ operation: 'protected-work' });
    const work = tracked.run(async () => await blocked.promise);

    await vi.advanceTimersByTimeAsync(30_000);
    blocked.resolve('completed');

    await expect(work).resolves.toBe('completed');
  });
});
