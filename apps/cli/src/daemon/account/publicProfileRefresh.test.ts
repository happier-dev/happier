import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { startPublicProfileRefresh } from './publicProfileRefresh';
import { createNativePublicProfileRefreshFixture } from './publicProfileRefresh.testkit';

const DAY_MS = 24 * 60 * 60 * 1_000;

describe('native Account public-profile refresh participant', () => {
  const handles: ReturnType<typeof startPublicProfileRefresh>[] = [];
  const fixtures: Awaited<ReturnType<typeof createNativePublicProfileRefreshFixture>>[] = [];
  beforeEach(() => {
    // Only the daemon clock is virtual; Fastify's OS task queue stays real.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  });
  afterEach(async () => {
    for (const fixture of fixtures) fixture.releaseReads();
    for (const handle of handles.splice(0)) await handle.stop();
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
    vi.useRealTimers();
  });

  async function fixture() {
    const account = await createNativePublicProfileRefreshFixture();
    fixtures.push(account);
    let online = true;
    const lifetime = new AbortController();
    const scheduler = createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      gate: () => online ? { status: 'open' } : { status: 'deferred', reason: 'offline' },
    });
    const start = () => {
      const handle = startPublicProfileRefresh({ actions: account.actions, scheduler, signal: lifetime.signal });
      handles.push(handle);
      return handle;
    };
    return { ...account, scheduler, start, lifetime, setOnline: (value: boolean) => { online = value; } };
  }

  it('refreshes due published facts at startup and daily through the real Usage builder and snapshot HTTP owner', async () => {
    const f = await fixture();
    const before = f.readOwner();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1), { interval: 0 });
    expect(f.refreshes).toHaveLength(1);
    expect(f.refreshes[0]).toMatchObject({ query: { population: 'public_eligible_personal' },
      snapshot: { computedAtMs: Date.now(), facts: { tokens: 10 } } });
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1);
    const after = f.readOwner();
    if (before.kind !== 'ready' || after.kind !== 'ready') throw new Error('Expected remote published record');
    expect(after.record.layout).toEqual(before.record.layout);
    expect(after.record.appearance).toEqual(before.record.appearance);
    expect(f.requests.filter(request => request.method !== 'GET' && !['/v2/usage/query', '/v2/sessions/read-batch'].includes(request.path))).toEqual([
      { method: 'PUT', path: '/v1/account/public-profile/snapshot' },
    ]);
    expect(Object.keys(f.refreshes[0]!).sort()).toEqual(['query', 'snapshot']);
    expect(JSON.stringify(f.refreshes)).not.toMatch(/private-|98765|87654|reportedUsd|estimatedUsd/);
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(f.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(2), { interval: 0 });
    expect(f.refreshes).toHaveLength(2);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(2);
    f.setSettings({ v: 1, actions: { 'account.public_profile.refresh': { enabled: false } } });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(1), { interval: 0 });
    expect(f.refreshes).toHaveLength(2);
  });

  it('uses the stored snapshot computation time for the exact first daily deadline', async () => {
    const f = await fixture();
    f.setComputedAt(Date.now() - DAY_MS + 123);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(1), { interval: 0 });
    await vi.advanceTimersByTimeAsync(122);
    expect(f.refreshes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1), { interval: 0 });
    expect(f.refreshes).toHaveLength(1);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1);
  });

  it('uses snapshot computation time, not source lag or a delayed HTTP acknowledgement, for the next daily deadline', async () => {
    const f = await fixture();
    const startedAt = Date.now();
    f.setSourceLag(500);
    const pending = f.holdNextRefreshAck();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    expect(f.refreshes[0]?.snapshot.computedAtMs).toBe(startedAt);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    pending.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1), { interval: 0 });
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 1_001);
    expect(f.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(2), { interval: 0 });
    expect(f.refreshes).toHaveLength(2);
  });

  it('keeps previous facts after a real Usage HTTP refusal and retries only on the daily cadence', async () => {
    const f = await fixture();
    const before = f.readOwner();
    f.setUsageAvailable(false);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(1), { interval: 0 });
    expect(f.refreshes).toEqual([]);
    expect(f.readOwner()).toEqual(before);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 1 });
    const reads = f.requests.length;
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(f.requests).toHaveLength(reads);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(2), { interval: 0 });
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 2 });
    expect(f.refreshes).toEqual([]);
  });

  it('defers offline and wakes on reconnect without resuming a paused remote profile', async () => {
    const f = await fixture();
    f.setOnline(false);
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toEqual([]);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.deferred).toBe(1);
    loop.pause();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    f.setOnline(true);
    loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1), { interval: 0 });
    expect(f.refreshes).toHaveLength(1);
    loop.pause();
    f.pauseProfile();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(1), { interval: 0 });
    expect(f.refreshes).toHaveLength(1);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(1);
  });

  it.each([
    { name: 'Ask', settings: { v: 1, actions: { 'account.public_profile.refresh': { approvalRequiredSurfaces: ['cli'] } } } },
    { name: 'Off', settings: { v: 1, actions: { 'account.public_profile.refresh': { enabled: false } } } },
  ])('does not write or open an approval under $name CLI policy', async ({ settings }) => {
    const f = await fixture();
    f.setSettings(settings);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.suppressed).toBe(1), { interval: 0 });
    expect(f.refreshes).toEqual([]);
    expect(f.requests.filter(request => request.method !== 'GET' && !['/v2/usage/query', '/v2/sessions/read-batch'].includes(request.path))).toEqual([]);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters).toMatchObject({ written: 0, suppressed: 1 });
    const requestCount = f.requests.length;
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(f.requests).toHaveLength(requestCount);
  });

  it('rejects a response after captured credentials retire and never dispatches preparation', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    f.retire();
    pending.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    expect(f.scheduler.getSnapshot().purposes.accountMaintenance?.counters.written).toBe(0);
  });

  it('aborts and drains a pending Account HTTP request before stop completes', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    expect(f.getRequestSignal()?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending.release();
    await stopping;
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(f.requests).toHaveLength(1);
  });

  it('aborts pending Account HTTP immediately when the captured lifetime retires', async () => {
    const f = await fixture();
    const pending = f.holdNextRead();
    const loop = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await pending.accepted;
    f.lifetime.abort();
    expect(f.getRequestSignal()?.aborted).toBe(true);
    pending.release();
    await loop.stop();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(f.requests).toHaveLength(1);
  });
});
