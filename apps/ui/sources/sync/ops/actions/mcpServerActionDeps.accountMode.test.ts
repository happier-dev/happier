import { afterEach, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// The daemon RPC is the boundary; Account context, catalog and Action owners stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(async () => { throw new Error('daemon_unavailable'); }),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
await loadSyncSingletonForTests();
const { observeMcpServerCatalog, refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    await connection?.dispose();
    connection = null;
});

// P03 R3: a read-only MCP Action on a connected Home borrows the held Account observation.
it('lists MCP servers on a connected Home without an Account mode HTTP read', async () => {
    const accountId = 'mcp-mode-read-account';
    const reads = new Map<string, number>();
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://mcp-mode-read.test', serverIdentityId: 'srv_mcp_mode_read', accountId,
        credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary,
        request: async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            reads.set(path, (reads.get(path) ?? 0) + 1);
            if (path === '/health') return Response.json({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 7 });
            if (path === '/v1/account/entity-rows/mcp') return Response.json({ status: 'present', revision: 3,
                content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'stdio',
                    stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] } } });
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
    const release = observeMcpServerCatalog(scope);
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        await refreshMcpServerCatalog(scope);
        const modePaths = ['/v1/account/encryption/currentness', '/v1/account/encryption'];
        const counts = () => modePaths.map(path => reads.get(path) ?? 0);
        const before = counts();
        const result = await createUiMcpServerActionExecuteV1(account)({ actionId: 'mcp.servers.list', input: {},
            context: { serverId: connection.home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
        expect(result).toMatchObject({ ok: true, result: { catalog: { servers: [{ id: 'server' }] } } });
        expect(counts().map((count, index) => count - before[index]!)).toEqual([0, 0]);
    } finally {
        account.dispose();
        release();
    }
});
