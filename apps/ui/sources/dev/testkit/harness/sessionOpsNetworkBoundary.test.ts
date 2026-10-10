import { afterEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { installSessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';

let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | null = null;
afterEach(async () => {
    await network?.dispose();
    network = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    serverScopedRpcSocketPool.resetForTests();
});

it('keeps the scoped RPC owner real above the saved-Home HTTP and Socket ports', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-network.test', 'account-a');
    network.setRpcResponder(async request => ({ accepted: request.payload }));
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    await expect(machineRpcWithServerScope({
        serverId: home.id, machineId: 'machine-a', method: 'fixture-operation',
        payload: { value: 'captured' }, preferScoped: true,
    })).resolves.toEqual({ accepted: { value: 'captured' } });
    expect(network.requests).toMatchObject([{
        serverUrl: home.serverUrl, token: home.token, targetId: 'machine-a',
        method: 'fixture-operation', payload: { value: 'captured' },
    }]);
});

it('reports an unconfigured RPC as the real typed remote method-not-found failure', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-missing-method.test', 'account-a');
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    await expect(machineRpcWithServerScope({
        serverId: home.id, machineId: 'machine-a', method: 'missing-fixture-operation',
        payload: {}, preferScoped: true,
    })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
});

it('reinstalls the captured HTTP and credential ports when a reused fixture resets requests', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-reset.test', 'account-a');
    const { runtimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const original = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    expect(original).toEqual({ token: home.token });
    resetRuntimeFetch();
    network.resetRequests();
    const response = await runtimeFetch(home.serverUrl + '/health');
    expect(response.status).toBe(200);
    expect(network.httpRequests).toHaveLength(1);
    // Account restoration composes the same captured HTTP port, not another Home fixture.
    expect((await network.request(home.serverUrl + '/health')).status).toBe(200);
    expect(network.httpRequests).toHaveLength(2);
    await network.setAccount(home.serverUrl, 'account-b');
    const replacement = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    expect(replacement?.token).not.toBe(home.token);
});

it('publishes saved-Home custody through the real credential store and rolls it back on disposal', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-real-custody.test', 'account-a');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // Retire observation so this keeper reads the actual device store without a spy.
    if (vi.isMockFunction(TokenStorage.getCredentialsForServerUrl)) TokenStorage.getCredentialsForServerUrl.mockRestore();
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token: home.token });
    await network.dispose();
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
});
