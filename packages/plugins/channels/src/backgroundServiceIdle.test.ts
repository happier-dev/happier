import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function collectionBoundary(onRead?: (reads: number) => void, queryFailure?: PluginError) {
  const listeners = new Set<() => void>();
  let populated = false;
  let reads = 0;
  return {
    listeners,
    get reads() { return reads; },
    populate() { populated = true; for (const listener of listeners) listener(); },
    reset() { for (const listener of listeners) listener(); },
    async query(request: Readonly<{ prefix?: readonly unknown[] }>) {
      reads += 1;
      if (queryFailure) throw queryFailure;
      const page = { rows: populated && request.prefix === undefined
        ? [{ rowId: 'identity', revision: 1, value: { id: 'identity', 'record-kind': 'connection-identity-key' } }]
        : [], changeCursor: reads };
      onRead?.(reads);
      return page;
    },
    watch(_request: unknown, listener: () => void) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
  };
}

function backgroundContext(state: ReturnType<typeof collectionBoundary>, deliveries: ReturnType<typeof collectionBoundary>, signal: AbortSignal) {
  // Account Collection transport and invalidation are genuine host boundaries.
  const services = {
    storage: { account: { collection: (definition: Readonly<{ id: string }>) => (
      definition.id === CHANNEL_DELIVERIES_COLLECTION.id ? deliveries : state
    ) } },
    logger: { info: vi.fn(), warn: vi.fn() },
    events: { plugin: { emit: vi.fn(async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 })) } },
  } as unknown as PluginServices;
  return {
    surface: 'background',
    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    contribution: { id: 'idle-test', qualifiedId: `${PLUGIN_MANIFEST.id}/backgroundServices/idle-test` },
    invokedAtMs: 0,
    signal,
    services,
  } satisfies BackgroundServiceContext;
}

describe('registered Channels background service idle demand', () => {
  it.each(['ingress-supervisor', 'outward-delivery-supervisor'])(
    '%s parks an empty Account, recovers on reset/mutation and retires its watches', async (id) => {
      vi.useFakeTimers();
      const state = collectionBoundary();
      const deliveries = collectionBoundary();
      const generation = new AbortController();
      const context = backgroundContext(state, deliveries, generation.signal);
      const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: context.services });
      const runner = activation.registration('backgroundServices', id);
      if (!runner) throw new Error('Expected registered background service');
      const run = runner(context);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const initialReads = state.reads + deliveries.reads;
        expect(initialReads).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.reads + deliveries.reads).toBe(initialReads);
        expect(state.listeners.size + deliveries.listeners.size).toBeGreaterThan(0);

        state.reset();
        await vi.advanceTimersByTimeAsync(0);
        const resetReads = state.reads + deliveries.reads;
        expect(resetReads).toBeGreaterThan(initialReads);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.reads + deliveries.reads).toBe(resetReads);

        state.populate();
        await vi.advanceTimersByTimeAsync(0);
        expect(state.reads + deliveries.reads).toBeGreaterThan(resetReads);
        // Watches now belong to the active supervisor, not an initial waiter.
        expect(state.listeners.size + deliveries.listeners.size).toBeGreaterThan(0);
      } finally {
        generation.abort();
        await run;
        await activation.dispose();
        vi.useRealTimers();
      }
      expect(state.listeners.size + deliveries.listeners.size).toBe(0);
    },
  );

  it.each(['ingress-supervisor', 'outward-delivery-supervisor'])(
    '%s settles a refused Collection through registration and admits a fresh activation', async (id) => {
      vi.useFakeTimers();
      const state = collectionBoundary(undefined, new PluginError({
        code: 'collection_update_required', message: 'Update required', retryable: false,
      }));
      const deliveries = collectionBoundary();
      const generation = new AbortController();
      const context = backgroundContext(state, deliveries, generation.signal);
      const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: context.services });
      const runner = activation.registration('backgroundServices', id);
      if (!runner) throw new Error('Expected registered background service');
      try {
        await runner(context);
        const settledReads = state.reads + deliveries.reads;
        expect(settledReads).toBeGreaterThan(0);
        for (let i = 0; i < 100; i += 1) state.reset();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(state.reads + deliveries.reads).toBe(settledReads);
        expect(state.listeners.size + deliveries.listeners.size).toBe(0);

        const freshState = collectionBoundary();
        const freshDeliveries = collectionBoundary();
        const fresh = new AbortController();
        const freshContext = backgroundContext(freshState, freshDeliveries, fresh.signal);
        const freshActivation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: freshContext.services });
        const freshRunner = freshActivation.registration('backgroundServices', id);
        if (!freshRunner) throw new Error('Expected fresh registered background service');
        const run = freshRunner(freshContext);
        try {
          await vi.advanceTimersByTimeAsync(0);
          expect(freshState.reads + freshDeliveries.reads).toBeGreaterThan(0);
        } finally {
          fresh.abort();
          await run;
          await freshActivation.dispose();
        }
        expect(freshState.listeners.size + freshDeliveries.listeners.size).toBe(0);
      } finally {
        generation.abort();
        await activation.dispose();
        vi.useRealTimers();
      }
    },
  );

});
