import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, plainQuotaResponse,
  resetConnectedServiceQuotaSnapshotsTestState } from './useConnectedServiceQuotaSnapshots.testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

function weeklySnapshot(profileId = 'work', meterId = 'weekly', label = 'Weekly', used = 82) {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1, serviceId: 'anthropic', profileId, fetchedAt: Date.now(), staleAfterMs: 60_000,
    planLabel: 'Pro', accountLabel: null,
    meters: [{ meterId, label, used, limit: 100, unit: 'count', utilizationPct: null,
      resetsAt: null, status: 'ok', details: {} }],
  });
}

function sealedResponse(snapshot: ReturnType<typeof weeklySnapshot>) {
  const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
    material: { type: 'legacy', secret: new Uint8Array(32).fill(3) }, payload: snapshot,
    randomBytes: length => new Uint8Array(length).fill(7),
  });
  return Response.json({ sealed: { format: 'account_scoped_v1', ciphertext },
    metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' } });
}

describe('useConnectedServiceQuotaBadges', () => {
  let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
  const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
  const profiles = [{ serviceId: 'anthropic', profileId: 'work' }] as const;
  beforeEach(async () => {
    await resetConnectedServiceQuotaSnapshotsTestState();
    boundary = await createLegacyQuotaTestHarness({ accountMode: 'e2ee' });
    storage.getState().applySettingsLocal({ connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] } });
    // Settle unrelated Account bootstrap before measuring badge HTTP demand.
    // Lifecycle suites deliberately own their bootstrap/clock ordering instead.
    await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition();
    await flushHookEffects();
    boundary.modeRead.mockClear();
  });
  afterEach(async () => { standardCleanup(); vi.useRealTimers(); await boundary.dispose(); vi.restoreAllMocks(); });

  it('returns badges for pinned meters after snapshot fetch', async () => {
    boundary.sealedRead.mockImplementation(async () => sealedResponse(weeklySnapshot()));
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const hook = await renderHook(() => useConnectedServiceQuotaBadges(profiles), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.text)).toContain('Weekly 18%');
  });

  it('supports plaintext quotas in plaintext accounts', async () => {
    await boundary.dispose();
    boundary = await createLegacyQuotaTestHarness();
    boundary.plainRead.mockImplementation(async () => plainQuotaResponse(weeklySnapshot()));
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const hook = await renderHook(() => useConnectedServiceQuotaBadges(profiles), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.text)).toContain('Weekly 18%');
    expect(boundary.sealedRead).not.toHaveBeenCalled();
  });

  it('recovers a pinned key after an initial miss when its Account quota changes', async () => {
    vi.useFakeTimers();
    // An absent snapshot has no producer deadline. Live quota changes, rather
    // than an invented polling cadence, demand the next read.
    boundary.sealedRead.mockImplementation(async () => new Response('{}', { status: 404 }));
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const hook = await renderHook(() => useConnectedServiceQuotaBadges(profiles), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    const initialReads = boundary.sealedRead.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.text)).not.toContain('Weekly 18%');
    boundary.sealedRead.mockImplementation(async () => sealedResponse(weeklySnapshot()));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(boundary.sealedRead).toHaveBeenCalledTimes(initialReads);
    await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
      [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(boundary.sealedRead).toHaveBeenCalledTimes(initialReads + 1);
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.text)).toContain('Weekly 18%');
  });

  it('does not fetch quota snapshots in cache-only mode', async () => {
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const hook = await renderHook(() => useConnectedServiceQuotaBadges(profiles, { fetchPolicy: 'cache_only' }), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(boundary.modeRead).not.toHaveBeenCalled();
    expect(boundary.plainRead).not.toHaveBeenCalled();
    expect(boundary.sealedRead).not.toHaveBeenCalled();
    expect(hook.getCurrent()).toEqual({ 'anthropic/work': [] });
  });

  it('uses cached quota snapshots for default cache-only badges without pinned meters or polling', async () => {
    storage.getState().applySettingsLocal({ connectedServicesQuotaPinnedMeterIdsByKey: {} });
    const snapshots = { work: weeklySnapshot(), backup: weeklySnapshot('backup', 'daily', 'Daily', 40) };
    boundary.sealedRead.mockImplementation(async ref => sealedResponse(snapshots[ref.profileId as keyof typeof snapshots]));
    const bothProfiles = [...profiles, { serviceId: 'anthropic', profileId: 'backup' }] as const;
    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const fetched = await renderHook(() => useConnectedServiceQuotaSnapshots(bothProfiles), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(fetched.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    expect(fetched.getCurrent().snapshotsByKey['anthropic/backup']?.meters[0]?.meterId).toBe('daily');
    await fetched.unmount();
    boundary.modeRead.mockClear(); boundary.plainRead.mockClear(); boundary.sealedRead.mockClear();
    vi.useFakeTimers();
    const hook = await renderHook(() => useConnectedServiceQuotaBadges(bothProfiles, { fetchPolicy: 'cache_only' }), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.meterId)).toEqual(['weekly']);
    expect(hook.getCurrent()['anthropic/work']?.map(badge => badge.text)).toContain('Weekly 18%');
    expect(hook.getCurrent()['anthropic/backup']?.map(badge => badge.meterId)).toEqual(['daily']);
    expect(hook.getCurrent()['anthropic/backup']?.map(badge => badge.text)).toContain('Daily 60%');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(boundary.modeRead).not.toHaveBeenCalled();
    expect(boundary.plainRead).not.toHaveBeenCalled();
    expect(boundary.sealedRead).not.toHaveBeenCalled();
  });
});
