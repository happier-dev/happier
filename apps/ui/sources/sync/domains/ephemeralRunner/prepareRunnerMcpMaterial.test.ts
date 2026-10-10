import { afterEach, describe, expect, it } from 'vitest';
import { prepareRunnerMcpMaterial, RunnerMcpMaterializationUnavailableError } from './prepareRunnerMcpMaterial';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resetSavedSecretCatalogSnapshotsForTests, getMaterializedSavedSecrets } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

afterEach(() => { resetRuntimeFetch(); resetSavedSecretCatalogSnapshotsForTests(); });

const settings = {
    v: 1,
    strictMode: true,
    servers: [{
        id: 'server-a', name: 'server-a', transport: 'http',
        remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'savedSecret', secretId: 'secret-a' } } },
        env: {}, createdAt: 1, updatedAt: 2,
    }],
    bindings: [{ id: 'all', serverId: 'server-a', enabled: true, target: { t: 'allMachines' }, createdAt: 3, updatedAt: 4 }],
} as const;

const activeReference = 'happier:shared-secret:v1:active-key';
const activeCatalog: McpServerCatalogV1 = { v: 1, servers: [{ ...settings.servers[0], remote: {
    url: settings.servers[0].remote.url, headers: { Authorization: { t: 'savedSecret', secretId: activeReference } },
} }], bindings: [...settings.bindings] };

