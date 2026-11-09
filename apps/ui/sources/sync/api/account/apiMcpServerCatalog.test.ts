import { describe, expect, it } from 'vitest';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { reachRulesToDraftsV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema,
    type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

installDisconnectedServerSocketBoundary();
const { fetchMcpServerCatalogRowV1, mutateMcpServerCatalogInContext, readMcpServerCatalogInContext } = await import('./apiMcpServerCatalog');

describe('MCP row HTTP inventory boundary', () => {
    it.each(['fresh', 'empty', 'literal'] as const)('activates %s MCP source without depending on an unrelated locked catalog', async sourceKind => {
        const home = await upsertServerProfileOnly({ serverUrl: `https://mcp-source-${sourceKind}.example.test`, name: sourceKind });
        const accountId = `mcp-source-${sourceKind}`;
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token });
        const catalog: McpServerCatalogV1 = { v: 1, servers: sourceKind === 'literal' ? [{ id: 'literal-server', name: 'literal-server',
            transport: 'stdio', stdio: { command: 'echo', args: [] }, env: { MESSAGE: { t: 'literal', v: 'no credential demand' } },
            createdAt: 1, updatedAt: 1 }] : [], bindings: [] };
        const unrelatedSource = { authored: 'must survive MCP-only admission' };
        let raw: Record<string, unknown> = {
            ...(sourceKind === 'fresh' ? {} : { mcpServersSettingsV1: { ...catalog, strictMode: true } }), unrelatedSource,
        };
        let version = 7;
        let row: unknown = { status: 'absent' };
        let initialized: ReturnType<typeof McpServerCatalogRowMutationV1Schema.parse> | null = null;
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            expect(parsed.origin).toBe(new URL(home.serverUrl).origin);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }));
            if (parsed.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    if (input.expectedVersion !== version) return Response.json({ success: false, error: 'version-mismatch',
                        currentVersion: version, currentContent: { t: 'plain', v: raw } });
                    if (input.content?.t !== 'plain') throw new Error('Expected plain MCP transfer source');
                    raw = input.content.v;
                    return Response.json({ success: true, version: ++version });
                }
                return Response.json({ version, content: { t: 'plain', v: raw } });
            }
            if (parsed.pathname === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    initialized = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(initialized).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: version });
                    row = { status: 'present', revision: 0, content: initialized.content };
                    return Response.json({ status: 'updated', revision: 0, cursor: 1 });
                }
                return Response.json(row);
            }
            // This unrelated Account row is genuinely unreadable in Plain mode.
            // It cannot admit a full SavedSecret census, but the MCP source has
            // no personal reference requiring that cross-domain transaction.
            if (parsed.pathname === '/v1/account/entity-rows/acp') return Response.json({ status: 'present', revision: 9,
                content: { t: 'encrypted', c: 'retained-locked-bytes' } });
            if (parsed.pathname === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 0, transferControl: { status: 'absent' }, diagnostics: [] });
            if (parsed.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (parsed.pathname === '/v1/account/entity-rows/prompt-library') return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [] }));
            if (parsed.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            if (parsed.pathname === '/v1/artifacts') return Response.json([]);
            if (parsed.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (parsed.pathname.startsWith('/v1/account/entity-rows/')) return Response.json({ status: 'absent' });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureLazyActionAccountContext(home.id);
        try {
            expect(await readMcpServerCatalogInContext(context)).toMatchObject({ status: 'ready', authority: 'active', revision: 0, catalog });
            expect(initialized).toMatchObject({ content: { t: 'plain', v: catalog } });
            expect(raw.unrelatedSource).toEqual(unrelatedSource);
            expect(raw.mcpServersStrictMode).toBe(sourceKind === 'fresh' ? undefined : true);
        } finally { context.dispose(); resetRuntimeFetch(); }
    });

    it('returns previous reach rules only after row acknowledgement and refuses a lost CAS', async () => {
        let revision = 4;
        let catalog: McpServerCatalogV1 = { v: 1,
            servers: [{ id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'echo', args: [] },
                env: {}, createdAt: 1, updatedAt: 1 }],
            bindings: [{ id: 'binding', serverId: 'server', enabled: false, target: { t: 'allMachines' },
                createdAt: 1, updatedAt: 1 }] };
        let raceAtWrite = false;
        const account = await restoreServerAccountForTest({ serverUrl: 'https://mcp-conditional.example.test',
            accountId: 'mcp-conditional', request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
                    if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
                    const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    if (raceAtWrite) { revision += 1; raceAtWrite = false; }
                    if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision }, { status: 409 });
                    if (mutation.content?.t !== 'plain') throw new Error('Expected plain catalog');
                    catalog = mutation.content.v;
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const owner = await captureLazyActionAccountContext(account.home.id);
        try {
            const execute = createMcpServerActionExecuteV1({ readCatalog: () => readMcpServerCatalogInContext(owner),
                mutate: (change, expectedRevision) => mutateMcpServerCatalogInContext(owner, { change, expectedRevision }),
                machine: async () => { throw new Error('Unexpected Machine effect'); } });
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } satisfies ActionExecutorContext;
            const previous: ReachRulesV1 = [{ id: 'binding', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 }];
            expect(await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
                change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } }, context }))
                .toMatchObject({ ok: true, result: { ok: true, revision: 5, items: [{ serverId: 'server', previous,
                    rules: [{ id: 'binding', enabled: true }] }] } });
            expect(catalog.bindings[0]?.enabled).toBe(true);
            expect(await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
                change: { kind: 'replace', rules: reachRulesToDraftsV1(previous) } }, context }))
                .toMatchObject({ ok: true, result: { ok: true, revision: 6, items: [{ rules: [{ enabled: false }] }] } });
            expect(catalog.bindings[0]?.enabled).toBe(false);
            raceAtWrite = true;
            expect(await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }],
                change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } }, context }))
                .toEqual({ ok: true, result: { ok: false, code: 'conflict' } });
            expect(catalog.bindings[0]?.enabled).toBe(false);
        } finally { owner.dispose(); await account.dispose(); }
    });

    it('checks retained-source maintenance on a foreign Settings write from the socket copy, without a full Settings GET', async () => {
        const catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
        let settingsGets = 0;
        const account = await restoreServerAccountForTest({ serverUrl: 'https://mcp-socket-copy.example.test',
            accountId: 'mcp-socket-copy', request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 8 }));
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') {
                    if ((init?.method ?? 'GET') === 'GET') settingsGets++;
                    return Response.json({ version: 7, content: { t: 'plain', v: {} } });
                }
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: catalog } });
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { handleUpdateAccountSocketUpdate } = await import('@/sync/engine/account/syncAccount');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const owner = await captureLazyActionAccountContext(account.home.id);
        try {
            // Another device writes Settings; the socket delivers the whole new document.
            await handleUpdateAccountSocketUpdate({ accountUpdate: { settingsV2: { content: { t: 'plain', v: { analyticsOptOut: true } }, version: 8 } },
                updateCreatedAt: 1, currentProfile: { ...profileDefaults }, encryption: null,
                settingsScope: { serverId: owner.serverId, accountId: owner.accountId },
                applyProfile: () => {}, applySettings: () => {}, applySettingsForScope: () => {}, log: { log: () => {} } });
            settingsGets = 0;
            // A maintenance wake (published read) runs source maintenance to completion before returning.
            expect(await readMcpServerCatalogInContext(owner, undefined, { onReady: () => {} })).toMatchObject({ status: 'ready', authority: 'active', revision: 3 });
            expect(settingsGets).toBe(0);
        } finally { owner.dispose(); await account.dispose(); }
    });

    it('preserves canonical Account refusals returned by the row route', async () => {
        const result = await fetchMcpServerCatalogRowV1({
            request: async () => Response.json({ status: 'account-mode-mismatch' }),
        });
        expect(result).toEqual({ status: 'account-mode-mismatch' });
    });

    it('does not accept inventory on a failed request or replace authentication failure with body content', async () => {
        const content = { status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } };
        await expect(fetchMcpServerCatalogRowV1({
            request: async () => Response.json(content, { status: 400 }),
        })).rejects.toMatchObject({ code: 'unreachable' });
        await expect(fetchMcpServerCatalogRowV1({
            request: async () => Response.json({ status: 'account-mode-mismatch' }, { status: 401 }),
        })).rejects.toMatchObject({ code: 'unauthorized' });
    });
});
