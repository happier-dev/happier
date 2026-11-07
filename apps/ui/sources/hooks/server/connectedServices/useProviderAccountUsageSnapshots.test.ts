import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshotCiphertext,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getProviderAccountUsageSnapshotPlain } from '@/sync/api/account/apiProviderAccountUsageV3';
import type { getProviderAccountUsageSnapshotSealed } from '@/sync/api/account/apiProviderAccountUsageV2';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);

const { fetchAccountEncryptionModeSpy, getProviderAccountUsageSnapshotPlainSpy, getProviderAccountUsageSnapshotSealedSpy } = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'plain', updatedAt: 0 })),
  getProviderAccountUsageSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getProviderAccountUsageSnapshotPlain>) => ReturnType<typeof getProviderAccountUsageSnapshotPlain>
  >(async () => null),
  getProviderAccountUsageSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getProviderAccountUsageSnapshotSealed>) => ReturnType<typeof getProviderAccountUsageSnapshotSealed>
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

vi.mock('@/sync/api/account/apiProviderAccountUsageV3', () => ({
  getProviderAccountUsageSnapshotPlain: getProviderAccountUsageSnapshotPlainSpy,
}));

vi.mock('@/sync/api/account/apiProviderAccountUsageV2', () => ({
  getProviderAccountUsageSnapshotSealed: getProviderAccountUsageSnapshotSealedSpy,
}));

function makeUsageSnapshot(accountSubjectId = 'provider-account-1'): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'Provider account',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 55,
      limit: 100,
      unit: 'count',
      utilizationPct: null,
      remainingPct: null,
      resetsAt: null,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
  });
}

function makeUsageSnapshotWith(params: Readonly<{
  accountSubjectId?: string;
  fetchedAtMs?: number;
  staleAfterMs?: number;
}>): ProviderAccountUsageSnapshotV1 {
  const snapshot = makeUsageSnapshot(params.accountSubjectId);
  return ProviderAccountUsageSnapshotV1Schema.parse({
    ...snapshot,
    observedAtMs: params.fetchedAtMs ?? snapshot.observedAtMs,
    fetchedAtMs: params.fetchedAtMs ?? snapshot.fetchedAtMs,
    staleAfterMs: params.staleAfterMs ?? snapshot.staleAfterMs,
  });
}

