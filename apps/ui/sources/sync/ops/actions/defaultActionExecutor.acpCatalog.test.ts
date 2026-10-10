import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowMutationV1Schema, type AcpCatalogRowMutationV1,
    type AcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getStorage } from '@/sync/domains/state/storage';

installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const initialState = getStorage().getState();
afterEach(() => {
    resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests(); retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); resetServerFeaturesClientForTests(); vi.restoreAllMocks();
    getStorage().setState(initialState, true);
});

describe('captured UI ACP Agent Actions', () => {
    it('refuses the original captured draft revision before any mutation even though a newer row is ready', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://acp-action-stale-draft.test', scope: 'tab' });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const backend = { id: 'row-review', name: 'row-review', title: 'Other writer title', command: 'review', createdAt: 1, updatedAt: 1 };
        let content: AcpCatalogContentV1 = { t: 'plain', v: { v: 1, definitions: [backend] } };
        let revision = 1;
        let posts = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    posts += 1;
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
                    content = mutation.content;
                    revision += 1;
                    return Response.json({ status: 'updated', revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content });
            }
            return new Response(null, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('agents.acp.backends.upsert', {
            backend: { ...backend, title: 'Stale authored title' }, expectedRevision: 0,
        }, { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
            .toMatchObject({ ok: false, errorCode: 'acp_catalog_conflict', details: { revision: 1 } });
        expect(posts).toBe(0);
        expect(content).toMatchObject({ t: 'plain', v: { definitions: [expect.objectContaining({ title: 'Other writer title' })] } });
    });
    it('lists, upserts and deletes only destination rows on the invoked Home, retaining Account preferences', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://acp-action-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-acp-action-home.test', scope: 'tab' });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let revision: number | 'absent' = 'absent';
        let content: AcpCatalogContentV1 | undefined;
        const mutations: AcpCatalogRowMutationV1[] = [];
        const targetKey = 'backend:row-review:configured:row-review';
        const settings = { futurePreference: { preserve: true }, backendEnabledByTargetKey: { [targetKey]: true } };
        getStorage().setState({ settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: { [targetKey]: false } } });
        const mountedSettings = getStorage().getState().settings;
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method).not.toBe('POST');
                return Response.json({ version: 7, content: { t: 'plain', v: settings } });
            }
            if (target.pathname === '/v1/artifacts') return Response.json([]);
            if (target.pathname === ACP_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(mutation.expectedRevision).toBe(revision);
                    mutations.push(mutation);
                    content = mutation.content;
                    revision = revision === 'absent' ? 1 : revision + 1;
                    return Response.json({ status: 'updated', revision, cursor: revision });
                }
                return Response.json(content ? { status: 'present', revision, content } : { status: 'absent' });
            }
            return new Response(null, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const backend = { id: 'row-review', name: 'row-review', title: 'Row review', command: 'review', createdAt: 1, updatedAt: 1 };
        const upsert = await executor.execute('agents.acp.backends.upsert', { backend }, context);
        if (!upsert.ok) throw new Error(JSON.stringify(upsert));
        expect(mutations[0]).toMatchObject({ expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 7 });
        const inventory = await executor.execute('agents.backends.list', { includeDisabled: false }, context);
        if (!inventory.ok) throw new Error(JSON.stringify(inventory));
        expect(inventory).toMatchObject({ ok: true,
            result: { items: expect.arrayContaining([expect.objectContaining({ backendId: 'row-review', label: 'Row review', enabled: true })]) } });
        expect(await executor.execute('agents.acp.backends.get', { backendId: 'row-review' }, context)).toMatchObject({ ok: true,
            result: { backend: expect.objectContaining(backend), revision: 1 } });
        expect(await executor.execute('agents.acp.backends.delete', { backendId: 'row-review' }, context)).toMatchObject({ ok: true });
        expect(content).toMatchObject({ t: 'plain', v: { v: 1, definitions: [] } });
        expect(mutations).toHaveLength(2);
        expect(settings).toEqual({ futurePreference: { preserve: true }, backendEnabledByTargetKey: { [targetKey]: true } });
        expect(getStorage().getState().settings).toBe(mountedSettings);
    });
});
