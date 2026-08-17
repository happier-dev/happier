import { beforeEach, describe, expect, it, vi } from 'vitest';

import React from 'react';
import { act } from 'react-test-renderer';
import {
  ConnectedServiceIdSchema,
  ConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedAccountDaemonControlResponse,
} from '@happier-dev/protocol';
import { sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import type { runConnectedAccountControlCommand } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
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

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
  runConnectedAccountControlCommandSpy,
} = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee', updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
  runConnectedAccountControlCommandSpy: vi.fn<
    (...args: Parameters<typeof runConnectedAccountControlCommand>) => ReturnType<typeof runConnectedAccountControlCommand>
  >(),
}));

function buildConnectedAccountDescription(
  params: Parameters<typeof runConnectedAccountControlCommand>[0],
): ConnectedAccountDaemonControlResponse {
  if (params.command.operation !== 'describeService') {
    return {
      status: 'unavailable',
      code: 'connected_account_fixture_operation_unsupported',
    } satisfies ConnectedAccountDaemonControlResponse;
  }
  return {
    status: 'described',
    service: params.command.service,
    descriptor: {
      id: params.command.service.localId,
      title: 'Connected Account Fixture',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          pkce: 'required',
          outcomeReconciliation: 'none',
        }],
      },
    },
    generation: 'generation-1',
    immutableGenerationId: 'immutable-generation-1',
    accounts: [],
    operationTransport: {
      kind: 'legacy',
      peerClass: 'revisioned_v2_v3',
      serviceId: ConnectedServiceIdSchema.parse(
        params.command.service.localId,
      ),
    },
  } satisfies ConnectedAccountDaemonControlResponse;
}

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: currentCredentials }),
}));

vi.mock('@/sync/store/hooks', () => ({
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
  useProfile: () => ({
    connectedAccountsV4: [],
  }),
  useAllMachines: () => [{
    id: 'machine-a',
    active: true,
  }],
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
  useActiveServerSnapshot: () => ({
    serverId: 'server-a',
    serverUrl: 'https://server-a.example.test',
    generation: 1,
  }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesRuntimeSnapshot: () => ({
    status: 'ready' as const,
    features: {
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
      },
    },
  }),
}));

vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', () => ({
  runConnectedAccountControlCommand: runConnectedAccountControlCommandSpy,
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
  runConnectedAccountControlCommandSpy.mockImplementation(
    async (params) => buildConnectedAccountDescription(params),
  );
});

function buildWeeklyQuotaSnapshot(params: Readonly<{
  profileId?: string;
  meterId?: string;
  label?: string;
  used?: number;
}> = {}) {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'anthropic',
    profileId: params.profileId ?? 'work',
    fetchedAt: 1,
    staleAfterMs: 60_000,
    planLabel: 'Pro',
    accountLabel: null,
    meters: [
      {
        meterId: params.meterId ?? 'weekly',
        label: params.label ?? 'Weekly',
        used: params.used ?? 82,
        limit: 100,
        unit: 'count',
        utilizationPct: null,
        resetsAt: null,
        status: 'ok',
        details: {},
      },
    ],
  });
}

function sealQuotaSnapshot(snapshot: ReturnType<typeof buildWeeklyQuotaSnapshot>): string {
  const secretBytes = new Uint8Array(32).fill(3);
  return sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext({
    material: { type: 'legacy', secret: secretBytes },
    payload: snapshot,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
}

describe('useConnectedServiceQuotaBadges', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('Weekly 18%');
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
    expect(last['anthropic/work']?.map((b) => b.text)).toContain('Weekly 18%');
  });

  it('retries a pinned key after an initial miss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
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

      getConnectedServiceQuotaSnapshotSealedSpy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
        });

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

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(getConnectedServiceQuotaSnapshotSealedSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await flushHookEffects();
      });

      expect(getConnectedServiceQuotaSnapshotSealedSpy).toHaveBeenCalledTimes(2);
      const last = seen.at(-1) ?? {};
      expect(last['anthropic/work']?.map((b) => b.text)).toContain('Weekly 18%');
      await hook.unmount();
      await flushHookEffects({ cycles: 1, turns: 1 });
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not fetch quota snapshots in cache-only mode', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const useBadgesWithOptions = useConnectedServiceQuotaBadges as (
      profiles: ReadonlyArray<{ serviceId: string; profileId: string }>,
      options: Readonly<{ fetchPolicy: 'cache_only' }>,
    ) => ReturnType<typeof useConnectedServiceQuotaBadges>;

    const hook = await renderHook(() => useBadgesWithOptions([
      { serviceId: 'anthropic', profileId: 'work' },
    ], { fetchPolicy: 'cache_only' }));
    await flushHookEffects({ cycles: 5, turns: 5 });

    expect(fetchAccountEncryptionModeSpy).not.toHaveBeenCalled();
    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
    expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
    expect(hook.getCurrent()).toEqual({ 'anthropic/work': [] });
  });

  it('uses cached quota snapshots for default cache-only badges without pinned meters or polling', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    useSettingsSpy.mockReturnValue({
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesDefaultProfileByServiceId: {},
    });

    const snapshotsByProfileId = {
      work: buildWeeklyQuotaSnapshot({ profileId: 'work', meterId: 'weekly', label: 'Weekly', used: 82 }),
      backup: buildWeeklyQuotaSnapshot({ profileId: 'backup', meterId: 'daily', label: 'Daily', used: 40 }),
    } as const;
    getConnectedServiceQuotaSnapshotSealedSpy.mockImplementation(async (_credentials, request) => {
      const snapshot = snapshotsByProfileId[request.profileId as keyof typeof snapshotsByProfileId] ?? null;
      if (!snapshot) return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext: sealQuotaSnapshot(snapshot) },
        metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
      };
    });

    const profiles = [
      { serviceId: 'anthropic', profileId: 'work' },
      { serviceId: 'anthropic', profileId: 'backup' },
    ] as const;
    const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
    const { useConnectedServiceQuotaBadges } = await import('./useConnectedServiceQuotaBadges');
    const fetchedValues = await renderHookAndCollectValues(() => useConnectedServiceQuotaSnapshots(profiles));
    expect(fetchedValues.at(-1)?.snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
    expect(fetchedValues.at(-1)?.snapshotsByKey['anthropic/backup']?.meters[0]?.meterId).toBe('daily');

    fetchAccountEncryptionModeSpy.mockClear();
    getConnectedServiceQuotaSnapshotPlainSpy.mockClear();
    getConnectedServiceQuotaSnapshotSealedSpy.mockClear();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const cacheOnlyHook = await renderHook(() => useConnectedServiceQuotaBadges(profiles, { fetchPolicy: 'cache_only' }));
      await flushHookEffects({ cycles: 5, turns: 5 });

      expect(fetchAccountEncryptionModeSpy).not.toHaveBeenCalled();
      expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
      expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(cacheOnlyHook.getCurrent()['anthropic/work']?.map((badge) => badge.meterId)).toEqual(['weekly']);
      expect(cacheOnlyHook.getCurrent()['anthropic/work']?.map((badge) => badge.text)).toEqual(
        expect.arrayContaining([expect.stringContaining('18%')]),
      );
      expect(cacheOnlyHook.getCurrent()['anthropic/backup']?.map((badge) => badge.meterId)).toEqual(['daily']);
      expect(cacheOnlyHook.getCurrent()['anthropic/backup']?.map((badge) => badge.text)).toEqual(
        expect.arrayContaining([expect.stringContaining('60%')]),
      );
      await cacheOnlyHook.unmount();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