describe('useProviderAccountUsageSnapshots', () => {
  beforeEach(async () => {
    currentCredentials = stableCredentials;
    vi.clearAllMocks();
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(null);
    getProviderAccountUsageSnapshotSealedSpy.mockResolvedValue(null);
    const { __resetProviderAccountUsageSnapshotCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    __resetProviderAccountUsageSnapshotCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches plain provider account usage snapshots by record id and caches them by credential scope', async () => {
    const snapshot = makeUsageSnapshot();
    getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(snapshot);

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));

    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
      recordId: snapshot.recordId,
    }, { signal: expect.any(AbortSignal) });
    expect(hook.getCurrent()[snapshot.recordId]).toBe(snapshot);

    const { readProviderAccountUsageSnapshotFromCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    expect(readProviderAccountUsageSnapshotFromCache({
      credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
      recordId: snapshot.recordId,
    })).toBe(snapshot);
    await hook.unmount();
  });

  it('uses cached provider account usage snapshots without refetching the same record', async () => {
    const snapshot = makeUsageSnapshotWith({ fetchedAtMs: Date.now() });
    const credentialScope = resolveAuthCredentialsScopeKey(stableCredentials);
    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    writeProviderAccountUsageSnapshotToCache({ credentialScope, snapshot });

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));

    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(hook.getCurrent()[snapshot.recordId]).toBe(snapshot);
    expect(getProviderAccountUsageSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(getProviderAccountUsageSnapshotSealedSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('prefers newer shared-cache provider account usage over a mounted local entry', async () => {
    const first = makeUsageSnapshotWith({ accountSubjectId: 'provider-account-1', fetchedAtMs: Date.now() });
    const newer = makeUsageSnapshotWith({ accountSubjectId: 'provider-account-1', fetchedAtMs: Date.now() + 10_000 });
    getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(first);

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([first.recordId]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(hook.getCurrent()[first.recordId]).toBe(first);

    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    await act(async () => {
      writeProviderAccountUsageSnapshotToCache({
        credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
        snapshot: newer,
      });
    });
    await flushHookEffects({ cycles: 3, turns: 3 });

    expect(hook.getCurrent()[first.recordId]).toBe(newer);
    await hook.unmount();
  });

  it('refetches stale shared-cache provider account usage snapshots', async () => {
    const stale = makeUsageSnapshotWith({ fetchedAtMs: Date.now() - 120_000, staleAfterMs: 1 });
    const fresh = makeUsageSnapshotWith({ fetchedAtMs: Date.now() });
    const credentialScope = resolveAuthCredentialsScopeKey(stableCredentials);
    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    writeProviderAccountUsageSnapshotToCache({ credentialScope, snapshot: stale });
    getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(fresh);

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([stale.recordId]));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getProviderAccountUsageSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
      recordId: stale.recordId,
    }, { signal: expect.any(AbortSignal) });
    expect(hook.getCurrent()[stale.recordId]).toBe(fresh);
    await hook.unmount();
  });

  it('updates both session consumers of an account without changing another account', async () => {
    const snapshot = makeUsageSnapshot();
    const other = makeUsageSnapshot('another-provider-account');
    const credentialScope = resolveAuthCredentialsScopeKey(stableCredentials);

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));
    const secondSession = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));
    const otherAccount = await renderHook(() => useProviderAccountUsageSnapshots([other.recordId]));

    expect(hook.getCurrent()[snapshot.recordId]).toBeNull();

    const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    await act(async () => {
      writeProviderAccountUsageSnapshotToCache({ credentialScope, snapshot });
    });
    await flushHookEffects({ cycles: 3, turns: 3 });

    expect(hook.getCurrent()[snapshot.recordId]).toBe(snapshot);
    expect(secondSession.getCurrent()[snapshot.recordId]).toBe(snapshot);
    expect(otherAccount.getCurrent()[other.recordId]).toBeNull();
    await hook.unmount();
    await secondSession.unmount();
    await otherAccount.unmount();
  });

  it('opens sealed provider account usage snapshots with account-scoped credentials', async () => {
    const snapshot = makeUsageSnapshot('sealed-provider-account');
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: resolveAccountScopedCryptoMaterialFromCredentials(stableCredentials),
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    getProviderAccountUsageSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status: 'ok',
      },
    });

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([snapshot.recordId]));

    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(getProviderAccountUsageSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(getProviderAccountUsageSnapshotSealedSpy).toHaveBeenCalledWith(stableCredentials, {
      recordId: snapshot.recordId,
    }, { signal: expect.any(AbortSignal) });
    expect(hook.getCurrent()[snapshot.recordId]).toEqual(snapshot);
    await hook.unmount();
  });

  it('rejects sealed provider account usage snapshots for a different record id', async () => {
    const requested = makeUsageSnapshot('requested-provider-account');
    const mismatched = makeUsageSnapshot('other-provider-account');
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: resolveAccountScopedCryptoMaterialFromCredentials(stableCredentials),
      payload: mismatched,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    getProviderAccountUsageSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        fetchedAt: mismatched.fetchedAtMs,
        staleAfterMs: mismatched.staleAfterMs,
        status: 'ok',
      },
    });

    const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
    const hook = await renderHook(() => useProviderAccountUsageSnapshots([requested.recordId]));

    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(hook.getCurrent()[requested.recordId]).toBeNull();
    const { readProviderAccountUsageSnapshotFromCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    expect(readProviderAccountUsageSnapshotFromCache({
      credentialScope: resolveAuthCredentialsScopeKey(stableCredentials),
      recordId: requested.recordId,
    })).toBeNull();
    await hook.unmount();
  });
});
