import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServerFeaturesSnapshotRefreshLoop } from './serverFeaturesSnapshotRefreshLoop';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { createLocalServicesDaemonFeatureGate } from './local/services/featureGate';

describe('startServerFeaturesSnapshotRefreshLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delivers a server feature flip to snapshot consumers at the next connection refresh', async () => {
    let enabled = true;
    // HTTP is the external boundary; the store, refresh loop and feature gate are real.
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      features: { localServices: { enabled } }, capabilities: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const store = createServerUrlServerFeaturesSnapshotStore({
      serverUrl: 'https://daemon-home.test', token: 'fixture-token',
    });
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh: async () => { await store.refresh(); },
      isTransitionActive: store.isRefreshTransitionActive,
      transitionIntervalMs: 30_000,
    });
    const gate = createLocalServicesDaemonFeatureGate({
      env: {}, resolveServerFeaturesSnapshot: store.getSnapshot,
    });
    try {
      await loop.refresh();
      await gate.refresh();
      expect(gate.isEnabled('localServices')).toBe(true);
      enabled = false;
      await gate.refresh();
      expect(gate.isEnabled('localServices')).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      // startDaemon's onMachineConnectionOnline calls this existing lifecycle owner.
      await loop.refresh();
      await gate.refresh();
      expect(gate.isEnabled('localServices')).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      loop.stop();
    }
  });

  it('parks after Home indexing settles and refreshes on the next connection change', async () => {
    vi.useFakeTimers();
    let transitionActive = true;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 2) transitionActive = false;
    });
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => transitionActive,
      transitionIntervalMs: 30_000,
    });

    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    transitionActive = true;
    await loop.refresh();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    transitionActive = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    loop.stop();
  });

  it('joins a connection refresh and never rearms after stopping an in-flight refresh', async () => {
    vi.useFakeTimers();
    let finishRefresh!: () => void;
    const heldRefresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const refresh = vi.fn(async () => { await heldRefresh; });
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => true,
      transitionIntervalMs: 30_000,
    });
    const first = loop.refresh();
    const second = loop.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    loop.stop();
    finishRefresh();
    await first;
    expect(vi.getTimerCount()).toBe(0);
    await loop.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('cancels the pending one-shot refresh when stopped', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => true,
      transitionIntervalMs: 30_000,
    });

    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledOnce();
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
