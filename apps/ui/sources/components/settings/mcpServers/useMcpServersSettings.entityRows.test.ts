import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useMcpServerCatalogForServer, useMcpServersSettings } from './useMcpServersSettings';
import { refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { resetMcpServerCatalogSnapshotsForTests } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mutateMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

let disposeActionExecutorModuleLoader: (() => void) | undefined;
beforeEach(async () => { disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader(); });

afterEach(() => {
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    disposeActionExecutorModuleLoader?.();
    disposeActionExecutorModuleLoader = undefined;
});

describe('MCP destination-backed settings hook', () => {
    it('withdraws previously plain definitions when the Account becomes E2EE without credential material', async () => {
        const accountId = 'mcp-mode-account';
        const home = await upsertServerProfileOnly({ serverUrl: 'https://mcp-mode.example.test', name: 'Mode' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        });
        const scope = { serverId: home.id, accountId };
        getStorage().setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}), settingsVersion: 7 });
        let mode: 'plain' | 'e2ee' = 'plain';
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v1/account/entity-rows/mcp') return Response.json({ status: 'present', revision: 3,
                content: { t: 'plain', v: { v: 1, servers: [{ id: 'previously-plain', name: 'plain', transport: 'stdio',
                    stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } } });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const hook = await renderHook(useMcpServersSettings);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().settings.servers[0]?.id).toBe('previously-plain'));
            await flushHookEffects();
            mode = 'e2ee';
            await act(async () => { await refreshMcpServerCatalog(scope); });
            expect(hook.getCurrent().snapshot).toMatchObject({ status: 'unavailable',
                reason: 'encryption-material-unavailable', value: null });
            expect(hook.getCurrent().settings.servers).toEqual([]);
            expect(hook.getCurrent().writable).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('reports a selected Home without credentials as unavailable rather than perpetually loading', async () => {
        const home = await upsertServerProfileOnly({ serverUrl: 'https://mcp-signed-out.example.test', name: 'Signed out' });
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        const hook = await renderHook(() => useMcpServerCatalogForServer(home.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                status: 'unavailable', reason: 'unauthorized', value: null,
            }));
        } finally { await hook.unmount(); }
    });

    it('withdraws the selected Home Account and observes replacement credentials on that same Home', async () => {
        const homeA = await upsertServerProfileOnly({ serverUrl: 'https://mcp-focused.example.test', name: 'Focused' });
        const homeB = await upsertServerProfileOnly({ serverUrl: 'https://mcp-selected.example.test', name: 'Selected' });
        for (const [home, accountId] of [[homeA, 'focused-account'], [homeB, 'selected-account']] as const) {
            await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
            });
        }
        getStorage().setState({ profileScope: { serverId: homeA.id, accountId: 'focused-account' },
            settingsScope: { serverId: homeA.id, accountId: 'focused-account' }, settings: settingsParse({}), settingsVersion: 7 });
        const rowReads: string[] = [];
        let selectedAccountId = 'selected-account';
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (parsed.pathname === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (parsed.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (parsed.pathname === '/v1/account/entity-rows/mcp') {
                expect(new Headers(init?.headers).get('Authorization')).toContain(Buffer.from(JSON.stringify({ sub: selectedAccountId })).toString('base64url'));
                rowReads.push(parsed.origin);
                return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, servers: [{
                    id: selectedAccountId === 'selected-account' ? 'selected-server' : 'replacement-server',
                    name: 'selected', transport: 'stdio', stdio: { command: 'selected-mcp', args: [] },
                    env: {}, createdAt: 1, updatedAt: 1,
                }], bindings: [] } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const hook = await renderHook(() => useMcpServerCatalogForServer(homeB.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().value?.servers.map(server => server.id)).toEqual(['selected-server']));
            expect(rowReads.length).toBeGreaterThan(0);
            expect(new Set(rowReads)).toEqual(new Set([homeB.serverUrl]));
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                status: 'unavailable', reason: 'unauthorized', value: null,
            }));
            selectedAccountId = 'replacement-account';
            await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: selectedAccountId })).toString('base64url')}.signature`,
            });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false,
                value: { servers: [{ id: 'replacement-server' }] } }));
            expect(new Set(rowReads)).toEqual(new Set([homeB.serverUrl]));
            expect(getStorage().getState().settingsScope).toEqual({ serverId: homeA.id, accountId: 'focused-account' });
        } finally { await hook.unmount(); }
    });

    it('edits the admitted catalog without advancing Account Settings or reading a stale source', async () => {
        const accountId = 'account-mcp-row';
        let revision = 3;
        const server: McpServerCatalogEntryV1 = { id: 'server-row', name: 'row', transport: 'stdio',
            stdio: { command: 'mcp-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 };
        let catalog: { v: 1; servers: McpServerCatalogEntryV1[]; bindings: McpServerBindingV1[] } = { v: 1, servers: [server], bindings: [] };
        let settingsWrites = 0;
        let rowWrites = 0;
        let maintenanceReads = 0;
        let releaseMaintenance!: () => void;
        const maintenanceReady = new Promise<void>(resolve => { releaseMaintenance = resolve; });
        const settings = settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'mcp.servers.update': ['ui'] } } });
        // HTTP is the only replaced boundary: scope, admission, encryption and publication remain real.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') settingsWrites += 1;
                else {
                    maintenanceReads += 1;
                    await maintenanceReady;
                }
                return Response.json({ version: 7, content: { t: 'plain', v: settings } });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings/history') {
                return Response.json({ snapshots: [] });
            }
            if (path === '/v1/account/entity-rows/mcp') {
                if (init?.method === 'POST') {
                    const mutation = JSON.parse(String(init.body));
                    expect(mutation.expectedRevision).toBe(revision);
                    catalog = mutation.content.v;
                    revision += 1;
                    rowWrites += 1;
                    return Response.json({ status: 'updated', revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const home = await upsertServerProfileOnly({ serverUrl: 'https://mcp-row.example.test', name: 'MCP' });
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        const scope = { serverId: home.id, accountId };
        // This domain hook consumes a qualified Account snapshot, not full Sync startup.
        getStorage().setState({ profileScope: scope, settingsScope: scope,
            settings, settingsVersion: 7 });
        const hook = await renderHook(useMcpServersSettings);
        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        let actionWrite: ReturnType<typeof mutateMcpServerCatalogInContext> | undefined;
        onTestFailed(() => {
            console.error('MCP hook HTTP boundary', { scope, rowWrites, settingsWrites, maintenanceReads,
                status: hook.getCurrent().snapshot.status, revision: hook.getCurrent().snapshot.revision });
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().settings.servers.map(row => row.id)).toEqual(['server-row']));
            const sourceReadsBeforeMutation = maintenanceReads;
            context = await captureLazyActionAccountContext(home.id);
            actionWrite = mutateMcpServerCatalogInContext(context, { expectedRevision: 3,
                change: { kind: 'server-update', entry: { ...server, title: 'Action edit' }, bindings: [] } });
            // Optional retained-source maintenance cannot postpone an admitted row CAS.
            await vi.waitFor(() => expect(rowWrites).toBe(1));
            expect(await actionWrite).toMatchObject({ status: 'updated', revision: 4 });
            expect(maintenanceReads).toBe(sourceReadsBeforeMutation);
            await hook.getCurrent().mutate('mcp.servers.update', {
                expectedRevision: hook.getCurrent().snapshot.revision,
                entry: { ...server, title: 'Edited', updatedAt: 2 }, bindings: [],
            });
            await vi.waitFor(() => expect(hook.getCurrent().settings.servers[0]?.title).toBe('Edited'));
            expect(getStorage().getState().settingsVersion).toBe(7);
            expect(settingsWrites).toBe(0);
        } finally {
            releaseMaintenance();
            await actionWrite?.catch(() => undefined);
            context?.dispose();
            await hook.unmount();
        }
    });
});
