import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred, createMachineFixture, renderHook } from '@/dev/testkit';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    buildMachineDestinationModel,
    resolveMachinePoolRowUnavailableReason,
} from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { resetMachinePoolSyncRuntimeForTests } from '@/sync/engine/machines/machinePoolSyncRuntime';

import { useMachinePoolGroups } from './useMachinePoolGroups';

const boundary = {
    serverId: '',
    requests: [] as string[],
    poolFeatureEnabled: true,
    featureFetchOverride: null as null | (() => Promise<Response>),
};
const initialStorageState = getStorage().getState();
const pool = {
    pool: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Existing pool',
        description: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
};

describe('useMachinePoolGroups', () => {
    it('keeps Team metadata-only pools out of ordinary Session destinations', async () => {
        storage.setState({ machinePoolListByServerId: { [boundary.serverId]: [{ ...pool,
            pool: { ...pool.pool, audience: { kind: 'team', teamId: 'team-build' } },
            access: { canManage: false, canResolve: false, canViewMembers: false } }] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' } });
        const groups = [{ serverId: boundary.serverId, serverName: 'Pool Groups Test', machines: [] }];
        const rendered = await renderHook(() => useMachinePoolGroups(groups));
        expect(rendered.getCurrent()[0]?.pools).toEqual([]);
        await rendered.unmount();
    });
    beforeEach(async () => {
        resetMachinePoolSyncRuntimeForTests();
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({
            serverUrl: 'https://new-session-pool-groups.test',
            name: 'Pool Groups Test',
        })).id;
        boundary.requests.length = 0;
        boundary.poolFeatureEnabled = true;
        boundary.featureFetchOverride = null;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const features = buildServerFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: true } },
            },
        })));
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        setRuntimeFetch(async (url) => {
            if (String(url).endsWith('/v1/features')) {
                if (boundary.featureFetchOverride) return await boundary.featureFetchOverride();
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: { ...features.features.machines, pools: { enabled: boundary.poolFeatureEnabled } },
                    },
                });
            }
            if (String(url).endsWith('/v1/account/encryption')) {
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (String(url).endsWith('/v2/account/settings')) {
                return Response.json({ content: null, version: 0 });
            }
            boundary.requests.push(String(url));
            return Response.json({ pools: [pool] });
        });
        retireActiveServerAccountScopeLifetime();
        storage.setState({
            profileScope: { serverId: boundary.serverId, accountId: 'account-a' },
            machinePoolListByServerId: {},
            machinePoolListStatusByServerId: {},
        });
    });

    afterEach(() => {
        resetMachinePoolSyncRuntimeForTests();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('hydrates existing pools from a cold projection when New Session becomes their consumer', async () => {
        const groups = [{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
        }];
        const hook = await renderHook(() => useMachinePoolGroups(groups));

        await vi.waitFor(() => {
            expect(boundary.requests.filter((url) => new URL(url).pathname.startsWith('/v1/machines/pools/'))).toEqual([
                'https://new-session-pool-groups.test/v1/machines/pools/list',
            ]);
            expect(hook.getCurrent()[0]?.pools).toEqual([pool]);
            expect(hook.getCurrent()[0]?.accountId).toBe('account-a');
        });

        await hook.unmount();
    });

    it('carries the canonical projection status so retained rows cannot look current', async () => {
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
        });
        resetServerFeaturesClientForTests();
        boundary.featureFetchOverride = async () => {
            throw new Error('network_unreachable');
        };
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network_unreachable');
        }));
        const groups = [{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
        }];

        const hook = await renderHook(() => useMachinePoolGroups(groups));

        await vi.waitFor(() => {
            expect(hook.getCurrent()[0]).toMatchObject({
                pools: [pool],
                featureStatus: 'error',
                status: 'error',
            });
        });
        // The canonical currentness owner, not this mapper, decides that a failed Home's retained
        // rows cannot invoke the read-only resolve.
        expect(resolveMachinePoolRowUnavailableReason({ poolGroup: hook.getCurrent()[0]! })).toBe('poolsFailed');

        await hook.unmount();
    });

    it('keeps retained Pools inert while their Home Machine snapshot is failed', async () => {
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
        });

        const hook = await renderHook(() => useMachinePoolGroups([{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
            error: true,
        }]));

        await vi.waitFor(() => expect(hook.getCurrent()[0]).toMatchObject({
            pools: [pool],
            status: 'error',
            projectionReady: false,
        }));
        expect(resolveMachinePoolRowUnavailableReason({ poolGroup: hook.getCurrent()[0]! })).toBe('poolsFailed');
        await hook.unmount();
    });

    it('hides a cached projection and skips its refresh when Pools are disabled', async () => {
        boundary.poolFeatureEnabled = false;
        resetServerFeaturesClientForTests();
        const features = buildServerFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: false } },
            },
        })));
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
        });
        boundary.requests.length = 0;

        const hook = await renderHook(() => useMachinePoolGroups([{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
        }]));

        expect(hook.getCurrent()[0]).toMatchObject({
            pools: [],
            featureStatus: 'disabled',
            projectionReady: true,
        });
        expect(boundary.requests.filter((url) => !url.endsWith('/v1/features'))).toEqual([]);

        await hook.unmount();
    });

    it('settles the destination set on a Home that disables Pools and never cached a list', async () => {
        boundary.poolFeatureEnabled = false;
        resetServerFeaturesClientForTests();
        const features = buildServerFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: false } },
            },
        })));
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        boundary.requests.length = 0;

        const hook = await renderHook(() => useMachinePoolGroups([{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
        }]));

        await vi.waitFor(() => expect(hook.getCurrent()[0]?.projectionReady).toBe(true));
        expect(hook.getCurrent()[0]).toMatchObject({ pools: [], featureStatus: 'disabled' });
        // A settled "this Home has no Pools" answer has no list left to load. Reporting it as a
        // pending read would make every Home without the feature look permanently incomplete.
        expect(resolveMachinePoolRowUnavailableReason({ poolGroup: hook.getCurrent()[0]! })).toBeNull();

        // The user-visible consequence: an ordinary one-Machine Home must still offer its single
        // destination automatically instead of waiting forever for a Pool answer that already came.
        const onlyMachine = {
            ...createMachineFixture({ id: 'machine-a' }),
            active: true,
            activeAt: Date.now(),
        };
        publishMachineActivityForTest([onlyMachine]);
        expect(buildMachineDestinationModel({
            scopesByServerId: new Map([[boundary.serverId, { serverId: boundary.serverId, accountId: 'account-a' }]]),
            groups: [{
                serverId: boundary.serverId,
                machines: [onlyMachine],
                loading: false,
                signedOut: false,
            }],
            poolGroups: hook.getCurrent(),
            // The shortcut also requires the managed-destination owner to have
            // settled; this Home contributes no managed offers in this scenario.
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
        }).soleSelectableDestination).toEqual({
            serverId: boundary.serverId,
            machine: expect.objectContaining({ id: 'machine-a' }),
        });
        expect(boundary.requests.filter((url) => !url.endsWith('/v1/features'))).toEqual([]);

        await hook.unmount();
    });

    it('keeps retained rows inert while feature discovery is unresolved', async () => {
        resetServerFeaturesClientForTests();
        const featureResponse = createDeferred<Response>();
        boundary.featureFetchOverride = () => featureResponse.promise;
        vi.stubGlobal('fetch', vi.fn(() => featureResponse.promise));
        storage.setState({
            machinePoolListByServerId: { [boundary.serverId]: [pool] },
            machinePoolListStatusByServerId: { [boundary.serverId]: 'idle' },
            machinePoolAccountIdByServerId: { [boundary.serverId]: 'account-a' },
        });
        boundary.requests.length = 0;

        const hook = await renderHook(() => useMachinePoolGroups([{
            serverId: boundary.serverId,
            serverName: 'Pool Groups Test',
            machines: [],
        }]));

        expect(hook.getCurrent()[0]).toMatchObject({
            pools: [pool],
            status: 'loading',
            projectionReady: false,
        });
        expect(resolveMachinePoolRowUnavailableReason({ poolGroup: hook.getCurrent()[0]! })).toBe('poolsLoading');
        expect(boundary.requests.some((url) => url.endsWith('/v1/machines/pools/list'))).toBe(false);

        const features = buildServerFeaturesResponse();
        await act(async () => featureResponse.resolve(Response.json({
            ...features,
            features: {
                ...features.features,
                machines: {
                    ...features.features.machines,
                    pools: { enabled: true },
                },
            },
        })));
        await vi.waitFor(() => expect(hook.getCurrent()[0]?.projectionReady).toBe(true));
        await hook.unmount();
    });
});
