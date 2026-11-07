import type { ConnectedServiceId } from '@happier-dev/protocol';
import { AccountSettingsStaleError, AccountSettingsContentInvalidError } from '@/settings/accountSettings/accountSettingsRefreshError';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonServerWorkBudget } from '../../serverWork/createDaemonServerWorkBudget';
import { createDaemonServerWorkScheduler } from '../../serverWork/createDaemonServerWorkScheduler';
import { resolveConnectedServiceQuotasDaemonOptions } from '../quotas/resolveConnectedServiceQuotasDaemonOptions';
import { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from './currentSourceHydration';
import { createProviderAccountUsageStore } from './store';
import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from './startupActivation';

function createActivation() {
  const options = resolveConnectedServiceQuotasDaemonOptions({});
  const abort = new AbortController();
  const warnings: unknown[] = [];
  const scheduler = createDaemonServerWorkScheduler({
    budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
    logger: { warn: (_message, details) => { warnings.push(details); } },
  });
  // The API is the server boundary; hydration, store, budget and scheduler stay real.
  const listProfiles = vi.fn(async () => ({ serviceId: 'openai-codex' as const, profiles: [{ profileId: 'work' }] }));
  const store = createProviderAccountUsageStore();
  const order: string[] = [];
  let refreshSources: unknown;
  let started = false;
  const coordinator = { scheduleCurrentSourceRefresh: (sources: unknown) => { refreshSources = sources; order.push('schedule'); } };
  const input = {
    enabled: true,
    quotaFetchers: [{ serviceId: 'openai-codex' as const }, { serviceId: 'openai-codex' as const }],
    serverWorkScheduler: scheduler,
    retry: {
      signal: abort.signal,
      baseDelayMs: options.failureBackoffMinMs,
      maxDelayMs: options.failureBackoffMaxMs,
      jitterMs: options.failureBackoffMinMs * options.failureBackoffJitterPct,
    },
    awaitReadiness: async () => { order.push('ready'); },
    hydrate: async ({ serviceIds }: { serviceIds: readonly ConnectedServiceId[] }) => {
      order.push('hydrate');
      return (await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
        serviceIds,
        api: {
          listConnectedServiceProfiles: listProfiles,
          listConnectedServiceAuthGroups: async () => [],
          resolveProviderAccountUsageSource: async () => null,
        },
        credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        store,
        nowMs: Date.now(),
      })).hydration;
    },
    createCoordinator: () => { order.push('create'); return coordinator; },
    startLoop: () => { order.push('loop'); started = true; return { stop: () => {} }; },
    onActivationError: (error: unknown) => { warnings.push(error); },
  };
  return { input, abort, listProfiles, scheduler, warnings, order, get refreshSources() { return refreshSources; }, get started() { return started; } };
}

