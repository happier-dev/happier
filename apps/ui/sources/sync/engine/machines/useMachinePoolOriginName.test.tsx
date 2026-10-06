import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { useMachinePoolOriginName } from './useMachinePoolOriginName';
import { resetMachinePoolSyncRuntimeForTests } from './machinePoolSyncRuntime';

const pool = {
    pool: {
        id: '00000000-0000-4000-8000-000000000051',
        name: 'Development',
        description: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
};
const initialStorageState = getStorage().getState();
const boundary = { serverId: '', requests: [] as string[] };

describe('useMachinePoolOriginName', () => {
    beforeEach(async () => {
        resetMachinePoolSyncRuntimeForTests();
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({
            serverUrl: 'https://session-origin-pools.test',
            name: 'Session Home',
        })).id;
        boundary.requests.length = 0;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer-account' })).toString('base64')}.signature`;
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
            boundary.requests.push(String(url));
            if (String(url).endsWith('/v1/features')) {
                return Response.json({
                    ...features,
                    features: {
                        ...features.features,
                        machines: { ...features.features.machines, pools: { enabled: true } },
                    },
                });
            }
            return Response.json({ pools: [pool] });
        });
        retireActiveServerAccountScopeLifetime();
        storage.setState({
            profileScope: { serverId: boundary.serverId, accountId: 'viewer-account' },
            settingsScope: { serverId: boundary.serverId, accountId: 'viewer-account' },
            machinePoolListByServerId: {},
            machinePoolListStatusByServerId: {},
        });
    });

    afterEach(() => {
        standardCleanup();
        resetMachinePoolSyncRuntimeForTests();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        getStorage().setState(initialStorageState, true);
    });

    it('hydrates a cold origin name through the viewer’s own credential and canonical Pool projection', async () => {
        const hook = await renderHook(() => useMachinePoolOriginName({
            serverId: boundary.serverId,
            poolId: pool.pool.id,
        }));

        await vi.waitFor(() => expect(hook.getCurrent()).toBe('Development'));
        expect(boundary.requests.filter((url) => !url.endsWith('/v1/features'))).toEqual([
            'https://session-origin-pools.test/v1/machines/pools/list',
        ]);
        await act(async () => {
            const accountId = storage.getState().machinePoolAccountIdByServerId[boundary.serverId];
            if (accountId) {
                storage.getState().removeMachinePool(pool.pool.id, { sourceServerId: boundary.serverId, sourceAccountId: accountId });
            }
        });
        expect(hook.getCurrent()).toBeNull();
        expect(boundary.requests.filter((url) => !url.endsWith('/v1/features'))).toHaveLength(1);
        await hook.unmount();
    });

    it('does not use a cached private name or fetch Pools without independently readable Home credentials', async () => {
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(null);
        storage.setState({ machinePoolListByServerId: { [boundary.serverId]: [pool] } });
        const hook = await renderHook(() => useMachinePoolOriginName({
            serverId: boundary.serverId,
            poolId: pool.pool.id,
        }));

        expect(hook.getCurrent()).toBeNull();
        expect(boundary.requests).toEqual([]);
        await hook.unmount();
    });

    it('leaves a recipient’s foreign origin unnamed after reading only their own Pool list', async () => {
        const hook = await renderHook(() => useMachinePoolOriginName({
            serverId: boundary.serverId,
            poolId: '00000000-0000-4000-8000-000000000052',
        }));
        await vi.waitFor(() => expect(boundary.requests).toContain('https://session-origin-pools.test/v1/machines/pools/list'));
        expect(hook.getCurrent()).toBeNull();
        expect(boundary.requests.filter((url) => !url.endsWith('/v1/features'))).toEqual([
            'https://session-origin-pools.test/v1/machines/pools/list',
        ]);
        await hook.unmount();
    });

    it('does not hydrate Pools for an ordinary Session without informational origin', async () => {
        const hook = await renderHook(() => useMachinePoolOriginName({
            serverId: boundary.serverId,
            poolId: null,
        }));
        expect(hook.getCurrent()).toBeNull();
        expect(boundary.requests).toEqual([]);
        await hook.unmount();
    });
});
