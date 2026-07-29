import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PROBE_REFRESH_TRIGGERS,
  createProviderProbeScheduler,
} from './scheduler';

describe('provider probe scheduler', () => {
  it('single-flights identical work and retains successful results for the catalog TTL', async () => {
    let now = 1_000;
    let resolve!: (value: { status: 'success' }) => void;
    const operation = vi.fn(() => new Promise<{ status: 'success' }>((done) => { resolve = done; }));
    const scheduler = createProviderProbeScheduler({ now: () => now, random: () => 0.5 });
    const first = scheduler.runCatalog('connection-a', 'picker_open', operation);
    const second = scheduler.runCatalog('connection-a', 'detail_open', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    resolve({ status: 'success' });
    await expect(first).resolves.toEqual({ status: 'success' });
    await expect(second).resolves.toEqual({ status: 'success' });

    await scheduler.runCatalog('connection-a', 'picker_open', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    now += 5 * 60_000 + 1;
    operation.mockResolvedValueOnce({ status: 'success' });
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('backs failures off, while explicit manual refresh bypasses the delay', async () => {
    let now = 1_000;
    const operation = vi.fn().mockResolvedValue({ status: 'error' });
    const scheduler = createProviderProbeScheduler({ now: () => now, random: () => 0.5 });
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
    await scheduler.runCatalog('connection-a', 'picker_open', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await scheduler.runCatalog('connection-a', 'manual_refresh', operation);
    expect(operation).toHaveBeenCalledTimes(2);
    now += 60_001;
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
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
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
    await scheduler.runCatalog('connection-a', 'enable', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('bounds completed request identities so draft/config churn cannot grow daemon memory without limit', async () => {
    const operation = vi.fn().mockResolvedValue({ status: 'success' });
    const scheduler = createProviderProbeScheduler({
      now: () => 1_000,
      random: () => 0.5,
      maxCompletedEntriesPerLane: 3,
    });
    await scheduler.runCatalog('request-a', 'picker_open', operation);
    await scheduler.runCatalog('request-b', 'picker_open', operation);
    await scheduler.runCatalog('request-c', 'picker_open', operation);
    await scheduler.runCatalog('request-d', 'picker_open', operation);
    await scheduler.runCatalog('request-a', 'picker_open', operation);

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
      scheduler.runCatalog('catalog-a', 'manual_refresh', operation),
      scheduler.runHealth('health-a', 'manual_refresh', operation),
      scheduler.runCatalog('catalog-b', 'manual_refresh', operation),
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
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
    now += 60_000;
    await scheduler.runCatalog('connection-a', 'picker_open', operation);
    expect(operation).toHaveBeenCalledTimes(1);
    now += 60_001;
    await scheduler.runCatalog('connection-a', 'detail_open', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('serializes causal refresh frontiers after older demand without coalescing distinct mutations', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 'success' as const };
    });
    const scheduler = createProviderProbeScheduler();
    const demand = scheduler.runCatalog('connection-a', 'picker_open', operation);
    const firstMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation);
    const sameMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-a', operation);
    const retryMutation = scheduler.runCatalogAfter('connection-a', 'dispatch-b', operation);
    expect(operation).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await Promise.all([demand, firstMutation, sameMutation, retryMutation]);
  });
});
