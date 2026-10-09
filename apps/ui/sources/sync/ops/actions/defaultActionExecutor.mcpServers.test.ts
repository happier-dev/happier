import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeBase64 } from '@/encryption/base64';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
// Native/navigation and network/credential persistence are the substituted
// boundaries. Account context, storage, catalog and Action owners remain real.
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const initialState = getStorage().getState();
afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialState, true);
    vi.restoreAllMocks();
});

describe('UI MCP Actions through captured Home persistence', () => {
    it('creates and reads on the requested Home after another Home receives focus', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const settings = { mcpServersStrictMode: true, actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'mcp.servers.create': ['ui'] } } };
        let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
        let revision = 1;
        const writes: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                return Response.json({ content: { t: 'plain', v: settings }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                if (init?.method === 'POST') {
                    const input = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input.expectedRevision).toBe(revision);
                    if (input.content?.t !== 'plain') throw new Error('Expected plain Account row');
                    catalog = input.content.v;
                    writes.push(target.pathname);
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const entry = { id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] },
            env: { TOKEN: { t: 'literal', v: 'private' } }, createdAt: 1, updatedAt: 1 } as const;
        expect(await executor.execute('mcp.servers.create', { entry, bindings: [], expectedRevision: 1 }, context))
            .toEqual({ ok: true, result: { status: 'updated', revision: 2, cursor: 2 } });
        expect(await executor.execute('mcp.servers.read', { serverId: 'server' }, context)).toMatchObject({ ok: true,
            result: { status: 'present', server: entry, revision: 2, complete: true, authority: 'active' } });
        expect(writes).toEqual(['/v1/account/entity-rows/mcp']);
    });
    it('lists an admitted catalog without awaiting retained-source maintenance', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-read-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-read-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'read-owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const maintenanceStarted = createDeferred<void>();
        const releaseMaintenance = createDeferred<void>();
        let catalogObserved = false;
        // Only captured Home HTTP is substituted. Required Account/approval
        // reads finish; the source GET after the ready row is optional cleanup.
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                if (catalogObserved) {
                    maintenanceStarted.resolve();
                    await releaseMaintenance.promise;
                }
                return Response.json({ content: { t: 'plain', v: { mcpServersStrictMode: true } }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                expect(init?.method ?? 'GET').toBe('GET');
                catalogObserved = true;
                return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: {
                    v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
                        stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [],
                } } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        let settled = false;
        const list = executor.execute('mcp.servers.list', {}, { serverId: home.id, surface: 'ui',
            authority: 'present_user', actionCaller: { kind: 'host' } }).then(result => { settled = true; return result; });
        try {
            const phase = await Promise.race([list.then(() => 'read' as const), maintenanceStarted.promise.then(() => 'maintenance' as const)]);
            // Cleanup may already be running, but its deferred response must
            // not postpone the finite read or imply cleanup has completed.
            if (phase === 'maintenance') await vi.waitFor(() => expect(settled).toBe(true));
            const result = await list;
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', authority: 'active', revision: 3,
                catalog: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', createdAt: 1, updatedAt: 1 }], bindings: [] } } });
            expect(result).not.toMatchObject({ result: { cleanup: { status: 'complete' } } });
        } finally {
            releaseMaintenance.resolve();
            await list;
        }
    });
});
