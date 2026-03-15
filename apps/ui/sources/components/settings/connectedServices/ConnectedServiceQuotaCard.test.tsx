import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type {
  getConnectedServiceQuotaSnapshotSealed,
  requestConnectedServiceQuotaSnapshotRefresh,
} from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type {
  getConnectedServiceQuotaSnapshotPlain,
  requestConnectedServiceQuotaSnapshotRefreshV3,
} from '@/sync/api/account/apiConnectedServicesQuotasV3';

import { ConnectedServiceQuotaCard } from './ConnectedServiceQuotaCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
  requestConnectedServiceQuotaSnapshotRefreshSpy,
  requestConnectedServiceQuotaSnapshotRefreshV3Spy,
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
  requestConnectedServiceQuotaSnapshotRefreshSpy: vi.fn<
    (...args: Parameters<typeof requestConnectedServiceQuotaSnapshotRefresh>) => ReturnType<typeof requestConnectedServiceQuotaSnapshotRefresh>
  >(async () => true),
  requestConnectedServiceQuotaSnapshotRefreshV3Spy: vi.fn<
    (...args: Parameters<typeof requestConnectedServiceQuotaSnapshotRefreshV3>) => ReturnType<typeof requestConnectedServiceQuotaSnapshotRefreshV3>
  >(async () => false),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
  requestConnectedServiceQuotaSnapshotRefresh: requestConnectedServiceQuotaSnapshotRefreshSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
  requestConnectedServiceQuotaSnapshotRefreshV3: requestConnectedServiceQuotaSnapshotRefreshV3Spy,
}));

async function flushAsyncEffects(turns: number = 3) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

describe('ConnectedServiceQuotaCard', () => {
  it('loads a snapshot and toggles pinned meter ids', async () => {
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
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret: secretBytes },
      payload: snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
    });

    const onSetPinnedMeterIds = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={onSetPinnedMeterIds}
        />,
      );
    });

    await act(async () => {
      await flushAsyncEffects();
    });

    expect(tree.root.findAll((n) => n.props?.title === 'Weekly')).toHaveLength(1);

    const row = tree.root.find((n) => n.props?.meter?.meterId === 'weekly' && typeof n.props?.onTogglePin === 'function');
    await act(async () => {
      row.props.onTogglePin();
    });

    expect(onSetPinnedMeterIds).toHaveBeenCalledWith(['weekly']);
  });

  it('requests a background refresh before reloading', async () => {
    vi.useFakeTimers();
    const secretBytes = new Uint8Array(32).fill(3);

    const buildSealed = (fetchedAt: number) => {
      const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      });
      const ciphertext = sealAccountScopedBlobCiphertext({
        kind: 'connected_service_quota_snapshot',
        material: { type: 'legacy', secret: secretBytes },
        payload: snapshot,
        randomBytes: (length) => new Uint8Array(length).fill(7),
      });
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' as const },
      };
    };

    getConnectedServiceQuotaSnapshotSealedSpy
      .mockResolvedValueOnce(buildSealed(111)) // initial mount load
      .mockResolvedValueOnce(buildSealed(111)) // first post-refresh attempt (still old)
      .mockResolvedValueOnce(buildSealed(222)); // later attempt returns updated snapshot
    requestConnectedServiceQuotaSnapshotRefreshSpy.mockResolvedValueOnce(true);

    const onSnapshot = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
          onSnapshot={onSnapshot}
        />,
      );
    });

    const refreshItem = tree.root.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      refreshItem.props.onPress?.();
    });
    await act(async () => {
      await flushAsyncEffects();
    });

    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledWith(
      expect.anything(),
      { serviceId: 'anthropic', profileId: 'work' },
    );

    // The card should attempt to reload until it sees a newer fetchedAt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ fetchedAt: 222 }));
    vi.useRealTimers();
  });
});
