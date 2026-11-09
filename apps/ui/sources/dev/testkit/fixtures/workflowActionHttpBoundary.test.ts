import { afterEach, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { installWorkflowActionHttpBoundary } from './workflowActionHttpBoundary';
import { initializeRealAppRuntimeForTests } from '../harness/realAppRuntimeHarness';

// Resolve the app graph before measuring the Account lifecycle exercised below.
await initializeRealAppRuntimeForTests();

let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
afterEach(async () => { await boundary?.dispose(); boundary = null; });

it('owns genuine Workflow Home custody, replaces its focused Account and refuses traffic after teardown', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-boundary-custody.test' });
    let accountId = 'account-a';
    boundary = await installWorkflowActionHttpBoundary({
        accountId: () => accountId,
        fixtureResponse: async () => ({ ok: true, result: { definitions: [] } }),
    });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { fetchPushTokens, fetchPushTokensRemoteAlertProjection } = await import('@/sync/api/session/apiPush');
    expect(await fetchPushTokens(boundary.credentials, { request: apiSocket.request.bind(apiSocket) })).toEqual([]);
    expect(await fetchPushTokensRemoteAlertProjection(boundary.credentials, apiSocket.request.bind(apiSocket))).toEqual({
        v: 2, accountRemoteAlerts: { settingsVersion: 1, status: 'disabled' }, tokens: [],
    });
    const upgrades = await apiSocket.request('/v2/sessions/metadata-upgrades', { method: 'GET' });
    expect(upgrades.status).toBe(200);
    expect(await upgrades.json()).toEqual({ sessionIds: [] });
    const feed = await apiSocket.request('/v1/feed?limit=100', { method: 'GET' });
    expect(feed.status).toBe(200);
    expect(await feed.json()).toEqual({ items: [], hasMore: false });
    // The fixture advertises cursor 0. A real resume must consume its empty changes page,
    // not treat an unsupported route as a reason for a late full-snapshot wake.
    const changes = await apiSocket.request('/v2/changes?after=0&limit=500', { method: 'GET' });
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({ changes: [], nextCursor: 0 });
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const wakes: Array<string | undefined> = [];
    const stop = subscribeHomeAccountChange(event => wakes.push(event.source), { serverIds: [boundary.serverId] });
    try {
        await sync.resumeSync('server-reachable');
        expect(wakes).not.toContain('snapshot');
    } finally { stop(); }
    for (const method of ['GET', 'POST']) {
        const missing = await apiSocket.request('/v1/unsupported-fixture-route', { method });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'Not found', path: '/v1/unsupported-fixture-route', method });
    }
    expect(storage.getState().endpointStatus).toBe('online');
    const { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: boundary.serverId, accountId });
    const captured = captureActiveServerAccountScopeLifetime();
    accountId = 'account-b';
    await boundary.refreshAccount();
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: boundary.serverId, accountId });
    const response = await boundary.request(`${boundary.serverUrl}/v1/account/profile`, {
        headers: { authorization: `Bearer ${boundary.credentials.token}` },
    });
    expect(await response.json()).toMatchObject({ id: accountId });
    const replacement = captureActiveServerAccountScopeLifetime();
    await boundary.dispose();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    expect(await TokenStorage.getCredentialsForServerUrl(boundary.serverUrl, { serverId: boundary.serverId })).toBeNull();
    await expect(boundary.request(`${boundary.serverUrl}/health`)).rejects.toThrow();
});
