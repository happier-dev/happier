import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred, renderHook } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getStorage, storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { useMachinePoolProjections, type MachinePoolProjectionScope } from './useMachinePoolProjections';
import { resetMachinePoolSyncRuntimeForTests } from './machinePoolSyncRuntime';
import { invalidateMachinePoolProjection } from './machinePoolProjection';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';

const boundary = {
    serverId: '',
    requests: [] as string[],
    poolFeatureEnabled: true,
    poolFetchOverride: null as null | (() => Promise<Response>),
};
const initialStorageState = getStorage().getState();

const pool = {
    pool: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Development',
        description: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
};

async function publishPoolsFeature(enabled: boolean): Promise<void> {
    resetServerFeaturesClientForTests();
    const features = buildServerFeaturesResponse();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        ...features,
        features: {
            ...features.features,
            machines: { ...features.features.machines, pools: { enabled } },
        },
    })));
    await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
}

describe('useMachinePoolProjections', () => {
    beforeEach(async () => {
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({
            serverUrl: 'https://machine-pool-projections.test',
            name: 'Projection Home',
        })).id;
        boundary.requests.length = 0;
        boundary.poolFeatureEnabled = true;
        boundary.poolFetchOverride = null;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        await publishPoolsFeature(true);
        setRuntimeFetch(async (url) => {
            if (String(url).endsWith('/v1/features')) {
                const features = buildServerFeaturesResponse();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: {
                            ...features.features.machines,
                            pools: { enabled: boundary.poolFeatureEnabled },
                        },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            boundary.requests.push(String(url));
            if (boundary.poolFetchOverride) return await boundary.poolFetchOverride();
            return Response.json({ pools: [pool] });
        });
        retireActiveServerAccountScopeLifetime();
        storage.setState({
            profileScope: { serverId: boundary.serverId, accountId: 'account-a' },
            settingsScope: { serverId: boundary.serverId, accountId: 'account-a' },
            machinePoolListByServerId: {},
            machinePoolListStatusByServerId: {},
        });
    });

    afterEach(() => {
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        resetMachinePoolSyncRuntimeForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('settles a failed background hydration as Pool state without a developer error toast', async () => {
        boundary.poolFetchOverride = async () => new Response('Pool list unavailable', { status: 503 });
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderHook(() => useMachinePoolProjections([{ serverId: boundary.serverId, machines: [] }]));

        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({ status: 'error', ready: false }));
        await act(async () => { await Promise.resolve(); });
        expect(report.mock.calls.filter(([message]) => String(message).startsWith('[fireAndForget] machinePools.'))).toEqual([]);
        await hook.unmount();
    });

    it('revalidates a Pool read begun before the active Account mounts', async () => {
        const previousApplied = getAppliedActiveServerSnapshot();
        const previouslyAvailable = isAppliedActiveServerRuntimeAvailable();
        onTestFinished(() => publishAppliedActiveServerSnapshot(previousApplied, previouslyAvailable));
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: null });
        retireActiveServerAccountScopeLifetime();
        const pending = createDeferred<Response>();
        boundary.poolFetchOverride = () => pending.promise;
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(boundary.requests.length).toBeGreaterThan(0));
        await act(async () => {
            storage.getState().activateProfileScope({ serverId: boundary.serverId, accountId: 'account-a' });
            boundary.poolFetchOverride = null;
            pending.resolve(Response.json({ pools: [pool] }));
        });
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({ pools: [pool], status: 'idle', ready: true }));
        expect(boundary.requests.length).toBeGreaterThan(1);
        expect(report.mock.calls.filter(([message]) => String(message).startsWith('[fireAndForget] machinePools.'))).toEqual([]);
        await hook.unmount();
    });

    it('gives every consumer of the same scope one hydrated answer from the canonical route', async () => {
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => ({
            settings: useMachinePoolProjections(scopes),
            newSession: useMachinePoolProjections(scopes),
        }));

        await vi.waitFor(() => {
            expect(hook.getCurrent().settings[0]).toMatchObject({
                featureEnabled: true,
                pools: [pool],
                status: 'idle',
                ready: true,
            });
        });
        expect(hook.getCurrent().newSession[0]).toEqual(hook.getCurrent().settings[0]);
        expect(boundary.requests.length).toBeGreaterThan(0);
        expect(new Set(boundary.requests)).toEqual(new Set([
            'https://machine-pool-projections.test/v1/machines/pools/list',
        ]));

        await hook.unmount();
    });

    it('settles a Home requested by its local profile id once it has a portable server identity', async () => {
        // Credentials, Actions and the Pool store all key this Home by its portable identity; a
        // Machines group still names it by the local profile id. The projection must not stay
        // "loading" forever because it read those owners under the other identifier.
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        await setServerProfileIdentityForUrl('https://machine-pool-projections.test', 'srv_projection_home');
        storage.setState({
            profileScope: { serverId: 'srv_projection_home', accountId: 'account-a' },
            settingsScope: { serverId: 'srv_projection_home', accountId: 'account-a' },
        });
        await publishPoolsFeature(true);
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));

        await vi.waitFor(() => {
            expect(hook.getCurrent()[0]).toMatchObject({
                serverId: boundary.serverId,
                accountId: 'account-a',
                featureEnabled: true,
                pools: [pool],
                status: 'idle',
                ready: true,
            });
        });
        await hook.unmount();
    });

    it('settles a first Pool list failure into the terminal error consumers can retry', async () => {
        setRuntimeFetch(async (url) => {
            if (String(url).endsWith('/v1/features')) {
                const features = buildServerFeaturesResponse();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: { ...features.features.machines, pools: { enabled: true } },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            boundary.requests.push(String(url));
            return new Response('nope', { status: 500 });
        });
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));

        // Nothing ever hydrated, so a permanent 'loading' would be a spinner with
        // no request owed and no way for a consumer to offer Retry.
        await vi.waitFor(() => {
            expect(hook.getCurrent()[0]).toMatchObject({
                featureEnabled: true,
                status: 'error',
                ready: false,
                pools: [],
            });
        });

        await hook.unmount();
    });

    it('settles cold Home discovery failure and recovers without a controller', async () => {
        resetServerFeaturesClientForTests();
        let homeReachable = false;
        const readHome = async (url: RequestInfo | URL): Promise<Response> => {
            if (String(url).endsWith('/v1/features')) {
                if (!homeReachable) throw new Error('network_unreachable');
                const features = buildServerFeaturesResponse();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: { ...features.features.machines, pools: { enabled: true } },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            boundary.requests.push(String(url));
            return Response.json({ pools: [pool] });
        };
        vi.stubGlobal('fetch', vi.fn(readHome));
        setRuntimeFetch(readHome);
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));

        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({
            featureStatus: 'error', featureEnabled: false, pools: [], ready: false,
        }));
        expect(boundary.requests).toEqual([]);

        homeReachable = true;
        await act(async () => {
            await invalidateMachinePoolProjection(boundary.serverId, { forceFeatures: true });
        });
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({
            featureStatus: 'enabled', featureEnabled: true, pools: [pool], status: 'idle', ready: true,
        }));
        expect(new Set(boundary.requests)).toEqual(new Set([
            'https://machine-pool-projections.test/v1/machines/pools/list',
        ]));
        await hook.unmount();
    });

    it('coalesces one Home wake across every mounted Pool consumer', async () => {
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => ({
            settings: useMachinePoolProjections(scopes),
            newSession: useMachinePoolProjections(scopes),
        }));
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));

        await act(async () => {
            publishHomeAccountChange(boundary.serverId);
        });

        await vi.waitFor(() => expect(boundary.requests.length).toBeGreaterThan(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(boundary.requests).toHaveLength(2);
        await hook.unmount();
    });

    it('retains signed-out rows inert when the canonical credential owner removes access', async () => {
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature` };
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://machine-pool-projections.test',
            { serverId: boundary.serverId },
            credentials,
        )).resolves.toBe(true);
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({ pools: [pool], status: 'idle' }));

        await act(async () => {
            await TokenStorage.removeCredentialsForServerUrl(
                'https://machine-pool-projections.test',
                { serverId: boundary.serverId },
            );
        });
        expect(hook.getCurrent()[0]).toMatchObject({ pools: [pool], status: 'signedOut', ready: false });
        await hook.unmount();
    });

    it('withdraws the previous Account before refreshing a replacement credential', async () => {
        const accountAToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature`;
        const accountBToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(
            'https://machine-pool-projections.test',
            { serverId: boundary.serverId },
            { token: accountAToken },
        );
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({ pools: [pool], status: 'idle' }));

        let resolveReplacementList: ((response: Response) => void) | null = null;
        setRuntimeFetch(async (url) => {
            if (String(url).endsWith('/v1/features')) {
                const features = buildServerFeaturesResponse();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: {
                            ...features.features.machines,
                            pools: { enabled: boundary.poolFeatureEnabled },
                        },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            if (String(url).endsWith('/v1/machines/pools/list')) {
                return await new Promise<Response>((resolve) => { resolveReplacementList = resolve; });
            }
            throw new Error(`Unexpected replacement credential request: ${String(url)}`);
        });
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: accountBToken });

        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
                'https://machine-pool-projections.test',
                { serverId: boundary.serverId },
                { token: accountBToken },
            );
        });

        expect(storage.getState().machinePoolListByServerId[boundary.serverId]).toBeUndefined();
        // The store removes the retired Account's entire scoped projection. The hook owns the
        // rendered transition and must expose that absence as loading rather than leaking A.
        expect(hook.getCurrent()[0]).toMatchObject({ pools: [], status: 'loading', ready: false });
        await vi.waitFor(() => expect(resolveReplacementList).not.toBeNull());
        await act(async () => {
            resolveReplacementList!(Response.json({ pools: [pool] }));
        });
        await vi.waitFor(() => expect(storage.getState().machinePoolAccountIdByServerId[boundary.serverId]).toBe('account-b'));
        expect(hook.getCurrent()[0]).toMatchObject({ pools: [pool], status: 'idle', ready: true });
        await hook.unmount();
        await TokenStorage.removeCredentialsForServerUrl(
            'https://machine-pool-projections.test',
            { serverId: boundary.serverId },
        );
    });

    it('never renders retained rows after a credential switch missed during an observer gap', async () => {
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const first = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(first.getCurrent()[0]).toMatchObject({ pools: [pool], ready: true }));
        await first.unmount();

        const accountBToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(
            'https://machine-pool-projections.test',
            { serverId: boundary.serverId },
            { token: accountBToken },
        );

        let resolveCredential!: (credentials: { token: string }) => void;
        const pendingCredential = new Promise<{ token: string }>((resolve) => { resolveCredential = resolve; });
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async () => await pendingCredential);

        const remounted = await renderHook(() => useMachinePoolProjections(scopes));
        expect(storage.getState().machinePoolAccountIdByServerId[boundary.serverId]).toBe('account-a');
        expect(remounted.getCurrent()[0]).toMatchObject({ pools: [], ready: false });

        await act(async () => {
            resolveCredential({ token: accountBToken });
        });
        await vi.waitFor(() => expect(storage.getState().machinePoolAccountIdByServerId[boundary.serverId]).toBe('account-b'));
        await vi.waitFor(() => expect(remounted.getCurrent()[0]).toMatchObject({ pools: [pool], ready: true }));
        await remounted.unmount();
    });

    it('hides a cached projection and requests nothing when the Home positively disables Pools', async () => {
        boundary.poolFeatureEnabled = false;
        await publishPoolsFeature(false);
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
        });
        boundary.requests.length = 0;
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];

        const hook = await renderHook(() => useMachinePoolProjections(scopes));

        expect(hook.getCurrent()[0]).toMatchObject({
            featureEnabled: false,
            pools: [],
            ready: true,
        });
        expect(boundary.requests).toEqual([]);

        await hook.unmount();
    });

    it('retains same-Account cached rows inert while feature discovery is unresolved', async () => {
        resetServerFeaturesClientForTests();
        let resolveFeatureDiscovery!: (response: Response) => void;
        const pendingFeatureDiscovery = async (url: RequestInfo | URL): Promise<Response> => {
            if (String(url).endsWith('/v1/features')) {
                return await new Promise<Response>((resolve) => {
                    resolveFeatureDiscovery = resolve;
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            boundary.requests.push(String(url));
            return Response.json({ pools: [pool] });
        };
        vi.stubGlobal('fetch', vi.fn(pendingFeatureDiscovery));
        setRuntimeFetch(pendingFeatureDiscovery);
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
        });
        boundary.requests.length = 0;
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];

        const hook = await renderHook(() => useMachinePoolProjections(scopes));

        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({
            featureStatus: 'loading',
            featureEnabled: false,
            pools: [pool],
            ready: false,
        }));
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);
        await vi.waitFor(() => expect(resolveFeatureDiscovery).toBeTypeOf('function'));
        await act(async () => {
            resolveFeatureDiscovery(Response.json(buildServerFeaturesResponse()));
        });
        await hook.unmount();
    });

    it('discovers Pools enabled after mount without sending an Action while they are disabled', async () => {
        boundary.poolFeatureEnabled = false;
        await publishPoolsFeature(false);
        boundary.requests.length = 0;
        const scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId, machines: [] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        expect(hook.getCurrent()[0]).toMatchObject({ featureEnabled: false, pools: [], ready: true });
        expect(boundary.requests).toEqual([]);

        boundary.poolFeatureEnabled = true;
        await act(async () => {
            publishHomeAccountChange(boundary.serverId);
        });

        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({
            featureEnabled: true,
            pools: [pool],
            ready: true,
        }));
        expect(boundary.requests).toEqual(['https://machine-pool-projections.test/v1/machines/pools/list']);
        await hook.unmount();
    });

    it.each([true, false])('retains a hydrated Pool answer through heartbeats and refresh (has Pools: %s)', async hasPools => {
        const rows = hasPools ? [pool] : [];
        boundary.poolFetchOverride = async () => Response.json({ pools: rows });
        let scopes: MachinePoolProjectionScope[] = [{ serverId: boundary.serverId,
            machines: [{ id: 'machine-a', active: true, activeAt: 1 }] }];
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({ pools: rows, status: 'idle', ready: true }));
        const response = createDeferred<Response>();
        boundary.poolFetchOverride = () => response.promise;
        // A heartbeat renews the same connection, not the Pool membership/availability lifecycle.
        scopes = [{ serverId: boundary.serverId, machines: [{ id: 'machine-a', active: true, activeAt: 2 }] }];
        await hook.rerender();
        expect(boundary.requests).toHaveLength(1);
        expect(hook.getCurrent()[0]).toMatchObject({ pools: rows, status: 'idle', ready: true });
        let refreshing!: Promise<void>;
        await act(async () => { refreshing = invalidateMachinePoolProjection(boundary.serverId); });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(2));
        // Even an empty list is a known answer; a background refresh must not resurrect its cold spinner.
        expect(hook.getCurrent()[0]).toMatchObject({ pools: rows, status: 'idle', ready: true });
        await act(async () => { response.resolve(Response.json({ pools: rows })); await refreshing; });
        expect(hook.getCurrent()[0]).toMatchObject({ pools: rows, status: 'idle', ready: true });
        await hook.unmount();
    });

    it('refreshes availability when a Machine lifecycle fact changes, not on unrelated Machine edits', async () => {
        const scopeWith = (machines: MachinePoolProjectionScope['machines']): MachinePoolProjectionScope[] => [
            { serverId: boundary.serverId, machines },
        ];
        let scopes = scopeWith([{ id: 'machine-a', active: false, activeAt: 1, updatedAt: 1 }]);
        const hook = await renderHook(() => useMachinePoolProjections(scopes));
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));

        scopes = scopeWith([{ id: 'machine-a', active: false, activeAt: 1, updatedAt: 1 }]);
        await hook.rerender();
        expect(boundary.requests).toHaveLength(1);

        scopes = scopeWith([{ id: 'machine-a', active: false, activeAt: 1, updatedAt: 2 }]);
        await hook.rerender();
        expect(boundary.requests).toHaveLength(1);

        const retainedMachine = scopes[0]!.machines[0]!;
        await act(async () => publishMachineActivity(retainedMachine, { active: true, activeAt: 2 }, []));
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(2));
        await act(async () => publishMachineActivity(retainedMachine, { active: true, activeAt: 3 }, []));
        expect(boundary.requests).toHaveLength(2);

        await hook.unmount();
    });
});
