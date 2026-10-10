import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { ConnectedServiceQuotaSnapshotsResult } from './useConnectedServiceQuotaSnapshots';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);

const { fetchAccountEncryptionModeSpy, getConnectedServiceQuotaSnapshotPlainSpy, getConnectedServiceQuotaSnapshotSealedSpy } = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: currentCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

type PlainQuotaSnapshotResult = Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>;
type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;

function makeQuotaSnapshot(params: Readonly<{
  serviceId: 'anthropic' | 'openai-codex';
  profileId?: string;
  meterId?: string;
  staleAfterMs?: number;
}>): NonNullable<PlainQuotaSnapshotResult> {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId ?? 'work',
    fetchedAt: 1,
    staleAfterMs: params.staleAfterMs ?? 60_000,
    planLabel: params.serviceId === 'anthropic' ? 'Pro' : 'Plus',
    accountLabel: null,
    meters: params.meterId
      ? [
        {
          meterId: params.meterId,
          label: params.meterId,
          used: 40,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'quota' },
        },
      ]
      : [],
  });
}

function makeProviderAccountUsageSnapshot(params: Readonly<{
  meterId: string;
  used: number;
}>): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: 'provider-account-1',
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'provider-account-1' },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'Provider account',
    meters: [{
      meterId: params.meterId,
      label: params.meterId,
      used: params.used,
      limit: 100,
      unit: 'count',
      utilizationPct: null,
      resetsAt: null,
      status: 'ok',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  });
}

function createDeferredPlainSnapshot() {
  let resolve!: (value: PlainQuotaSnapshotResult) => void;
  const promise = new Promise<PlainQuotaSnapshotResult>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve } as const;
}

function createDeferredAccountMode() {
  let resolve!: (value: Awaited<ReturnType<typeof fetchAccountEncryptionMode>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof fetchAccountEncryptionMode>>>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve } as const;
}

