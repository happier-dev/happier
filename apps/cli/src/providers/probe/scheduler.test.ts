import { describe, expect, it, vi } from 'vitest';
import { createProviderProbeScheduler } from './scheduler';

type ProbeOutcome = { status: 'success'; loaded?: boolean } | { status: 'unavailable' };
const unavailable = (): ProbeOutcome => ({ status: 'unavailable' });
const options = { unavailable };
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('provider probe scheduler', () => {
  it('dispatches every distinct demanded observation without a local concurrency ceiling', async () => {
    const scheduler = createProviderProbeScheduler();
    const pending = held<ProbeOutcome>();
    const operation = vi.fn(() => pending.promise);
    const requests = Array.from({ length: 70 }, (_, index) => scheduler.runCatalog(
      `source-${index}`, 'picker_open', operation, options,
    ));
    expect(operation).toHaveBeenCalledTimes(70);
    pending.resolve({ status: 'success' });
    expect(await Promise.all(requests)).toHaveLength(70);
  });

  it('retries recovered sources on the next demand without an invented failure delay', async () => {
    const scheduler = createProviderProbeScheduler();
    const operation = vi.fn().mockResolvedValueOnce({ status: 'error' })
      .mockResolvedValue({ status: 'success' });
    await scheduler.runCatalog('source', 'detail_open', operation, options);
    await expect(scheduler.runCatalog('source', 'picker_open', operation, options))
      .resolves.toEqual({ status: 'success' });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('single-flights current demand and releases settled successes and failures', async () => {
    const scheduler = createProviderProbeScheduler();
    const pending = held<ProbeOutcome>();
    const operation = vi.fn(() => pending.promise);
    const first = scheduler.runCatalog('source', 'picker_open', operation, options);
    const second = scheduler.runCatalog('source', 'detail_open', operation, options);
    expect(operation).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'success' });
    await Promise.all([first, second]);
    await scheduler.runCatalog('source', 'picker_open', operation, options);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('honors only endpoint Retry-After and lets manual recovery bypass it', async () => {
    let now = 1_000;
    const scheduler = createProviderProbeScheduler({ now: () => now });
    const operation = vi.fn().mockResolvedValue({ status: 'error', error: { retryAfterMs: 120_000 } });
    await scheduler.runCatalog('source', 'detail_open', operation, options);
    await scheduler.runCatalog('source', 'picker_open', operation, options);
    expect(operation).toHaveBeenCalledTimes(1);
    now += 120_000;
    await scheduler.runCatalog('source', 'picker_open', operation, options);
    await scheduler.runCatalog('source', 'manual_refresh', operation, options);
    expect(operation).toHaveBeenCalledTimes(3);
    operation.mockResolvedValue({ status: 'success' });
    await scheduler.runCatalog('source', 'manual_refresh', operation, options);
    await expect(scheduler.runCatalog('source', 'picker_open', operation, options)).resolves.toEqual({ status: 'success' });
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('isolates caller cancellation and aborts transport when final demand ends', async () => {
    const scheduler = createProviderProbeScheduler();
    const pending = held<ProbeOutcome>();
    const operation = vi.fn((_signal: AbortSignal) => pending.promise);
    const first = new AbortController();
    const second = new AbortController();
    const one = scheduler.runCatalog('source', 'picker_open', operation, { ...options, signal: first.signal });
    const two = scheduler.runCatalog('source', 'detail_open', operation, { ...options, signal: second.signal });
    first.abort();
    await expect(one).resolves.toEqual(unavailable());
    expect(operation.mock.calls[0]![0].aborted).toBe(false);
    second.abort();
    await expect(two).resolves.toEqual(unavailable());
    expect(operation.mock.calls[0]![0].aborted).toBe(true);
    // An unabortable boundary retains custody until its real promise settles.
    const three = scheduler.runCatalog('source', 'picker_open', operation, options);
    expect(operation).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'success' });
    await three;
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('observes each explicit Load freshly after older reads without a frontier graph', async () => {
    const scheduler = createProviderProbeScheduler();
    const old = held<ProbeOutcome>();
    const older = scheduler.runCatalog('source', 'picker_open', () => old.promise, options);
    const observe = vi.fn(async (): Promise<ProbeOutcome> => ({ status: 'success', loaded: true }));
    const first = scheduler.runCatalogFresh('source', observe, options);
    const second = scheduler.runCatalogFresh('source', observe, options);
    expect(observe).not.toHaveBeenCalled();
    old.resolve({ status: 'success', loaded: false });
    await older;
    await expect(first).resolves.toMatchObject({ loaded: true });
    await expect(second).resolves.toMatchObject({ loaded: true });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('lets cancellation retire a fresh waiter while an older read is pending', async () => {
    const scheduler = createProviderProbeScheduler();
    const old = held<ProbeOutcome>();
    const older = scheduler.runCatalog('source', 'picker_open', () => old.promise, options);
    const controller = new AbortController();
    const observe = vi.fn(async (): Promise<ProbeOutcome> => ({ status: 'success' }));
    const fresh = scheduler.runCatalogFresh('source', observe, { ...options, signal: controller.signal });
    controller.abort();
    await expect(fresh).resolves.toEqual(unavailable());
    old.resolve({ status: 'success' });
    await older;
    expect(observe).not.toHaveBeenCalled();
  });

  it('dispatches DNS demand without a scheduler ceiling and preserves containing cancellation', async () => {
    const scheduler = createProviderProbeScheduler();
    const pending = held<string>();
    const operation = vi.fn(() => pending.promise);
    const controller = new AbortController();
    const requests = Array.from({ length: 70 }, () => scheduler.runDns(operation, {
      wallDeadlineAtMs: Infinity, signal: controller.signal,
    }));
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(70));
    controller.abort();
    expect((await Promise.allSettled(requests)).every(result => result.status === 'rejected')).toBe(true);
    pending.resolve('done');
  });
});
