import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { type MachinePoolPrivateViewV1, type MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';


import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';


let nativeConfirmationAccepted = false;
const approvalModal = createModalModuleMock({
    spies: { confirm: async () => nativeConfirmationAccepted },
});

installApprovalCommonModuleMocks({
    modal: () => approvalModal.module,
    storage: (importOriginal) => importOriginal(),
});

const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { getStorage, storage } = await import('@/sync/domains/state/storage');
const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { settingsParse } = await import('@/sync/domains/settings/settings');

const {
    createMachinePool,
    deleteMachinePool,
    MachinePoolActionRefusedError,
    refreshMachinePools,
    updateMachinePool,
} = await import('./machinePools');

const initialStorageState = getStorage().getState();
const boundary = { serverId: '', requests: [] as string[], bodies: new Map<string, unknown[]>() };
const features = {
    features: { machines: { enabled: true, pools: { enabled: true } } },
    capabilities: {
        accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
        },
    },
};

const created = {
    pool: {
        id: '00000000-0000-4000-8000-000000000001', name: 'Development',
        description: null, revision: 0, createdAt: 1, updatedAt: 1, members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
} satisfies MachinePoolViewV1;

const createdWire = {
    pool: {
        ...created.pool,
        name: {
            kind: 'available' as const,
            label: { content: { t: 'plain' as const, v: created.pool.name }, recipientEnvelope: null },
        },
    },
    availability: created.availability,
} satisfies MachinePoolPrivateViewV1;

function setActionsSettings(actions: Record<string, unknown>): void {
    const current = storage.getState().settings ?? {};
    storage.setState({ settings: settingsParse({ ...current, actionsSettingsV1: { v: 1, actions } }) });
}

describe('machine pool Action front door', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        retireActiveServerAccountScopeLifetime();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialStorageState, true);
        boundary.serverId = (await upsertAndActivateServer({ serverUrl: 'https://pool-front-door.test', name: 'Home' })).id;
        boundary.requests.length = 0;
        boundary.bodies.clear();
        getStorage().getState().activateProfileScope({ serverId: boundary.serverId, accountId: 'alice' });
        getStorage().setState({ settingsScope: { serverId: boundary.serverId, accountId: 'alice' } });
        getStorage().setState({ machinePoolListByServerId: {}, machinePoolListStatusByServerId: {} });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: `e30.${btoa(JSON.stringify({ sub: 'alice' }))}.signature` });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
        await getServerFeaturesSnapshot({ serverId: boundary.serverId, force: true });
        nativeConfirmationAccepted = false;
        approvalModal.spies.confirm.mockClear();
        setRuntimeFetch(async (url, init) => {
            const value = String(url);
            const pathname = new URL(value).pathname;
            if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            boundary.requests.push(pathname);
            if (typeof init?.body === 'string') {
                const bodies = boundary.bodies.get(pathname) ?? [];
                bodies.push(JSON.parse(init.body));
                boundary.bodies.set(pathname, bodies);
            }
            if (pathname === '/v1/account/private-labels/recipient-census') {
                return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
            }
            if (pathname === '/v1/machines/pools/list') return Response.json({ pools: [createdWire] });
            if (pathname === '/v1/machines/pools/create') return Response.json(createdWire);
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });
    });

    afterEach(() => {
        retireActiveServerAccountScopeLifetime();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        invalidateAccountEncryptionModeCache();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('carries an enabled Pool intent through the shared executor to the canonical Home route', async () => {
        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .resolves.toMatchObject({ pool: { id: created.pool.id } });

        // The Action-automation index read belongs to completion-trigger matching, not to Pools.
        expect(boundary.requests.filter(path => path !== '/v1/automations/actions/index')).toEqual([
            '/v1/account/private-labels/recipient-census',
            '/v1/machines/pools/create',
        ]);
        expect(boundary.bodies.get('/v1/machines/pools/create')).toEqual([
            expect.objectContaining({
                name: { content: { t: 'plain', v: 'Development' }, recipients: [] },
                description: null,
            }),
        ]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toEqual([created]);
    });

    it('seals an update without an audience against the current Team Pool audience', async () => {
        const teamId = 'team-pool-audience';
        const teamPool = {
            ...createdWire,
            pool: { ...createdWire.pool, audience: { kind: 'team' as const, teamId } },
        } satisfies MachinePoolPrivateViewV1;
        setRuntimeFetch(async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            boundary.requests.push(pathname);
            if (typeof init?.body === 'string') {
                const bodies = boundary.bodies.get(pathname) ?? [];
                bodies.push(JSON.parse(init.body));
                boundary.bodies.set(pathname, bodies);
            }
            if (pathname === '/v1/machines/pools/get') return Response.json(teamPool);
            if (pathname === '/v1/account/private-labels/recipient-census') {
                return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
            }
            if (pathname === '/v1/machines/pools/update') return Response.json(teamPool);
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });

        await expect(updateMachinePool(boundary.serverId, {
            poolId: created.pool.id,
            expectedRevision: created.pool.revision,
            name: 'Team Development',
            members: [],
        })).resolves.toMatchObject({ pool: { id: created.pool.id } });

        expect(boundary.requests).toEqual([
            '/v1/machines/pools/get',
            '/v1/account/private-labels/recipient-census',
            '/v1/machines/pools/update',
        ]);
        expect(boundary.bodies.get('/v1/account/private-labels/recipient-census')).toEqual([
            { owner: { kind: 'team', teamId } },
        ]);
        expect(boundary.bodies.get('/v1/machines/pools/update')).toEqual([
            expect.objectContaining({ audience: { kind: 'team', teamId } }),
        ]);
    });

    it('refuses a Pool intent the shared Action settings disable, without reaching the Home', async () => {
        setActionsSettings({ 'machines.pools.create': { enabled: false } });

        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .rejects.toBeInstanceOf(MachinePoolActionRefusedError);

        expect(boundary.requests).toEqual([]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toBeUndefined();
    });

    it('keeps the projection refresh on the same front door', async () => {
        await expect(refreshMachinePools(boundary.serverId)).resolves.toEqual([created]);

        expect(boundary.requests).toEqual(['/v1/machines/pools/list']);
    });

    it('keeps a new Pool uncreated when the person cancels its in-flow Create confirmation', async () => {
        setActionsSettings({ 'machines.pools.create': { approvalRequiredSurfaces: ['ui'] } });

        await expect(createMachinePool(boundary.serverId, { name: 'Development', description: null, members: [] }))
            .rejects.toBeInstanceOf(MachinePoolActionRefusedError);

        // Labels are sealed at the effect, after confirmation: a cancelled create prepares nothing.
        expect(boundary.requests).toEqual([]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toBeUndefined();
    });

    it('keeps a Pool listed when the person cancels its in-flow Delete confirmation', async () => {
        getStorage().getState().beginMachinePoolAccountScope(boundary.serverId, 'alice');
        getStorage().getState().replaceMachinePools([created], {
            sourceServerId: boundary.serverId,
            sourceAccountId: 'alice',
        });
        setActionsSettings({ 'machines.pools.delete': { approvalRequiredSurfaces: ['ui'] } });

        await expect(deleteMachinePool(boundary.serverId, { poolId: created.pool.id, expectedRevision: created.pool.revision }))
            .rejects.toBeInstanceOf(MachinePoolActionRefusedError);

        expect(boundary.requests).toEqual([]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.serverId]).toEqual([created]);
    });
    it.each(['create', 'delete'] as const)('routes accepted native %s confirmation to Home B while Home A remains focused', async (operation) => {
        const homeA = boundary.serverId;
        const homeB = (await upsertAndActivateServer({ serverUrl: 'https://pool-background.test', name: 'Background' })).id;
        // Re-activate Home A before exercising the deferred replay: the test requires
        // Home A to remain the focused Home while the approval replays against Home B.
        await upsertAndActivateServer({ serverUrl: 'https://pool-front-door.test', name: 'Home' });
        const token = (accountId: string) => `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature`;
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (url) => ({
            token: token(url === 'https://pool-background.test' ? 'bob' : 'alice'),
        }));
        getStorage().setState({ settingsScope: { serverId: homeA, accountId: 'alice' } });
        setActionsSettings({ [`machines.pools.${operation}`]: { enabled: false } });
        const effects: string[] = [];
        const requests: Array<{ host: string; authorization: string | null }> = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            const pathname = target.pathname;
            if (pathname === '/v1/features') return Response.json(features);
            if (pathname === '/v1/auth/ping' || pathname === '/health') return Response.json({ ok: true });
            requests.push({ host: target.host, authorization: new Headers(init?.headers).get('authorization') });
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [`machines.pools.${operation}`]: { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (pathname === `/v1/machines/pools/${operation}`) {
                effects.push(pathname);
                return Response.json(operation === 'create' ? createdWire : { poolId: created.pool.id, deleted: true });
            }
            if (pathname === '/v1/account/private-labels/recipient-census') {
                return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
            }
            return Response.json({}, { status: 404 });
        });
        await getServerFeaturesSnapshot({ serverId: homeB, force: true });
        nativeConfirmationAccepted = true;
        const result = await (operation === 'create'
            ? createMachinePool(homeB, { name: 'Development', description: null, members: [] })
            : deleteMachinePool(homeB, { poolId: created.pool.id, expectedRevision: 0 }));
        if (operation === 'create') expect(result).toMatchObject({ pool: { id: created.pool.id } });
        expect(effects).toEqual([`/v1/machines/pools/${operation}`]);
        expect(approvalModal.spies.confirm).toHaveBeenCalledOnce();
        expect(requests.every((request) => request.host === 'pool-background.test' && request.authorization === `Bearer ${token('bob')}`)).toBe(true);
    });

});