async function prepareAdmittedCatalog(input: Readonly<{
    catalog: McpServerCatalogV1 | null;
    selection?: SessionMcpSelectionV1;
    availableMaterial?: boolean;
    materialReadUnavailable?: boolean;
    replaceCredentialsOnMaterialRead?: boolean;
}>) {
    const home = await upsertServerProfileOnly({ serverUrl: 'https://runner-mcp-admitted.test', name: 'Admitted' });
    const accountId = 'runner-admitted-account';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token });
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: input.availableMaterial ? [{
        resourceId: 'active-key', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'active-key', mode: 'plain',
            content: { v: 1, name: 'Selected key', kind: 'token', value: 'Bearer selected-material' } }),
        entry: { ref: activeReference, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
            name: 'Selected key', kind: 'token', revision: 6, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    }] : [] });
    setRuntimeFetch(async (url, request) => {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe(new URL(home.serverUrl).origin);
        expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${token}`);
        if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
        if (parsed.pathname === '/v2/account/settings') return Response.json({ version: 7,
            content: { t: 'plain', v: { mcpServersStrictMode: true, mcpServersSettingsV1: settings } } });
        if (parsed.pathname === '/v1/account/entity-rows/mcp') return Response.json(input.catalog === null
            ? { status: 'deleted', revision: 4 }
            : { status: 'present', revision: 4, content: { t: 'plain', v: input.catalog } });
        if (parsed.pathname === '/v1/account/saved-secrets/resources/materials') {
            if (input.replaceCredentialsOnMaterialRead) {
                // Same Account id, different credential lifetime: neither a
                // ready row nor fresh material may authorize the old capture.
                await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: `${token}-replacement` });
            }
            return input.materialReadUnavailable
                ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(materials);
        }
        if (parsed.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const context = await captureLazyActionAccountContext(home.id);
    try { return await prepareRunnerMcpMaterial({ context, selection: input.selection ?? null }); }
    finally { context.dispose(); }
}

describe('prepareRunnerMcpMaterial', () => {
    it('prepares first-use material from the captured Home after catalog activation extracts strict policy', async () => {
        const focusedHome = await upsertServerProfileOnly({ serverUrl: 'https://runner-mcp-focused.test', name: 'Focused' });
        const targetHome = await upsertServerProfileOnly({ serverUrl: 'https://runner-mcp-target.test', name: 'Target' });
        const scope = { serverId: targetHome.id, accountId: 'runner-target-account' };
        const token = `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(targetHome.serverUrl, { serverId: targetHome.id }, { token });
        storage.setState({ settingsScope: { serverId: focusedHome.id, accountId: 'focused-account' },
            profileScope: { serverId: focusedHome.id, accountId: 'focused-account' },
            settings: settingsParse({ mcpServersStrictMode: false }), settingsVersion: 7 });
        const reference = 'happier:shared-secret:v1:first-use-key';
        const catalog = { ...settings, servers: [{ ...settings.servers[0],
            remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'savedSecret', secretId: reference } } } }] };
        let raw: Record<string, unknown> = { mcpServersSettingsV1: catalog, retainedOtherRoot: { keep: true } };
        let version = 7;
        let row: unknown = { status: 'absent' };
        const promptRows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [] });
        const material = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
            resourceId: 'first-use-key', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'first-use-key', mode: 'plain',
                content: { v: 1, name: 'First-use key', kind: 'token', value: 'Bearer fresh-target-material' } }),
            entry: { ref: reference, source: 'shared_resource', relationship: 'owner', ownerAccountId: scope.accountId,
                name: 'First-use key', kind: 'token', revision: 4, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] });
        const origins = new Set<string>();
        setRuntimeFetch(async (url, init) => {
            const parsed = new URL(String(url));
            origins.add(parsed.origin);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }));
            if (parsed.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    if (input.expectedVersion !== version) return Response.json({ success: false, error: 'version-mismatch',
                        currentVersion: version, currentContent: { t: 'plain', v: raw } });
                    if (input.content?.t !== 'plain') throw new Error('Expected plain Settings source');
                    raw = input.content.v;
                    version += 1;
                    return Response.json({ success: true, version });
                }
                return Response.json({ content: { t: 'plain', v: raw }, version });
            }
            if (parsed.pathname === '/v1/account/entity-rows/mcp') {
                if (init?.method === 'POST') {
                    const input = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: version });
                    expect(raw.mcpServersStrictMode).toBe(true);
                    row = { status: 'present', revision: 0, content: input.content };
                    return Response.json({ status: 'updated', revision: 0, cursor: 1 });
                }
                return Response.json(row);
            }
            if (parsed.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json(material);
            if (parsed.pathname === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 0, transferControl: { status: 'absent' }, diagnostics: [] });
            if (parsed.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (parsed.pathname === '/v1/artifacts') return Response.json([]);
            if (parsed.pathname === '/v1/account/entity-rows/prompt-library') return Response.json(promptRows);
            if (parsed.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (parsed.pathname.startsWith('/v1/account/entity-rows/')) return Response.json({ status: 'absent' });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const context = await captureLazyActionAccountContext(targetHome.id);
        try {
            // The caller's pre-admission policy must not freeze the material
            // reviewed after this same Account activates its legacy source.
            expect((await context.readSettings()).mcpServersStrictMode).toBe(false);
            expect(getMaterializedSavedSecrets(scope)).toEqual([]);
            const input = { context, selection: null };
            const prepared = await prepareRunnerMcpMaterial(input);
            expect(prepared).toMatchObject({ strictMode: true, servers: [{ serverId: 'server-a',
                savedSecretRevisions: [{ secretId: reference, revision: 4 }],
                config: { remote: { headers: { Authorization: { t: 'literal', v: 'Bearer fresh-target-material' } } } } }] });
            expect(origins).toEqual(new Set([targetHome.serverUrl]));
            expect(getMaterializedSavedSecrets(scope)).toEqual([]);
            expect(raw.retainedOtherRoot).toEqual({ keep: true });
        } finally { context.dispose(); }
    });

    it('returns the source-specific refusal for unavailable selected material', async () => {
        await expect(prepareAdmittedCatalog({ catalog: activeCatalog })).rejects.toMatchObject({
            name: 'RunnerMcpMaterializationUnavailableError',
            failure: { ok: false, reason: 'saved_secret_unavailable', serverId: 'server-a', valuePath: 'header:Authorization' },
        } satisfies Partial<RunnerMcpMaterializationUnavailableError>);
    });

    it('does not gate disabled managed selection on unavailable credential material', async () => {
        await expect(prepareAdmittedCatalog({ catalog: activeCatalog, materialReadUnavailable: true,
            selection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
        })).resolves.toBeNull();
    });

    it('materializes effective selected overrides without requiring excluded or replaced credentials', async () => {
        const excluded = { ...activeCatalog.servers[0]!, id: 'excluded-server', name: 'excluded', env: {
            UNAVAILABLE: { t: 'savedSecret' as const, secretId: 'happier:shared-secret:v1:excluded-unavailable' },
        } };
        const catalog: McpServerCatalogV1 = { v: 1, servers: [{ ...activeCatalog.servers[0]!, remote: {
            url: settings.servers[0].remote.url, headers: { Authorization: {
                t: 'savedSecret', secretId: 'happier:shared-secret:v1:replaced-unavailable' },
            },
        } }, excluded], bindings: [{ ...activeCatalog.bindings[0]!, overrides: { remote: {
            headersPatch: { Authorization: { t: 'savedSecret', secretId: activeReference } },
        } } }, { ...activeCatalog.bindings[0]!, id: 'excluded-binding', serverId: excluded.id }] };
        const prepared = await prepareAdmittedCatalog({ catalog, availableMaterial: true,
            selection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [excluded.id] },
        });
        expect(prepared?.servers).toMatchObject([{ serverId: 'server-a', savedSecretRevisions: [{ secretId: activeReference, revision: 6 }],
            config: { remote: { headers: { Authorization: { t: 'literal', v: 'Bearer selected-material' } } } } }]);
        expect(prepared?.servers).toHaveLength(1);
    });

    it('keeps a deleted catalog empty rather than executing retained Settings definitions', async () => {
        await expect(prepareAdmittedCatalog({ catalog: null, materialReadUnavailable: true })).resolves.toBeNull();
    });

    it('refuses fresh material after the initiating Account credential lifetime retires', async () => {
        await expect(prepareAdmittedCatalog({ catalog: activeCatalog, availableMaterial: true,
            replaceCredentialsOnMaterialRead: true })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    });
});
