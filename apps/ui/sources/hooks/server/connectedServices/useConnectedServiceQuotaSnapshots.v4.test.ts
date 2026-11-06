import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountQuotaSnapshotV4Schema } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { parseServerFeatures } from '@/sync/api/capabilities/serverFeaturesParse';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { __resetConnectedServiceQuotaSnapshotStore } from './connectedServiceQuotaSnapshotStore';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref, quotaTestSnapshot, quotaTestResponse,
    quotaTestProviderUsageSnapshot, quotaTestProviderUsageResponse } from './qualifiedConnectedAccountQuotaTestHarness';
import { useConnectedServiceQuotaSnapshots } from './useConnectedServiceQuotaSnapshots';
import { useQualifiedConnectedAccountQuota } from './useQualifiedConnectedAccountQuota';
import { useProviderAccountUsageSnapshots } from './useProviderAccountUsageSnapshots';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

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
        return React.createElement(InjectedAuthProvider, { credentials: boundary.account.credentials, children });
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
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } },
        } });
        // Malformed/future wire advertisements must cross the real feature decoder, not masquerade as admitted facts.
        const advertised = { ...features, capabilities: { ...features.capabilities,
            connectedServices: { ...features.capabilities.connectedServices, qualifiedAccounts: { protocolVersion } },
        } };
        boundary.features.mockImplementation(async () => Response.json(advertised));
        const parsed = parseServerFeatures(advertised);
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: parsed
            ? { status: 'ready', features: parsed }
            : { status: 'unsupported', reason: 'invalid_payload' } });
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

    it('keeps quota acquisition stable across one turn of account activity and reads one real allowance change', async () => {
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).toHaveBeenCalledTimes(1);
        const retained = hook.getCurrent().snapshotsByKey['anthropic/work'];
        // Exercise 27 activity updates, matching F4's observed request count.
        // lastUsedAt changes while the admitted quota transport/ref stays the same.
        for (let arrival = 1; arrival <= 27; arrival++) {
            await act(async () => {
                const profile = storage.getState().profile;
                storage.getState().applyProfile({ ...profile, connectedAccountsV4: profile.connectedAccountsV4.map(account => ({
                    ...account, lastUsedAt: arrival,
                })) });
                publishHomeAccountChange(getActiveServerSnapshot().serverId, ['turn-session'], { changeKinds: ['session'] });
            });
            await flushHookEffects({ cycles: 3, turns: 3 });
        }
        expect(boundary.read).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBe(retained);
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(fresh)));
        await act(async () => {
            publishHomeAccountChange(getActiveServerSnapshot().serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] });
        });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(fresh.fetchedAt);
    });

    it('shares visible summary and Session quota demand, retains facts on reopen, and revalidates once', async () => {
        const { useUsageSummary } = await import('@/components/hub/usage/useUsageSummary');
        const summary = await renderHook(() => useUsageSummary({ load: 'visible' }), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).toHaveBeenCalledTimes(1);
        expect(boundary.read).toHaveBeenCalledTimes(1);
        expect(summary.getCurrent().entries[0]?.fetchedAt).toBe(snapshot.fetchedAt);
        await summary.unmount();
        let finish!: (response: Response) => void;
        boundary.read.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
        const reopened = await renderHook(() => useUsageSummary({ load: 'visible' }), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(reopened.getCurrent().entries[0]?.fetchedAt).toBe(snapshot.fetchedAt);
        expect(boundary.read).toHaveBeenCalledTimes(2);
        const joined = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(joined.getCurrent().loadingByKey['anthropic/work']).toBe(true);
        expect(boundary.read).toHaveBeenCalledTimes(2);
        await act(async () => { finish(Response.json(quotaTestResponse(fresh))); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(reopened.getCurrent().entries[0]?.fetchedAt).toBe(fresh.fetchedAt);
        await reopened.unmount(); await joined.unmount();
        await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
            [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).toHaveBeenCalledTimes(2);
    });

    it('refreshes retained quota on persisted usage changes without healthy GET polling', async () => {
        vi.useFakeTimers();
        try {
            const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(1);
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(boundary.read).toHaveBeenCalledTimes(1);
            boundary.read.mockImplementation(async () => new Response(JSON.stringify(quotaTestResponse(fresh)), { status: 200 }));
            await act(async () => {
                publishHomeAccountChange(getActiveServerSnapshot().serverId,
                    [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] });
            });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(2);
            expect(boundary.read).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });

    it('catches up a persisted change received during the admitted read and releases the observer on unmount', async () => {
        let finishFirst!: () => void;
        boundary.read.mockImplementationOnce(() => new Promise<Response>(resolve => {
            finishFirst = () => resolve(Response.json(quotaTestResponse(snapshot)));
        }));
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(fresh)));
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.read).toHaveBeenCalledTimes(1);
        await act(async () => {
            publishHomeAccountChange(getActiveServerSnapshot().serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            publishHomeAccountChange(getActiveServerSnapshot().serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            finishFirst();
        });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(2);
        expect(boundary.read).toHaveBeenCalledTimes(2);
        await hook.unmount();
        publishHomeAccountChange(getActiveServerSnapshot().serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.read).toHaveBeenCalledTimes(2);
    });

    it('ignores foreign and exact unrelated changes but catches up the connected Home wake', async () => {
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(fresh)));
        await act(async () => {
            publishHomeAccountChange('foreign-home', [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            publishHomeAccountChange(getActiveServerSnapshot().serverId, ['machine'], { changeKinds: ['machine'], usageQueryAffects: false });
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.read).toHaveBeenCalledTimes(1);
        await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId, undefined,
            { source: 'connected', usageQueryAffects: false }); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(2);
        expect(boundary.read).toHaveBeenCalledTimes(2);
    });

    it('shares retained provider-row acquisition, ages it locally, and consumes persisted usage changes', async () => {
        vi.useFakeTimers();
        try {
            const initial = quotaTestProviderUsageSnapshot();
            boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(initial)));
            const first = await renderHook(() => useProviderAccountUsageSnapshots([initial.recordId]), { wrapper: Wrapper });
            const second = await renderHook(() => useProviderAccountUsageSnapshots([initial.recordId]), { wrapper: Wrapper });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(first.getCurrent().stateByRecordId[initial.recordId]).toBe('loaded_data');
            expect(boundary.usageRead).toHaveBeenCalledTimes(1);
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(first.getCurrent().stateByRecordId[initial.recordId]).toBe('stale_data');
            expect(boundary.usageRead).toHaveBeenCalledTimes(1);
            await first.unmount();
            const updated = { ...initial, observedAtMs: Date.now(), fetchedAtMs: Date.now() };
            boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(updated)));
            await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }); });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(second.getCurrent().snapshotsByRecordId[initial.recordId]?.fetchedAtMs).toBe(updated.fetchedAtMs);
            expect(second.getCurrent().stateByRecordId[initial.recordId]).toBe('loaded_data');
            expect(boundary.usageRead).toHaveBeenCalledTimes(2);
            await second.unmount();
            publishHomeAccountChange(getActiveServerSnapshot().serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(boundary.usageRead).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });

    it('retains the last quota after failure without timed retries and recovers on a quota push', async () => {
        vi.useFakeTimers();
        try {
            const hook = await renderHook(() => useConnectedServiceQuotaSnapshots(profileInput), { wrapper: Wrapper });
            await flushHookEffects({ cycles: 8, turns: 8 });
            boundary.read.mockImplementationOnce(async () => new Response('{}', { status: 400 }));
            boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(fresh)));
            await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(1);
            expect(boundary.read).toHaveBeenCalledTimes(2);
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(boundary.read).toHaveBeenCalledTimes(2);
            await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
                [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }); });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.fetchedAt).toBe(2);
            expect(boundary.read).toHaveBeenCalledTimes(3);
        } finally { vi.useRealTimers(); }
    });

    it('refuses a held provider-row response after the real Home generation changes', async () => {
        const initial = quotaTestProviderUsageSnapshot();
        let finishOld!: () => void;
        boundary.usageRead.mockImplementationOnce(() => new Promise<Response>(resolve => {
            finishOld = () => resolve(Response.json(quotaTestProviderUsageResponse(initial)));
        }));
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([initial.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.usageRead).toHaveBeenCalledTimes(1);
        const updated = { ...initial, meters: [{ ...initial.meters[0]!, used: 50 }] };
        await act(async () => {
            await boundary.dispose();
            boundary = await createQualifiedQuotaTestHarness({ serverUrl: 'https://qualified-quota-second.test', serverIdentityId: 'srv_qualified_quota_second' });
            installAccountProfile(); installFeatures(); await selectFixtureHome();
            boundary.usageRead.mockImplementation(async () => Response.json(quotaTestProviderUsageResponse(updated)));
        });
        await hook.rerender();
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[initial.recordId]?.meters[0]?.used).toBe(50);
        await act(async () => { finishOld(); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByRecordId[initial.recordId]?.meters[0]?.used).toBe(50);
    });

    it('drains a persisted wake after manual refresh settles without another provider probe', async () => {
        const hook = await renderHook(() => useQualifiedConnectedAccountQuota(ref), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        let finishRead!: () => void;
        boundary.read.mockImplementationOnce(() => new Promise<Response>(resolve => {
            finishRead = () => resolve(Response.json(quotaTestResponse(fresh)));
        }));
        const newest = { ...fresh, fetchedAt: 3 };
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(newest)));
        let refresh!: Promise<void>;
        await act(async () => { refresh = hook.getCurrent().refresh(); });
        await vi.waitFor(() => expect(boundary.read).toHaveBeenCalledTimes(2));
        await act(async () => {
            publishHomeAccountChange(getActiveServerSnapshot().serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
            finishRead(); await refresh;
        });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(3);
        expect(boundary.read).toHaveBeenCalledTimes(3);
        expect(boundary.refresh).toHaveBeenCalledTimes(1);
    });

    it('observes a novel qualified account without inventing a legacy service id', async () => {
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
