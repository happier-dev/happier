import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolViewV1 } from '@happier-dev/protocol';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateMachinePoolProjection, observeMachinePoolProjection, resetMachinePoolProjectionForTests } from './machinePoolProjection';
import { applyPlannedChangeActions } from '@/sync/runtime/orchestration/changesApplier';
import { planSyncActionsFromChanges } from '@/sync/runtime/orchestration/changesPlanner';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const initialStorageState = getStorage().getState();
const boundary = {
    serverId: '',
    listRequests: 0,
    pendingResponses: [] as Array<(response: Response) => void>,
};

const poolView = (name: string, revision: number) => ({
    pool: {
        id: '00000000-0000-4000-8000-000000000001', name, description: null,
        revision, createdAt: 1, updatedAt: revision, members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
}) satisfies MachinePoolViewV1;

async function enableMachinePoolsFeature(serverId: string): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        features: { machines: { enabled: true, pools: { enabled: true } } },
        capabilities: {},
    })));
    await getServerFeaturesSnapshot({ serverId, force: true });
}

describe('machinePoolSyncRuntime', () => {
    beforeEach(async () => {
        retireActiveServerAccountScopeLifetime();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({ serverUrl: 'https://home-replay.test', name: 'Replay Home' })).id;
        boundary.listRequests = 0;
        boundary.pendingResponses.length = 0;
        getStorage().getState().activateProfileScope({ serverId: boundary.serverId, accountId: 'account-a' });
        getStorage().setState({ machinePoolListByServerId: {}, machinePoolListStatusByServerId: {} });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('account-a') });
        await enableMachinePoolsFeature(boundary.serverId);
        setRuntimeFetch(async (url) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            if (pathname === '/v1/machines/pools/list') {
                boundary.listRequests += 1;
                return await new Promise<Response>((resolve) => boundary.pendingResponses.push(resolve));
            }
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });
    });

    afterEach(() => {
        resetMachinePoolProjectionForTests();
        retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        vi.restoreAllMocks(); vi.unstubAllGlobals();
    });

    it('lets the focused change planner refresh Pools once while unrelated exact wakes retain their answer', async () => {
        const release = observeMachinePoolProjection(boundary.serverId);
        try {
            await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));
            boundary.pendingResponses[0]?.(Response.json({ pools: [poolView('Initial', 1)] }));
            await vi.waitFor(() => expect(getStorage().getState().machinePoolListStatusByServerId[boundary.serverId]).toBe('idle'));
            const initialPools = getStorage().getState().machinePoolListByServerId[boundary.serverId];

            const applyPage = (kind: 'session' | 'machinePool', cursor: number) => {
                const planned = planSyncActionsFromChanges([{ cursor, kind, entityId: `${kind}-a`, changedAt: cursor, hint: null }]);
                return applyPlannedChangeActions({
                    planned,
                    credentials: { token: createAccountTokenForTests('account-a') },
                    isSessionMessagesLoaded: () => false,
                    publishAccountChanges: changes => publishHomeAccountChange(boundary.serverId, changes.map(change => change.entityId)),
                    invalidate: { machinePools: () => invalidateMachinePoolProjection(boundary.serverId) },
                    invalidateMessagesForSession: async () => {},
                    invalidateScmStatusForSession: () => {},
                    applyTodoSocketUpdates: async () => {},
                    kvBulkGet: async () => ({ values: [] }),
                });
            };
            for (let cursor = 1; cursor <= 20; cursor += 1) await applyPage('session', cursor);
            expect(getStorage().getState().machinePoolListStatusByServerId[boundary.serverId]).toBe('idle');
            expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toBe(initialPools);
            expect(boundary.listRequests).toBe(1);

            const changed = applyPage('machinePool', 21);
            await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(2));
            boundary.pendingResponses[1]?.(Response.json({ pools: [poolView('Changed', 2)] }));
            expect(await changed).toMatchObject({ status: 'complete', safeAdvanceCursor: '21' });
            expect(boundary.listRequests).toBe(2);
            expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]?.[0]?.pool.name).toBe('Changed');

            publishHomeAccountChange(boundary.serverId);
            await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(3));
            boundary.pendingResponses[2]?.(Response.json({ pools: [poolView('Reconnected', 3)] }));
            await vi.waitFor(() => expect(getStorage().getState().machinePoolListStatusByServerId[boundary.serverId]).toBe('idle'));
            expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]?.[0]?.pool.name).toBe('Reconnected');

            publishHomeAccountChange(boundary.serverId, ['self']);
            await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(4));
            boundary.pendingResponses[3]?.(Response.json({ pools: [poolView('Account changed', 4)] }));
            await vi.waitFor(() => expect(getStorage().getState().machinePoolListStatusByServerId[boundary.serverId]).toBe('idle'));
            expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]?.[0]?.pool.name).toBe('Account changed');
        } finally {
            release();
        }
    });

    it('replays an invalidation received during a list request and publishes the fresh cycle', async () => {
        const first = invalidateMachinePoolProjection(boundary.serverId);
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));
        expect(boundary.listRequests).toBe(1);
        const second = invalidateMachinePoolProjection(boundary.serverId);

        boundary.pendingResponses[0]?.(Response.json({ pools: [poolView('Stale', 1)] }));
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(2));
        boundary.pendingResponses[1]?.(Response.json({ pools: [poolView('Fresh', 2)] }));

        await Promise.all([first, second]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]?.[0]?.pool.name).toBe('Fresh');
    });

    it('holds the Machine Pool change checkpoint when its HTTP refresh fails', async () => {
        setRuntimeFetch(async (url) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            if (pathname === '/v1/machines/pools/list') {
                boundary.listRequests += 1;
                return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
            }
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });
        const planned = planSyncActionsFromChanges([{
            cursor: 1,
            kind: 'machinePool',
            entityId: 'pool-a',
            changedAt: 1,
            hint: null,
        }]);

        const result = await applyPlannedChangeActions({
            planned,
            credentials: { token: createAccountTokenForTests('account-a') },
            isSessionMessagesLoaded: () => false,
            invalidate: { machinePools: () => invalidateMachinePoolProjection(boundary.serverId) },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(boundary.listRequests).toBe(1);
        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'partial-materialization',
        });
    });
});
