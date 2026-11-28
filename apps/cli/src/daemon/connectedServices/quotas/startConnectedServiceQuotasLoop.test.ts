import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceQuotasLoop } from './startConnectedServiceQuotasLoop';
import { buildConnectedServiceCredentialRecord, projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1, type ConnectedServiceAuthGroupV1, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import type { ConnectedServiceQuotaFetcher } from './types';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

describe('startConnectedServiceQuotasLoop', () => {
  it.each([false, true])('refreshes a ready profile after selected credential changes (during fetch: %s)', async duringFetch => {
    invalidateConnectedServiceAccountMode();
    const now = 1_000_000;
    let accessToken = 'selected-a';
    const firstFetch: { release?: () => void } = {};
    let published: ProviderAccountUsageSnapshotV1 | null = null;
    const record = () => buildConnectedServiceCredentialRecord({ now, serviceId: 'antigravity',
      profileId: 'connected', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken, refreshToken: 'refresh', idToken: null, scope: null, tokenType: null,
        providerAccountId: 'selected-account', providerEmail: null } });
    // The provider read is the system boundary; the coordinator, loop and persistence are real.
    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'antigravity', async fetch({ record: current, now: fetchedAt }) {
      const selectedA = current.kind === 'oauth' && current.oauth.accessToken === 'selected-a';
      if (duringFetch && selectedA) await new Promise<void>(resolve => { firstFetch.release = resolve; });
      return { v: 1, serviceId: 'antigravity', profileId: 'connected', fetchedAt, staleAfterMs: 300_000, planLabel: null, accountLabel: null,
        meters: [{ meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: null,
          remainingPct: selectedA ? 80 : 20, resetsAt: null, status: 'ok', details: {} }] };
    } };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'account', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      quotaFetchers: [fetcher], discoveryEnabled: false, now: () => now,
      randomBytes: length => new Uint8Array(length),
      api: {
        getAccountEncryptionMode: async () => 'plain',
        listConnectedServiceProfiles: async () => ({ serviceId: 'antigravity', profiles: [{ profileId: 'connected', status: 'connected' }] }),
        // Antigravity account reads need consent: the account is a pool member.
        listConnectedServiceAuthGroups: async () => [{ members: [{ profileId: 'connected', enabled: true }] } as unknown as ConnectedServiceAuthGroupV1],
        getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: record() } }),
        getConnectedServiceQuotaSnapshotPlain: async ({ serviceId, profileId }) => {
          if (!published) return null;
          const snapshot = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
            snapshot: published, source: { serviceId, profileId, bindingKind: 'profile' },
          });
          if (!snapshot) throw new Error('Fixture quota source did not resolve');
          return { content: { t: 'plain', v: snapshot },
            metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok' } };
        },
        registerProviderAccountUsageSnapshotPlain: async input => { published = input.content.v; },
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({ enabled: true, tickMs: 10_000, coordinator,
      onTickError: error => { throw error; }, setIntervalFn: () => 1, clearIntervalFn: () => {} });
    const source = { serviceId: 'antigravity' as const, profileId: 'connected', bindingKind: 'profile' as const };
    handle?.wake([source]);
    if (duringFetch) await vi.waitFor(() => expect(firstFetch.release).toBeDefined());
    else await vi.waitFor(() => expect(published).toMatchObject({ meters: [{ remainingPct: 80 }] }));
    accessToken = 'selected-b';
    handle?.wake([source]);
    firstFetch.release?.();
    await vi.waitFor(() => expect(published).toMatchObject({ meters: [{ remainingPct: 20 }] }));
    await handle?.stop();
    invalidateConnectedServiceAccountMode();
  });
  it.each([0, 2000])('wakes the existing loop after profile changes and preserves an in-flight wake (jitter %s)', async tickJitterMs => {
    let ticks = 0;
    let release: () => void = () => {};
    // The real coordinator owns discovery; only its clock and account HTTP are controlled.
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-loop-account', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      quotaFetchers: [], discoveryEnabled: false,
      now: () => { ticks += 1; return 500; },
      randomBytes: length => new Uint8Array(length),
      api: {
        getAccountEncryptionMode: async () => { await new Promise<void>(resolve => { release = resolve; }); return 'plain'; },
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({
      enabled: true, tickMs: 10000, tickJitterMs,
      coordinator,
      onTickError: () => {},
      setIntervalFn: () => 1, clearIntervalFn: () => {},
      ...(tickJitterMs ? { setTimeoutFn: () => 1, clearTimeoutFn: () => {} } : {}),
    });
    handle?.wake();
    expect(ticks).toBe(1);
    handle?.wake();
    handle?.wake();
    expect(ticks).toBe(1);
    release();
    await vi.waitFor(() => expect(ticks).toBe(2));
    handle?.pause();
    handle?.wake();
    expect(ticks).toBe(2);
    handle?.resume();
    await vi.waitFor(() => expect(ticks).toBe(3));
    await handle?.stop();
    handle?.wake();
    expect(ticks).toBe(3);
  });
  it('schedules tickOnce when enabled', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

	    let captured: (() => void) = () => {};
	    let cleared = 0;
	    const setIntervalFn = ((fn: () => void) => {
	      captured = fn;
	      return 123;
	    });
    const clearIntervalFn = (() => {
      cleared += 1;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn,
    });

    expect(handle).not.toBeNull();
    const callback: () => void = captured ?? (() => {
      throw new Error('fixture: expected interval callback');
    });
    callback();
    await Promise.resolve();

    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
    handle?.stop();
    expect(cleared).toBe(1);
  });

  it('unrefs the interval handle when supported', () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };
    const unref = vi.fn();
    const setIntervalFn = vi.fn(() => ({ unref }));

    startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const handle = startConnectedServiceQuotasLoop({
      enabled: false,
      tickMs: 10,
      coordinator: { tickOnce: vi.fn() },
      onTickError: vi.fn(),
      setIntervalFn: () => 123,
      clearIntervalFn: () => {},
    });
    expect(handle).toBeNull();
  });

  it('pauses ticks until resume()', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

    let captured: (() => void) = () => {};
    const setIntervalFn = ((fn: () => void) => {
      captured = fn;
      return 123;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    handle?.pause();
    captured();
    await Promise.resolve();
    expect(coordinator.tickOnce).not.toHaveBeenCalled();

    handle?.resume();
    captured();
    await Promise.resolve();
    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight tick to settle when stopped', async () => {
    let releaseTick: () => void = () => {
      throw new Error('fixture: expected tick release callback');
    };
    const coordinator: { tickOnce: () => Promise<void> } = {
      tickOnce: vi.fn(async () => await new Promise<void>((resolve) => {
        releaseTick = resolve;
      })),
    };

    let captured: (() => void) = () => {};
    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn: (fn) => {
        captured = fn;
        return 123;
      },
      clearIntervalFn: vi.fn(),
    });

    captured();
    await Promise.resolve();

    let stopSettled = false;
    const stopPromise = handle?.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseTick();
    await stopPromise;
    expect(stopSettled).toBe(true);
  });

  it('uses deterministic bounded jitter between scheduled wakeups', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

    const scheduled: Array<Readonly<{ fn: () => void; ms: number; handle: number }>> = [];
    const cleared: number[] = [];
    let nextHandle = 1;
    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10_000,
      tickJitterMs: 2_000,
      random: () => 0.5,
      coordinator,
      onTickError: vi.fn(),
      setTimeoutFn: (fn, ms) => {
        const timeoutHandle = nextHandle;
        nextHandle += 1;
        scheduled.push({ fn, ms, handle: timeoutHandle });
        return timeoutHandle;
      },
      clearTimeoutFn: (timeoutHandle) => {
        cleared.push(timeoutHandle as number);
      },
    });

    expect(handle).not.toBeNull();
    expect(scheduled.map((entry) => entry.ms)).toEqual([11_000]);

    scheduled[0]!.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
    expect(scheduled.map((entry) => entry.ms)).toEqual([11_000, 11_000]);

    handle?.stop();
    expect(cleared).toEqual([2]);
  });
});