describe('provider-account usage startup activation', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('constructs and starts quota policy only after real inventory hydration', async () => {
    const h = createActivation();
    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input)).resolves.toMatchObject({ status: 'active' });
    expect(h.order).toEqual(['ready', 'hydrate', 'create', 'schedule', 'loop']);
    expect(h.refreshSources).toEqual([{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }]);
  });

  it.each([
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('server not ready'), { status: 503 }),
  ])('recovers after transient hydration failure %s, with spaced bounded retries that stop after success', async (error) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = createActivation();
    h.listProfiles.mockRejectedValue(error);
    let result: unknown;
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toBe(false);
    expect(result).toBeUndefined();
    expect(h.listProfiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(h.input.retry.baseDelayMs - 1);
    expect(h.listProfiles).toHaveBeenCalledTimes(1);
    // Keep failing beyond the old three-attempt ceiling; jitter and capping use the existing backoff owner.
    const expectedDelays = [33_000, 63_000, 123_000, 243_000, 483_000, 603_000];
    let previousAttemptAt = Date.now() - (h.input.retry.baseDelayMs - 1);
    for (const expectedDelay of expectedDelays) {
      await vi.advanceTimersToNextTimerAsync();
      expect(Date.now() - previousAttemptAt).toBe(expectedDelay);
      previousAttemptAt = Date.now();
      expect(h.started).toBe(false);
    }
    h.listProfiles.mockResolvedValue({ serviceId: 'openai-codex', profiles: [{ profileId: 'work' }] });
    await vi.advanceTimersToNextTimerAsync();
    await activation;
    expect(result).toMatchObject({ status: 'active' });
    expect(h.started).toBe(true);
    expect(h.refreshSources).toEqual([{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }]);
    expect(h.warnings.length).toBeGreaterThan(0);
    const attempts = h.listProfiles.mock.calls.length;
    await vi.advanceTimersByTimeAsync(h.input.retry.maxDelayMs * 2);
    expect(h.listProfiles).toHaveBeenCalledTimes(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 400])('stays disabled for permanent HTTP %s errors', async (status) => {
    vi.useFakeTimers();
    const h = createActivation();
    const error = Object.assign(new Error('rejected'), { status });
    h.listProfiles.mockRejectedValue(error);
    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input)).resolves.toEqual({ status: 'quota_policy_disabled', error });
    expect(h.started).toBe(false);
    expect(h.warnings).toContain(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries settings-not-ready before hydration, but rejects invalid settings', async () => {
    vi.useFakeTimers();
    const h = createActivation();
    let settingsReady = false;
    const input = { ...h.input, awaitReadiness: async () => {
      if (!settingsReady) throw new AccountSettingsStaleError();
    } };
    let result: unknown;
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(input).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    expect(h.listProfiles).not.toHaveBeenCalled();
    settingsReady = true;
    await vi.advanceTimersToNextTimerAsync();
    await activation;
    expect(result).toMatchObject({ status: 'active' });
    const invalid = new AccountSettingsContentInvalidError(new Error('invalid schema'));
    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      ...h.input, awaitReadiness: async () => { throw invalid; },
    })).resolves.toMatchObject({ status: 'quota_policy_disabled', error: invalid });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries an inventory conflict through the same scheduler rather than accepting a changed snapshot', async () => {
    vi.useFakeTimers();
    const h = createActivation();
    h.listProfiles
      .mockResolvedValueOnce({ serviceId: 'openai-codex', profiles: [{ profileId: 'work' }] })
      .mockResolvedValueOnce({ serviceId: 'openai-codex', profiles: [{ profileId: 'other' }] });
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toBe(false);
    await vi.advanceTimersToNextTimerAsync();
    await expect(activation).resolves.toMatchObject({ status: 'active' });
    expect(h.refreshSources).toEqual([{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses scheduler readiness admission and observes the current gate when retrying', async () => {
    vi.useFakeTimers();
    const h = createActivation();
    let online = false;
    const scheduler = createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      gate: () => online ? { status: 'open' } : { status: 'deferred', reason: 'offline' },
    });
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({ ...h.input, serverWorkScheduler: scheduler });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.listProfiles).not.toHaveBeenCalled();
    expect(h.started).toBe(false);
    online = true;
    await vi.advanceTimersToNextTimerAsync();
    await expect(activation).resolves.toMatchObject({ status: 'active' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending retry on shutdown without creating a coordinator or leaking timers', async () => {
    vi.useFakeTimers();
    const h = createActivation();
    h.listProfiles.mockRejectedValue(Object.assign(new Error('server restarting'), { status: 503 }));
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input);
    await vi.advanceTimersByTimeAsync(0);
    h.abort.abort();
    await expect(activation).resolves.toMatchObject({ status: 'disabled' });
    await vi.advanceTimersByTimeAsync(h.input.retry.maxDelayMs * 2);
    expect(h.listProfiles).toHaveBeenCalledTimes(1);
    expect(h.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap a running hydration and cannot activate after shutdown', async () => {
    vi.useFakeTimers();
    const h = createActivation();
    let finish!: () => void;
    h.listProfiles.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { serviceId: 'openai-codex', profiles: [{ profileId: 'work' }] };
    });
    const activation = activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration(h.input);
    await vi.advanceTimersByTimeAsync(h.input.retry.maxDelayMs * 2);
    expect(h.listProfiles).toHaveBeenCalledTimes(1);
    h.abort.abort();
    finish();
    await expect(activation).resolves.toMatchObject({ status: 'disabled' });
    expect(h.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
