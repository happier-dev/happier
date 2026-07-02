import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { flushHookEffects, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
let currentCredentials: Readonly<{ token: string; secret: string }> = stableCredentials;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: currentCredentials }),
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

function createDeferredAccountMode() {
  let resolve!: (value: Awaited<ReturnType<typeof fetchAccountEncryptionMode>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof fetchAccountEncryptionMode>>>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve } as const;
}

describe('ConnectedServiceQuotaCard', () => {
  beforeEach(() => {
    currentCredentials = stableCredentials;
    vi.clearAllMocks();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(null);
    getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue(null);
    requestConnectedServiceQuotaSnapshotRefreshSpy.mockResolvedValue(true);
    requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={onSetPinnedMeterIds}
        />)).tree;

    await flushHookEffects({ turns: 3 });

    expect(tree.findAll((n) => n.props?.title === 'Weekly')).toHaveLength(1);

    const row = tree.find((n) => n.props?.meter?.meterId === 'weekly' && typeof n.props?.onTogglePin === 'function');
    await act(async () => {
      invokeTestInstanceHandler(row, 'onTogglePin', );
    });

    expect(onSetPinnedMeterIds).toHaveBeenCalledWith(['weekly']);
  });

  it('does not restart an equivalent automatic load while the first quota request is unresolved', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    let resolvePlain!: (value: Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>) => void;
    const pendingPlain = new Promise<Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>>((resolve) => {
      resolvePlain = resolve;
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockReturnValue(pendingPlain);

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    currentCredentials = { ...stableCredentials };
    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="work"
            title="Quota Details"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });

    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePlain(ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      }));
    });
  });

  it('does not let a stale account-mode response choose the manual refresh endpoint after credentials change', async () => {
    const oldMode = createDeferredAccountMode();
    const newMode = createDeferredAccountMode();
    fetchAccountEncryptionModeSpy
      .mockReturnValueOnce(oldMode.promise)
      .mockReturnValueOnce(newMode.promise);
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    }));
    requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(true);

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(1);
    expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();

    currentCredentials = { ...stableCredentials, token: 't2' };
    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="work"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });
    expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      newMode.resolve({ mode: 'plain', updatedAt: 2 });
    });
    await flushHookEffects({ turns: 5 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldMode.resolve({ mode: 'e2ee', updatedAt: 1 });
    });
    await flushHookEffects({ turns: 5 });
    expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();

    const refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });

    expect(requestConnectedServiceQuotaSnapshotRefreshV3Spy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 't2' }),
      { serviceId: 'anthropic', profileId: 'work' },
    );
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to the sealed quota endpoint after credentials change while a plaintext miss is pending', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    let resolveOldPlain!: (value: Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>) => void;
    const pendingOldPlain = new Promise<Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>>((resolve) => {
      resolveOldPlain = resolve;
    });
    getConnectedServiceQuotaSnapshotPlainSpy
      .mockReturnValueOnce(pendingOldPlain)
      .mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: 2,
        staleAfterMs: 60_000,
        planLabel: 'New account',
        accountLabel: null,
        meters: [],
      }));

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

    currentCredentials = { ...stableCredentials, token: 't2' };
    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="work"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveOldPlain(null);
    });
    await flushHookEffects({ turns: 5 });

    expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
    expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ token: 't2' }),
      { serviceId: 'anthropic', profileId: 'work' },
    );
  });

  it('does not send a manual refresh after credentials change while it waits for the previous load', async () => {
    const oldMode = createDeferredAccountMode();
    fetchAccountEncryptionModeSpy
      .mockReturnValueOnce(oldMode.promise)
      .mockResolvedValue({ mode: 'plain', updatedAt: 2 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 2,
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    }));
    requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(true);

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(1);

    const refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });

    currentCredentials = { ...stableCredentials, token: 't2' };
    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="work"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });

    await act(async () => {
      oldMode.resolve({ mode: 'plain', updatedAt: 1 });
    });
    await flushHookEffects({ turns: 5 });

    expect(requestConnectedServiceQuotaSnapshotRefreshV3Spy).not.toHaveBeenCalled();
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).not.toHaveBeenCalled();
  });

  it('redacts secret-bearing quota load failures before rendering the refresh subtitle', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy.mockRejectedValueOnce(
      new Error('request failed: https://admin:secret@custom.example.test:9443/path/?token=abc (Authorization: Bearer very-secret-token)'),
    );

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    await flushHookEffects({ turns: 3 });

    const subtitle = String(tree.find((n) => n.props?.title === 'Refresh').props.subtitle);
    expect(subtitle).toContain('https://custom.example.test:9443/path');
    expect(subtitle).toContain('Authorization: Bearer [REDACTED]');
    expect(subtitle).not.toContain('admin:secret@');
    expect(subtitle).not.toContain('?token=abc');
    expect(subtitle).not.toContain('very-secret-token');
  });

  it('preserves last-known-good quota meters when a refresh reload fails', async () => {
    vi.useFakeTimers();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    getConnectedServiceQuotaSnapshotPlainSpy
      .mockResolvedValueOnce(ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: 40,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          remainingPct: 60,
          resetsAt: null,
          status: 'ok',
          confidence: 'exact',
          details: { limitCategory: 'usage_limit' },
        }],
      }))
      .mockRejectedValue(new Error('temporary outage'));
    requestConnectedServiceQuotaSnapshotRefreshV3Spy.mockResolvedValue(true);

    const onSnapshot = vi.fn();
    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
          onSnapshot={onSnapshot}
        />)).tree;

    await flushHookEffects({ turns: 5 });
    expect(tree.findAll((n) => n.props?.title === 'Weekly')).toHaveLength(1);

    const refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ cycles: 1, turns: 5, advanceTimersMs: 10_000 });

    expect(tree.findAll((n) => n.props?.title === 'Weekly')).toHaveLength(1);
    expect(onSnapshot).not.toHaveBeenCalledWith(null);
    vi.useRealTimers();
  });

  it('ignores stale automatic load results after the quota profile changes', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    let resolveWorkSnapshot!: (value: Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>) => void;
    const pendingWorkSnapshot = new Promise<Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>>((resolve) => {
      resolveWorkSnapshot = resolve;
    });
    const personalSnapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'personal',
      fetchedAt: 2,
      staleAfterMs: 60_000,
      planLabel: 'Personal',
      accountLabel: null,
      meters: [],
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, request) => (
      request.profileId === 'work'
        ? await pendingWorkSnapshot
        : personalSnapshot
    ));

    const onSnapshot = vi.fn();
    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
          onSnapshot={onSnapshot}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="personal"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
            onSnapshot={onSnapshot}
          />);
    });
    await flushHookEffects({ turns: 3 });

    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'personal' }));

    await act(async () => {
      resolveWorkSnapshot(ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: 1,
        staleAfterMs: 60_000,
        planLabel: 'Work',
        accountLabel: null,
        meters: [],
      }));
    });
    await flushHookEffects({ turns: 3 });

    expect(onSnapshot).not.toHaveBeenCalledWith(expect.objectContaining({ profileId: 'work' }));
    expect(tree.findAll((n) => n.children?.includes('Work'))).toHaveLength(0);
  });

  it('clears the current snapshot when the quota profile changes before the next load resolves', async () => {
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    const workSnapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Work',
      accountLabel: null,
      meters: [],
    });
    let resolvePersonalSnapshot!: (value: Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>) => void;
    const pendingPersonalSnapshot = new Promise<Awaited<ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>>>((resolve) => {
      resolvePersonalSnapshot = resolve;
    });
    const personalSnapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'personal',
      fetchedAt: 2,
      staleAfterMs: 60_000,
      planLabel: 'Personal',
      accountLabel: null,
      meters: [],
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, request) => (
      request.profileId === 'work'
        ? workSnapshot
        : await pendingPersonalSnapshot
    ));

    const onSnapshot = vi.fn();
    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
          onSnapshot={onSnapshot}
        />)).tree;

    await flushHookEffects({ turns: 3 });
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'work' }));
    const callsBeforeProfileChange = onSnapshot.mock.calls.length;

    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="personal"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
            onSnapshot={onSnapshot}
          />);
    });
    await flushHookEffects({ turns: 3 });

    expect(onSnapshot.mock.calls.slice(callsBeforeProfileChange)).toContainEqual([null]);

    await act(async () => {
      resolvePersonalSnapshot(personalSnapshot);
    });
    await flushHookEffects({ turns: 3 });

    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'personal' }));
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
    tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
          onSnapshot={onSnapshot}
        />)).tree;

    const refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      await pressTestInstanceAsync(refreshItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 10_000 });

    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledWith(
      expect.anything(),
      { serviceId: 'anthropic', profileId: 'work' },
    );

    // The card should attempt to reload until it sees a newer fetchedAt.
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ fetchedAt: 222 }));
    vi.useRealTimers();
  });

  it('coalesces concurrent manual refresh requests', async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: boolean) => void;
    const pendingRefresh = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    requestConnectedServiceQuotaSnapshotRefreshSpy.mockReturnValue(pendingRefresh);

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    const refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 5 });

    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh(true);
    });
    await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 10_000 });
    vi.useRealTimers();
  });

  it('does not coalesce manual refreshes across different quota profiles', async () => {
    vi.useFakeTimers();
    let resolveWorkRefresh!: (value: boolean) => void;
    const pendingWorkRefresh = new Promise<boolean>((resolve) => {
      resolveWorkRefresh = resolve;
    });
    requestConnectedServiceQuotaSnapshotRefreshSpy
      .mockReturnValueOnce(pendingWorkRefresh)
      .mockResolvedValue(true);

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    let refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });

    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="personal"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });
    refreshItem = tree.find((n) => n.props?.title === 'Refresh');

    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });

    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledTimes(2);
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { serviceId: 'anthropic', profileId: 'work' },
    );
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { serviceId: 'anthropic', profileId: 'personal' },
    );

    await act(async () => {
      resolveWorkRefresh(true);
    });
    await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 10_000 });
    vi.useRealTimers();
  });

  it('keeps manual refresh coalescing for an earlier profile after another profile starts refreshing', async () => {
    vi.useFakeTimers();
    let resolveWorkRefresh!: (value: boolean) => void;
    let resolvePersonalRefresh!: (value: boolean) => void;
    const pendingWorkRefresh = new Promise<boolean>((resolve) => {
      resolveWorkRefresh = resolve;
    });
    const pendingPersonalRefresh = new Promise<boolean>((resolve) => {
      resolvePersonalRefresh = resolve;
    });
    requestConnectedServiceQuotaSnapshotRefreshSpy.mockImplementation(async (_credentials, request) => (
      request.profileId === 'work'
        ? await pendingWorkRefresh
        : await pendingPersonalRefresh
    ));

    const tree = (await renderScreen(<ConnectedServiceQuotaCard
          serviceId="anthropic"
          profileId="work"
          title="Quotas"
          pinnedMeterIds={[]}
          onSetPinnedMeterIds={() => {}}
        />)).tree;

    let refreshItem = tree.find((n) => n.props?.title === 'Refresh');
    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="personal"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });
    refreshItem = tree.find((n) => n.props?.title === 'Refresh');

    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });
    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree.update(<ConnectedServiceQuotaCard
            serviceId="anthropic"
            profileId="work"
            title="Quotas"
            pinnedMeterIds={[]}
            onSetPinnedMeterIds={() => {}}
          />);
    });
    await flushHookEffects({ turns: 3 });
    refreshItem = tree.find((n) => n.props?.title === 'Refresh');

    await act(async () => {
      invokeTestInstanceHandler(refreshItem, 'onPress');
    });
    await flushHookEffects({ turns: 3 });

    expect(requestConnectedServiceQuotaSnapshotRefreshSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveWorkRefresh(true);
      resolvePersonalRefresh(true);
    });
    await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 10_000 });
    vi.useRealTimers();
  });
});
