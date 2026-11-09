import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await initialNetwork.dispose();

let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | null = null;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
let syncBridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | null = null;
let runtimeLoaded = false;

async function arrangePermission() {
    vi.resetModules();
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://permission-owner.example.test', 'account-a');
    const profiles = await import('@/sync/domains/server/serverProfiles');
    await profiles.setActiveServerId(home.id, { scope: 'device' });
    syncBridge = await loadSyncSingletonForTests();
    runtimeLoaded = true;
    const connection = await import('@/sync/runtime/orchestration/connectionManager');
    await connection.restoreConnectionToActiveServer({ token: home.token });
    const { storage } = await import('@/sync/domains/state/storage');
    const session = createSessionFixture({ id: 'permission-session', serverId: home.id, active: true, thinking: true,
        agentState: { requests: { request: { tool: 'Read', arguments: {}, turnId: 'turn-a' } } },
    });
    network.setHttpResponder(async (input) => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    storage.getState().applySessions([session]);
    const { sessionRespondToPermission } = await import('./sessions');
    return { network, home, storage, session, sessionRespondToPermission };
}

afterEach(async () => {
    if (runtimeLoaded) {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
    }
    runtimeLoaded = false;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    await network?.dispose();
    network = null;
    syncBridge?.dispose();
    syncBridge = null;
    browser?.restore();
    browser = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('permission response admission through real Home and Account owners', () => {
    it.each([{ ok: false }, { ok: false, errorCode: '' }, { ok: 'true' }, {}])(
        'does not recover thinking from an invalid application acknowledgement %j', async (reply) => {
            const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
            network.setRpcResponder(async () => reply);
            const before = storage.getState().sessions[session.id];
            await expect(sessionRespondToPermission(session.id, {
                id: 'request', approved: false, decision: 'denied', turnId: 'turn-a',
            }, { serverId: home.id })).rejects.toBeInstanceOf(Error);
            expect(storage.getState().sessions[session.id]).toBe(before);
        },
    );

    it('preserves a newer same-ID turn after a delayed accepted deny', async () => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        const entered = createDeferred<void>();
        const reply = createDeferred<unknown>();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return undefined;
            entered.resolve();
            return await reply.promise;
        });
        const pending = sessionRespondToPermission(session.id, { id: 'request', approved: false, decision: 'denied' }, { serverId: home.id });
        await entered.promise;
        storage.getState().applySessions([createSessionFixture({ ...session,
            agentState: { requests: { request: { tool: 'Read', arguments: {}, turnId: 'turn-b' } } },
        })]);
        storage.getState().markSessionOptimisticThinking(session.id);
        const before = storage.getState().sessions[session.id];
        reply.resolve(undefined);
        await pending;
        expect(storage.getState().sessions[session.id]).toBe(before);
        expect(storage.getState().sessions[session.id]?.thinking).toBe(true);
    });

    it('preserves the replacement Account after a delayed accepted permission reply on the same Home', async () => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        const entered = createDeferred<void>();
        const reply = createDeferred<unknown>();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return undefined;
            entered.resolve();
            return await reply.promise;
        });
        const pending = sessionRespondToPermission(session.id, { id: 'request', approved: false, decision: 'denied' }, { serverId: home.id });
        await entered.promise;
        await network.setAccount(home.serverUrl, 'account-b');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(getActiveServerAccountScope()).toEqual({ serverId: home.id, accountId: 'account-b' });
        storage.getState().applySessions([createSessionFixture({ ...session })]);
        storage.getState().markSessionOptimisticThinking(session.id);
        const before = storage.getState().sessions[session.id];
        reply.resolve(undefined);
        await pending;
        expect(storage.getState().sessions[session.id]).toBe(before);
        expect(storage.getState().sessions[session.id]?.thinking).toBe(true);
    });
    it.each([undefined, null, { ok: true }])('retains established permission success %j', async (reply) => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        network.setRpcResponder(async () => reply);
        await expect(sessionRespondToPermission(session.id, {
            id: 'request', approved: false, decision: 'denied', turnId: 'turn-a',
        }, { serverId: home.id })).resolves.toBeUndefined();
        expect(storage.getState().sessions[session.id]?.thinking).toBe(false);
    });

    it('recovers an accepted deny after its pending request was removed', async () => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        const entered = createDeferred<void>();
        const reply = createDeferred<unknown>();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return undefined;
            entered.resolve();
            return await reply.promise;
        });
        const pending = sessionRespondToPermission(session.id, { id: 'request', approved: false, decision: 'denied' }, { serverId: home.id });
        await entered.promise;
        storage.getState().applySessions([createSessionFixture({ ...session, agentState: { requests: {} } })]);
        reply.resolve(undefined);
        await pending;
        expect(storage.getState().sessions[session.id]?.thinking).toBe(false);
    });

    it('sends the exact notification turn to its saved Account without borrowing the mounted request turn', async () => {
        const { network, storage, home, session } = await arrangePermission();
        storage.getState().applySessions([createSessionFixture({ ...session,
            agentState: { requests: { request: { tool: 'Read', arguments: {}, turnId: 'newer-turn' } } },
        })]);
        network.setRpcResponder(async () => ({ ok: false, errorCode: 'permission_request_not_found', requestId: 'request' }));
        const { sessionRespondToPermissionWithServerAccountScope } = await import('./sessions');
        const controller = new AbortController();
        const onIssued = vi.fn();
        const before = storage.getState().sessions[session.id];
        await expect(sessionRespondToPermissionWithServerAccountScope(session.id, {
            id: 'request', approved: false, decision: 'denied', turnId: 'notification-turn',
        }, { scope: { serverId: home.id, accountId: home.accountId }, networkMode: 'background-task', signal: controller.signal, onIssued }))
            .rejects.toMatchObject({ rpcErrorCode: 'permission_request_not_found' });
        const requests = network.requests.filter(request => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ serverUrl: home.serverUrl, token: home.token, targetId: session.id,
            payload: { id: 'request', approved: false, decision: 'denied', turnId: 'notification-turn' } });
        expect(onIssued).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessions[session.id]).toBe(before);
    });

    it.each(['same-turn', 'removed-request', 'newer-turn', 'account-replacement', 'home-switch'] as const)(
        'applies exact deny recovery only to the owning Account and occurrence (%s)', async (scenario) => {
            const { network, storage, home, session } = await arrangePermission();
            const entered = createDeferred<void>();
            const reply = createDeferred<unknown>();
            network.setRpcResponder(async (request) => {
                if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return undefined;
                entered.resolve();
                return await reply.promise;
            });
            const { sessionRespondToPermissionWithServerAccountScope } = await import('./sessions');
            const pending = sessionRespondToPermissionWithServerAccountScope(session.id, {
                id: 'request', approved: false, decision: 'denied', turnId: 'turn-a',
            }, { scope: { serverId: home.id, accountId: home.accountId }, networkMode: 'background-task' });
            await entered.promise;
            let currentSession = session;
            if (scenario === 'account-replacement') await network.setAccount(home.serverUrl, 'account-b');
            if (scenario === 'home-switch') {
                const other = await network.addHome('https://other-permission-owner.example.test', 'other-account');
                const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
                await setActiveServerAndSwitch({ serverId: other.id, scope: 'device' });
                currentSession = createSessionFixture({ ...session, serverId: other.id });
            }
            if (scenario === 'removed-request') currentSession = createSessionFixture({ ...session, agentState: { requests: {} } });
            if (scenario === 'newer-turn') currentSession = createSessionFixture({ ...session,
                agentState: { requests: { request: { tool: 'Read', arguments: {}, turnId: 'turn-b' } } },
            });
            storage.getState().applySessions([currentSession]);
            storage.getState().markSessionOptimisticThinking(session.id);
            const before = storage.getState().sessions[session.id];
            reply.resolve(undefined);
            await pending;
            const shouldRecover = scenario === 'same-turn' || scenario === 'removed-request';
            if (!shouldRecover) expect(storage.getState().sessions[session.id]).toBe(before);
            expect(storage.getState().sessions[session.id]?.thinking).toBe(!shouldRecover);
        },
    );
    it.each(['account-replacement', 'preferred-foreign-home', 'same-account'] as const)(
        'keeps ordinary abort recovery in its captured Home and Account (%s)', async (scenario) => {
            const { network, storage, home, session } = await arrangePermission();
            let target = home;
            if (scenario === 'preferred-foreign-home') {
                target = await network.addHome('https://foreign-abort-owner.example.test', 'foreign-account');
                storage.setState({ ordinarySessionListMembershipByServerId: {} });
                storage.getState().applySessions([createSessionFixture({ ...session, serverId: target.id })]);
            }
            const entered = createDeferred<void>();
            const reply = createDeferred<unknown>();
            network.setRpcResponder(async (request) => {
                if (request.method !== 'abort') return undefined;
                entered.resolve();
                return await reply.promise;
            });
            const { sessionAbort } = await import('./sessions');
            const pending = sessionAbort(session.id);
            await entered.promise;
            if (scenario === 'account-replacement') await network.setAccount(home.serverUrl, 'account-b');
            storage.getState().applySessions([createSessionFixture({ ...session })]);
            storage.getState().markSessionOptimisticThinking(session.id);
            const before = storage.getState().sessions[session.id];
            reply.resolve(undefined);
            await expect(pending).resolves.toBeUndefined();
            expect(network.requests.filter(request => request.method === 'abort')).toMatchObject([
                { serverUrl: target.serverUrl, token: target.token },
            ]);
            if (scenario !== 'same-account') expect(storage.getState().sessions[session.id]).toBe(before);
            expect(storage.getState().sessions[session.id]?.thinking).toBe(scenario !== 'same-account');
        },
    );
    it.each(['before-abort', 'during-abort'] as const)('keeps composed permission Stop in its original Account (%s)', async (stage) => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        const entered = createDeferred<void>();
        const reply = createDeferred<unknown>();
        network.setRpcResponder(async (request) => {
            const hold = stage === 'before-abort' ? RPC_METHODS.SESSION_PERMISSION_RESPOND : 'abort';
            if (request.method !== hold) return undefined;
            entered.resolve();
            return await reply.promise;
        });
        const pending = sessionRespondToPermission(session.id, { id: 'request', approved: false, decision: 'abort' }, { serverId: home.id })
            .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        await entered.promise;
        await network.setAccount(home.serverUrl, 'account-b');
        storage.getState().applySessions([createSessionFixture({ ...session })]);
        storage.getState().markSessionOptimisticThinking(session.id);
        const before = storage.getState().sessions[session.id];
        reply.resolve(undefined);
        await pending;
        const abortRequests = network.requests.filter(request => request.method === 'abort');
        if (stage === 'before-abort') expect(abortRequests).toHaveLength(0);
        else expect(abortRequests).toMatchObject([{ token: home.token }]);
        expect(storage.getState().sessions[session.id]).toBe(before);
        expect(storage.getState().sessions[session.id]?.thinking).toBe(true);
    });
    it.each(['accepted', 'permission-refused', 'abort-failed'] as const)('preserves the composed Stop outcome in its original Account (%s)', async (outcome) => {
        const { network, home, session, sessionRespondToPermission } = await arrangePermission();
        network.setRpcResponder(async (request) => {
            if (request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND && outcome === 'permission-refused') {
                return { ok: false, errorCode: 'permission_request_not_found', requestId: 'request' };
            }
            if (request.method === 'abort' && outcome === 'abort-failed') throw new Error('abort unavailable');
            return undefined;
        });
        const pending = sessionRespondToPermission(session.id, {
            id: 'request', approved: false, decision: 'abort', turnId: 'turn-a',
        }, { serverId: home.id });
        if (outcome === 'permission-refused') await expect(pending).rejects.toMatchObject({ rpcErrorCode: 'permission_request_not_found' });
        else if (outcome === 'abort-failed') await expect(pending).rejects.toThrow('abort unavailable');
        else await expect(pending).resolves.toBeUndefined();
        const decisions = network.requests.filter(request => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND || request.method === 'abort');
        expect(decisions.map(request => request.method)).toEqual(outcome === 'permission-refused'
            ? [RPC_METHODS.SESSION_PERMISSION_RESPOND] : [RPC_METHODS.SESSION_PERMISSION_RESPOND, 'abort']);
        expect(decisions.every(request => request.token === home.token && request.serverUrl === home.serverUrl)).toBe(true);
    });
    it('finishes composed permission Stop in its saved Account after another Home gains focus', async () => {
        const { network, storage, home, session, sessionRespondToPermission } = await arrangePermission();
        const other = await network.addHome('https://focused-permission-owner.example.test', 'other-account');
        const entered = createDeferred<void>();
        const reply = createDeferred<unknown>();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return undefined;
            entered.resolve();
            return await reply.promise;
        });
        const pending = sessionRespondToPermission(session.id, { id: 'request', approved: false, decision: 'abort' }, { serverId: home.id });
        await entered.promise;
        const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
        await setActiveServerAndSwitch({ serverId: other.id, scope: 'device' });
        storage.getState().applySessions([createSessionFixture({ ...session, serverId: other.id })]);
        storage.getState().markSessionOptimisticThinking(session.id);
        const before = storage.getState().sessions[session.id];
        reply.resolve(undefined);
        await expect(pending).resolves.toBeUndefined();
        const decisions = network.requests.filter(request => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND || request.method === 'abort');
        expect(decisions.map(request => request.method)).toEqual([RPC_METHODS.SESSION_PERMISSION_RESPOND, 'abort']);
        expect(decisions.every(request => request.serverUrl === home.serverUrl && request.token === home.token)).toBe(true);
        expect(storage.getState().sessions[session.id]).toBe(before);
        expect(storage.getState().sessions[session.id]?.thinking).toBe(true);
    });
});
