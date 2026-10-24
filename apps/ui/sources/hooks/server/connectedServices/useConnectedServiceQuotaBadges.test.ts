import { beforeEach, describe, expect, it, vi } from 'vitest';

import React from 'react';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import { renderHookAndCollectValues } from '../serverFeatureHookHarness.testHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;

const useSettingsSpy = vi.fn(() => ({
  connectedServicesQuotaPinnedMeterIdsByKey: {},
  connectedServicesQuotaSummaryStrategyByKey: {},
  connectedServicesProfileLabelByKey: {},
  connectedServicesDefaultProfileByServiceId: {},
}));

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

vi.mock('@/sync/store/hooks', () => ({
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
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

beforeEach(() => {
  currentCredentials = stableCredentials;
});

describe('useConnectedServiceQuotaBadges', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetConnectedServiceQuotaSnapshotStore } = await import('@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore');
    __resetConnectedServiceQuotaSnapshotStore();
    const { __resetProviderAccountUsageSnapshotCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
    __resetProviderAccountUsageSnapshotCache();
  });

  it('returns badges for pinned meters after snapshot fetch', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });

    const secretBytes = new Uint8Array(32).fill(3);
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    });

    const ciphertext = sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
      material: { type: 'legacy', secret: secretBytes },
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
    });

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));

    const last = seen.at(-1) ?? {};
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('18%');
  });

  it('supports plaintext quotas in plaintext accounts', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });

    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(snapshot);

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));

    const last = seen.at(-1) ?? {};
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('18%');
  });

  it('requests visible profiles and shows a default quota summary without pinned meters', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });

    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'daily',
          label: 'Daily',
          used: 50,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'quota' },
        },
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 92,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'quota' },
        },
      ],
    });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(snapshot);

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work' },
    ]));

    const last = seen.at(-1) ?? {};
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    expect(last['anthropic/work']).toEqual([{ meterId: 'weekly', text: '8%' }]);
  });

  it('keeps pinned badge placeholders after a connected-service quota miss', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen: ReturnType<typeof useConnectedServiceQuotaBadges>[] = [];
    const hook = await renderHook(() => {
      const value = useConnectedServiceQuotaBadges([
        { serviceId: 'anthropic', profileId: 'work' },
      ]);
      React.useEffect(() => {
        seen.push(value);
      }, [value]);
      return value;
    });

    await flushHookEffects({ cycles: 4, turns: 1 });

    expect(getConnectedServiceQuotaSnapshotSealedSpy).toHaveBeenCalledTimes(1);
    const last = seen.at(-1) ?? {};
    expect(last['anthropic/work']).toEqual([{ meterId: 'weekly', text: '—' }]);
    await hook.unmount();
    await flushHookEffects({ cycles: 1, turns: 1 });
  });

  it('shows usage badges for an unknown/empty credential status (fails OPEN, single predicate)', async () => {
    // Folded onto shouldHideQuotaForCredentialStatus: an unrecognized status is not
    // an explicit needs_reauth, so it must NOT blank the badges (fail-open for
    // display). The old fail-closed derivation suppressed these — regression guard.
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });

    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        { meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
      ],
    });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(snapshot);

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const seen = await renderHookAndCollectValues(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work', credentialHealthStatus: 'mystery-status' },
    ]));

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
    const last = seen.at(-1) ?? {};
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('18%');
  });

  it('suppresses badges and does not poll when credential health is not usable', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });

    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const hook = await renderHook(() => useConnectedServiceQuotaBadges([
      { serviceId: 'anthropic', profileId: 'work', credentialHealthStatus: 'needs_reauth' },
    ]));

    await flushHookEffects({ cycles: 2, turns: 1 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(hook.getCurrent()['anthropic/work']).toEqual([]);
    await hook.unmount();
  });
});
