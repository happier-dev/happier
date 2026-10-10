import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountQuotaSnapshotV4Schema } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { __resetConnectedServiceQuotaSnapshotStore } from './connectedServiceQuotaSnapshotStore';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from './qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref, quotaTestSnapshot, quotaTestResponse } from './qualifiedConnectedAccountQuotaTestHarness';
import { useConnectedServiceQuotaSnapshots } from './useConnectedServiceQuotaSnapshots';
import { useQualifiedConnectedAccountQuota } from './useQualifiedConnectedAccountQuota';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();

const snapshot = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
    ...quotaTestSnapshot,
    meters: [{ meterId: 'weekly', label: 'Weekly', used: 40, limit: 100, unit: 'count',
        utilizationPct: null, resetsAt: null, status: 'ok', confidence: 'exact', details: { limitCategory: 'usage_limit' } }],
});
const fresh = QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
    ...snapshot, fetchedAt: 2, meters: [{ ...snapshot.meters[0]!, meterId: 'server-b', label: 'Server B' }],
});
const profileInput = [{ serviceId: 'anthropic', profileId: 'work' }] as const;

describe('useConnectedServiceQuotaSnapshots V4 transport', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
    function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(InjectedAuthProvider, { credentials: boundary.account.credentials }, children);
    }

    function installAccountProfile(accountRef = ref) {
        storage.getState().applyProfile({ ...profileDefaults, id: 'quota-account', connectedAccountsV4: [
            QualifiedConnectedAccountProfileV4Schema.parse({
                ref: accountRef, status: 'connected', authenticationModeId: 'api-key',
                revisionSemantics: 'revisioned',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
                configurationRevision: null, scopes: [],
            }),
        ] });
    }

    function installFeatures(protocolVersion = 4) {
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: boundary.account.home.serverIdentityId! },
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion } },
        } });
        boundary.features.mockImplementation(async () => new Response(JSON.stringify(features), { status: 200 }));
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features } });
        storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    }

    async function selectFixtureHome() {
        const serverId = getActiveServerSnapshot().serverId;
        // The list feature gate follows the selected Home view, not merely the active connection.
        await updateEffectiveHomeViewState((current) => ({
            ...current, activeTargetKind: 'server', activeTargetId: serverId,
        }), { scope: 'device' });
    }

    function expectNoLegacyQuotaRequest() {
        expect(boundary.requests.filter(({ path }) => path.includes('/connect/') && !path.startsWith('/v4/connect/'))).toEqual([]);
    }

    beforeEach(async () => {
        standardCleanup();
        __resetConnectedServiceQuotaSnapshotStore();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        resetServerFeaturesClientForTests();
        boundary = await createQualifiedQuotaTestHarness();
        installAccountProfile();
        installFeatures();
        await selectFixtureHome();
        boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(snapshot)), { status: 200 }));
    });

    afterEach(async () => {
        standardCleanup();
        __resetConnectedServiceQuotaSnapshotStore();
        __resetQualifiedConnectedAccountQuotaSnapshotStore();
        await boundary?.dispose();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
    });

    it('uses the exact qualified V4 quota identity without issuing a legacy request', async () => {
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly'));
        expect(boundary.read).toHaveBeenCalledWith(ref);
        expect(hook.getCurrent().usageRecordIdsByKey['anthropic/work']).toBe(quotaTestResponse(snapshot).sourceResolution.recordId);
        expect(boundary.controls).toEqual([]);
        expectNoLegacyQuotaRequest();
    });

    it('polls a novel qualified account without inventing a legacy service id', async () => {
        const novelRef = { service: { pluginId: 'acme.connected.accounts', localId: 'gateway' }, accountId: 'work' };
        const novelSnapshot = { ...snapshot, ref: novelRef };
        installAccountProfile(novelRef);
        boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(novelSnapshot)), { status: 200 }));
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ ref: novelRef }]), { wrapper: Wrapper });
        const key = 'acme.connected.accounts%2Fgateway/work';
        await vi.waitFor(() => expect(hook.getCurrent().snapshotsByKey[key]).toMatchObject({ ref: novelRef }));
        expect(boundary.read).toHaveBeenCalledWith(novelRef);
        expect(hook.getCurrent().profiles).toContainEqual(expect.objectContaining({ kind: 'qualified', key, ref: novelRef }));
        expectNoLegacyQuotaRequest();
    });

    it('never exposes a prior-server V4 snapshot after the real active Home changes', async () => {
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly'));
        const originalHome = getActiveServerSnapshot();
        await act(async () => {
            await boundary.dispose();
            boundary = await createQualifiedQuotaTestHarness({ serverUrl: 'https://qualified-quota-second.test', serverIdentityId: 'srv_qualified_quota_second', snapshot: fresh });
            installAccountProfile();
            installFeatures();
            await selectFixtureHome();
            boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(fresh)), { status: 200 }));
        });
        expect(getActiveServerSnapshot().serverId).not.toBe(originalHome.serverId);
        await hook.rerender();
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).not.toBe('weekly');
        await vi.waitFor(() => expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('server-b'));
        expect(boundary.read).toHaveBeenCalledWith(ref);
        expectNoLegacyQuotaRequest();
    });

    it('performs no quota operation when the advertised qualified protocol is not 4', async () => {
        installFeatures(5);
        await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).not.toHaveBeenCalled();
        expect(boundary.controls).toEqual([]);
        expectNoLegacyQuotaRequest();
    });

    it('shares one V4 quota entry between the list and detail readers', async () => {
        const hook = await renderHook(() => ({
            list: useConnectedServiceQuotaSnapshots(profileInput),
            detail: useQualifiedConnectedAccountQuota(ref),
        }), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().detail.snapshot?.meters[0]?.meterId).toBe('weekly'));
        expect(hook.getCurrent().list.snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(boundary.read).toHaveBeenCalledTimes(1);
    });

    it('refreshes selected list accounts with a shared read entry even when detail refresh is disabled', async () => {
        const hook = await renderHook(() => ({
            list: useConnectedServiceQuotaSnapshots(profileInput, { fetchPolicy: 'once' }),
            detail: useQualifiedConnectedAccountQuota(ref, { refreshMachineId: null }),
        }), { wrapper: Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent().list.snapshotsByKey['anthropic/work']?.fetchedAt).toBe(1));
        let finishRefresh!: () => void;
        boundary.refresh.mockImplementationOnce(() => new Promise<Response>((resolve) => {
            finishRefresh = () => resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
        }));
        boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(fresh)), { status: 200 }));
        let refresh!: Promise<void>;
        await act(async () => { refresh = hook.getCurrent().list.refresh(['anthropic/work']); });
        await vi.waitFor(() => expect(boundary.refresh).toHaveBeenCalledWith(ref));
        expect(hook.getCurrent().list.refreshingByKey['anthropic/work']).toBe(true);
        expect(hook.getCurrent().list.snapshotsByKey['anthropic/work']?.fetchedAt).toBe(1);
        await act(async () => { finishRefresh(); await refresh; });
        expect(hook.getCurrent().list.snapshotsByKey['anthropic/work']?.fetchedAt).toBe(2);
        expect(hook.getCurrent().detail.snapshot?.fetchedAt).toBe(2);
        expect(hook.getCurrent().list.refreshingByKey['anthropic/work']).toBe(false);
        expect(hook.getCurrent().list.errorsByKey['anthropic/work']).toBeNull();
        expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: { operation: 'describeService', service: ref.service, requiredOperation: 'quota_refresh' } }]);
        boundary.refresh.mockClear();
        await act(async () => { await hook.getCurrent().list.refresh(['missing/account']); });
        expect(boundary.refresh).not.toHaveBeenCalled();
    });
});