describe('useConnectedServiceQuotaSnapshots', () => {
  beforeEach(async () => {
    currentCredentials = stableCredentials;
    vi.clearAllMocks();
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
    __resetConnectedServiceQuotaSnapshotStore();
    const { __resetProviderAccountUsageSnapshotCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    __resetProviderAccountUsageSnapshotCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches quota snapshots when credentials change for a cached profile', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
      { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
    );

    await flushHookEffects({ cycles: 5, turns: 5 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    currentCredentials = { ...stableCredentials, token: 't2' };
    await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
    expect(getConnectedServiceQuotaSnapshotPlainSpy.mock.calls[1]?.[0].token).toBe('t2');
    await hook.unmount();
  });

  it('does not expose cached quota snapshots during credential changes before reset effects run', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-token' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const valuesDuringCredentialChange: ConnectedServiceQuotaSnapshotsResult[] = [];
    let captureCredentialChangeRender = false;

    function Harness() {
      const value = useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]);
      if (captureCredentialChangeRender) {
        valuesDuringCredentialChange.push(value);
      }
      return null;
    }

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Harness));
    });
    await flushHookEffects({ cycles: 5, turns: 5 });

    currentCredentials = { ...stableCredentials, token: 't2' };
    captureCredentialChangeRender = true;
    await act(async () => {
      tree.update(React.createElement(Harness));
    });

    expect(valuesDuringCredentialChange[0]?.snapshotsByKey['anthropic/work']).toBeNull();
    expect(valuesDuringCredentialChange[0]?.loadingByKey['anthropic/work']).toBe(false);

    await act(async () => {
      tree.unmount();
    });
  });

  it('refetches and ignores stale quota results when credential material changes under the same token', async () => {
    const oldCredentialSnapshot = createDeferredPlainSnapshot();
    const newCredentialSnapshot = createDeferredPlainSnapshot();
    getConnectedServiceQuotaSnapshotPlainSpy
      .mockReturnValueOnce(oldCredentialSnapshot.promise)
      .mockReturnValueOnce(newCredentialSnapshot.promise);

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
      { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    const nextCredentials = { ...stableCredentials, secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url') };
    currentCredentials = nextCredentials;
    await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
    await flushHookEffects({ cycles: 3, turns: 3 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
    expect(getConnectedServiceQuotaSnapshotPlainSpy.mock.calls[1]?.[0]).toEqual(nextCredentials);

    await act(async () => {
      oldCredentialSnapshot.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-secret' }));
    });
    await flushHookEffects({ cycles: 5, turns: 5 });
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();

    await act(async () => {
      newCredentialSnapshot.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-secret' }));
    });
    await flushHookEffects({ cycles: 10, turns: 10 });

    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-secret');
    expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    await hook.unmount();
  });

  it('does not let a stale account-mode response choose the quota endpoint after credentials change', async () => {
    vi.useFakeTimers();
    const oldMode = createDeferredAccountMode();
    const newMode = createDeferredAccountMode();
    fetchAccountEncryptionModeSpy
      .mockReturnValueOnce(oldMode.promise)
      .mockReturnValueOnce(newMode.promise);
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(
      makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-account', staleAfterMs: 1 }),
    );

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
      { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(1);
    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();

    currentCredentials = { ...stableCredentials, token: 't2' };
    await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      newMode.resolve({ mode: 'plain', updatedAt: 2 });
    });
    await flushHookEffects({ cycles: 5, turns: 5 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldMode.resolve({ mode: 'e2ee', updatedAt: 1 });
    });
    await flushHookEffects({ cycles: 3, turns: 5 });
    await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 30_001 });
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
    expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('does not fall back to the sealed quota endpoint after credentials change while a plaintext miss is pending', async () => {
    const oldCredentialSnapshot = createDeferredPlainSnapshot();
    getConnectedServiceQuotaSnapshotPlainSpy
      .mockReturnValueOnce(oldCredentialSnapshot.promise)
      .mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-account' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
      { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    currentCredentials = { ...stableCredentials, token: 't2' };
    await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldCredentialSnapshot.resolve(null);
    });
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-account');
    await hook.unmount();
  });

  it('does not start duplicate quota fetches when rerendered with equivalent profile refs before the first fetch settles', async () => {
    const pendingPlain = createDeferredPlainSnapshot();
    getConnectedServiceQuotaSnapshotPlainSpy.mockReturnValue(pendingPlain.promise);

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
      { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingPlain.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));
    });
    await flushHookEffects({ cycles: 10, turns: 10 });

    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
    await hook.unmount();
  });

  it('does not abort an unresolved quota fetch when an equivalent rerender adds a duplicate profile ref', async () => {
    const pendingPlain = createDeferredPlainSnapshot();
    getConnectedServiceQuotaSnapshotPlainSpy.mockReturnValue(pendingPlain.promise);

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
      { initialProps: [{ serviceId: 'anthropic', profileId: 'work' }] },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await hook.rerender([
      { serviceId: 'anthropic', profileId: 'work' },
      { serviceId: 'anthropic', profileId: 'work' },
    ]);
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingPlain.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));
    });
    await flushHookEffects({ cycles: 10, turns: 10 });

    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    await hook.unmount();
  });

  it('does not abort unresolved quota fetches when equivalent profile refs are reordered', async () => {
    const snapshotByKey = {
      'anthropic/work': makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }),
      'openai-codex/work': makeQuotaSnapshot({ serviceId: 'openai-codex', meterId: 'monthly' }),
    } as const;
    const resolvers: Partial<Record<keyof typeof snapshotByKey, (value: PlainQuotaSnapshotResult) => void>> = {};
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => {
      const key = `${params.serviceId}/${params.profileId}` as keyof typeof snapshotByKey;
      return await new Promise<PlainQuotaSnapshotResult>((resolve) => {
        resolvers[key] = resolve;
      });
    });

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
      {
        initialProps: [
          { serviceId: 'anthropic', profileId: 'work' },
          { serviceId: 'openai-codex', profileId: 'work' },
        ],
      },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await hook.rerender([
      { serviceId: 'openai-codex', profileId: 'work' },
      { serviceId: 'anthropic', profileId: 'work' },
    ]);
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers['anthropic/work']?.(snapshotByKey['anthropic/work']);
      resolvers['openai-codex/work']?.(snapshotByKey['openai-codex/work']);
    });
    await flushHookEffects({ cycles: 10, turns: 10 });

    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('monthly');
    await hook.unmount();
  });

  it('keeps an unresolved quota fetch alive when a rerender removes a different profile ref', async () => {
    const snapshotByKey = {
      'anthropic/work': makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }),
      'openai-codex/work': makeQuotaSnapshot({ serviceId: 'openai-codex' }),
    } as const;
    const resolvers: Partial<Record<keyof typeof snapshotByKey, (value: PlainQuotaSnapshotResult) => void>> = {};
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => {
      const key = `${params.serviceId}/${params.profileId}` as keyof typeof snapshotByKey;
      return await new Promise<PlainQuotaSnapshotResult>((resolve) => {
        resolvers[key] = resolve;
      });
    });

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(
      (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
      {
        initialProps: [
          { serviceId: 'anthropic', profileId: 'work' },
          { serviceId: 'openai-codex', profileId: 'work' },
        ],
      },
    );

    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await hook.rerender([{ serviceId: 'anthropic', profileId: 'work' }]);
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers['anthropic/work']?.(snapshotByKey['anthropic/work']);
      resolvers['openai-codex/work']?.(snapshotByKey['openai-codex/work']);
    });
    await flushHookEffects({ cycles: 10, turns: 10 });

    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    await hook.unmount();
  });

  it('fetches usage for an unknown/empty credential status (fails OPEN, single predicate)', async () => {
    // Folded onto shouldHideQuotaForCredentialStatus: an absent/unknown status is
    // presumed healthy for DISPLAY, so the snapshot still fetches. Only an EXPLICIT
    // needs_reauth suppresses usage — the opposite (fail-closed) derivation is gone.
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'anthropic', profileId: 'work', credentialHealthStatus: 'mystery-status' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    await hook.unmount();
  });

  it('does not fetch usage for an explicit needs_reauth credential status', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'anthropic', profileId: 'work', credentialHealthStatus: 'needs_reauth' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();
    await hook.unmount();
  });

  it('fetches a reliable session-bound quota snapshot even when no meters are pinned', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
      serviceId: 'anthropic',
      profileId: 'work',
    });
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    await hook.unmount();
  });

  it('retries missing quota snapshots while the connected profile remains mounted', async () => {
    vi.useFakeTimers();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'retried-weekly' }));

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();

    await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 2_001 });
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
    expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('retried-weekly');
    await hook.unmount();
  });

  it('uses the connected-service quota view for a connected-service profile request even when cached account usage exists', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({
      serviceId: 'openai-codex',
      meterId: 'view-weekly',
    }));
    const accountUsage = makeProviderAccountUsageSnapshot({ meterId: 'account-usage-weekly', used: 65 });
    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    writeProviderAccountUsageSnapshotToCache({
      credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
      snapshot: accountUsage,
    });

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'openai-codex', profileId: 'work' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(hook.getCurrent().snapshotsByKey['openai-codex/work']).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
    }));
    expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('view-weekly');
    await hook.unmount();
  });

  it('prefers the connected-service quota view ahead of cached account usage for connected bindings', async () => {
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({
      serviceId: 'openai-codex',
      meterId: 'view-weekly',
    }));
    const accountUsage = makeProviderAccountUsageSnapshot({ meterId: 'account-usage-weekly', used: 95 });
    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    writeProviderAccountUsageSnapshotToCache({
      credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
      snapshot: accountUsage,
    });

    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
      { serviceId: 'openai-codex', profileId: 'work' },
    ]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('view-weekly');
    await hook.unmount();
  });
});
