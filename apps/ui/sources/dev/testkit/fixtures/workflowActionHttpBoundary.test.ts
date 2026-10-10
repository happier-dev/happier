import { afterEach, expect, it } from 'vitest';
import { installWorkflowActionHttpBoundary } from './workflowActionHttpBoundary';
import { initializeRealAppRuntimeForTests } from '../harness/realAppRuntimeHarness';

let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
afterEach(async () => { await boundary?.dispose(); boundary = null; });

it('owns genuine Workflow Home custody, replaces its focused Account and refuses traffic after teardown', async () => {
    await initializeRealAppRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-boundary-custody.test' });
    let accountId = 'account-a';
    boundary = await installWorkflowActionHttpBoundary({
        accountId: () => accountId,
        fixtureResponse: async () => ({ ok: true, result: { definitions: [] } }),
    });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
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
