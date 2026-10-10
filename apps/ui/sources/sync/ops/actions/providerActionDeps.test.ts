import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema,
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    sealProviderConnectionsContentV1, openProviderConnectionsContentV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const machineTransport = vi.hoisted(() => vi.fn(async () => {
    throw new Error('Account source visibility must never dispatch Machine RPC');
}));
// Only the genuine Machine transport is substituted; Action admission and row operations stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineTransport,
}));

const account = createProviderSettingsAccountHarness();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    standardCleanup();
    await account.reset();
    machineTransport.mockClear();
});

function catalogFixture() {
    return ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: ['a', 'b'].map(id => ({
            v: 1, id: `pc_${id}`, source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
            role: 'named', displayName: `Connection ${id}`, displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1,
        })),
        modelPickerVisibilityByConnectionId: { pc_b: false },
        manualModelsByConnectionId: { pc_a: [{ id: 'model-a', name: 'Model A', addedAt: 1 }] },
    });
}

async function executeSourceVisibility(serverId: string, accountId: string, shown: boolean | null) {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
    return createDefaultActionExecutor().execute('providers.models.source_visibility.set', {
        action: 'setConnectionVisibility', connectionId: 'pc_a', shown,
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId, expectedAccountId: accountId });
}

describe('Provider Account source visibility Action', () => {
    it('admits retained Account source on first direct describe without a mounted reader or machine', async () => {
        const retained = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog: retained, settings: {
            providerSettingsV1: { ...retained, defaultsByAgentTargetKey: {} },
        } });
        let admitted: typeof retained | null = null;
        let revision = 0;
        let rowWrites = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: admitted ? { status: 'present', revision, content: { t: 'plain', v: admitted } }
                : { status: 'absent' } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe('absent');
                expect(mutation.sourceSettingsVersion).toEqual(expect.any(Number));
                if (mutation.content?.t !== 'plain') throw new Error('Expected a retained Plain Account transfer');
                admitted = mutation.content.v;
                revision += 1;
                rowWrites += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: accountId };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(await executor.execute('providers.connections.describe', { connectionId: 'pc_a' }, context))
                .toMatchObject({ ok: true, result: { connections: [{ connectionId: 'pc_a', authorized: false }] } });
        }
        expect(admitted).toMatchObject({ connections: retained.connections,
            manualModelsByConnectionId: retained.manualModelsByConnectionId });
        expect(rowWrites).toBe(1);
        expect(machineTransport).not.toHaveBeenCalled();
    });
    it.each(['plain', 'e2ee'] as const)('creates, renames, manages manual models and deletes a custom %s Account connection without a machine', async mode => {
        let catalog = catalogFixture();
        const secret = new Uint8Array(32).fill(29);
        const material = mode === 'e2ee' ? { type: 'legacy' as const, secret } : null;
        const { serverId, accountId } = await account.restore({ catalog, waivedActions: [
            'providers.connections.create_custom', 'providers.connections.update', 'providers.connections.delete',
        ], ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}) });
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: sealProviderConnectionsContentV1({ mode, material, catalog }) } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                expect(mutation.content?.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
                const opened = openProviderConnectionsContentV1({ mode, material, content: mutation.content });
                if (opened.status !== 'opened') throw new Error(`Expected mode-consistent Account mutation: ${opened.status}`);
                catalog = opened.catalog;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: accountId };
        const created = await executor.execute('providers.connections.create_custom', {
            action: 'createCustom', connectionId: 'pc_account', savedSecretId: null, enable: false,
            template: { v: 1, name: 'Account source', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat',
                baseUrl: 'https://example.com/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
                    statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' } }, manualModels: [],
        }, context);
        expect(created).toMatchObject({ ok: true, result: { status: 'success', action: 'createCustom' } });
        const connection = catalog.connections.find(entry => entry.id === 'pc_account')!;
        expect(await executor.execute('providers.connections.update', { action: 'update', connectionId: connection.id,
            expectedRevision: connection.revision, displayName: 'Renamed', displayNameMode: 'custom' }, context))
            .toMatchObject({ ok: true, result: { status: 'success' } });
        const renamed = catalog.connections.find(entry => entry.id === connection.id)!;
        expect(renamed.displayName).toBe('Renamed');
        expect(await executor.execute('providers.models.manual.add', { action: 'manualAdd', connectionId: renamed.id,
            expectedConnectionRevision: renamed.revision,
            models: [{ id: 'manual-account' }] }, context)).toMatchObject({ ok: true, result: { status: 'success' } });
        expect(catalog.manualModelsByConnectionId[renamed.id]?.map(model => model.id)).toEqual(['manual-account']);
        expect(await executor.execute('providers.connections.describe', { connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { connections: [{ displayName: 'Renamed', authorized: false }] } });
        expect(await executor.execute('providers.models.list', { connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { models: [{ id: 'manual-account', source: 'manual', loadState: 'unknown' }] } });
        expect(await executor.execute('providers.connections.delete', { action: 'delete', connectionId: renamed.id }, context))
            .toMatchObject({ ok: true, result: { status: 'success', deletedConnectionId: renamed.id } });
        expect(catalog.connections.some(entry => entry.id === renamed.id)).toBe(false);
        expect(catalog.manualModelsByConnectionId[renamed.id]).toBeUndefined();
        expect(machineTransport).not.toHaveBeenCalled();
    });
    it('hides, shows and resets one source through captured Account row CAS without Settings or Machine writes', async () => {
        let catalog = catalogFixture();
        const original = catalog;
        const { serverId, accountId } = await account.restore({ catalog });
        let revision = 1;
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                expect(mutation.referencedSavedSecretIds).toEqual([]);
                expect(mutation.savedSecretRevisions).toEqual([]);
                expect(mutation.content?.t).toBe('plain');
                if (mutation.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account write');
                catalog = mutation.content.v;
                rowWrites += 1;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_settings_write' } }; },
        });

        for (const shown of [false, true, null]) {
            expect(await executeSourceVisibility(serverId, accountId, shown)).toEqual({
                ok: true, result: { status: 'updated' },
            });
            expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_b: false,
                ...(shown === null ? {} : { pc_a: shown }) });
            expect(catalog.connections).toEqual(original.connections);
            expect(catalog.manualModelsByConnectionId).toEqual(original.manualModelsByConnectionId);
            expect(catalog.accountGrants).toEqual(original.accountGrants);
            expect(catalog.secretBindingsByConnectionId).toEqual(original.secretBindingsByConnectionId);
        }
        expect(rowWrites).toBe(3);
        expect(settingsWrites).toBe(0);
        expect(machineTransport).not.toHaveBeenCalled();
    });

    it('returns a row CAS refusal without reporting updated or replaying the source toggle', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                expect(ProviderConnectionsRowMutationV1Schema.parse(input).expectedRevision).toBe(1);
                rowWrites += 1;
                return { status: 409, body: { status: 'conflict', revision: 2 } };
            },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, details: { status: 'conflict', revision: 2 },
        });
        expect(rowWrites).toBe(1);
        expect(machineTransport).not.toHaveBeenCalled();
    });

    it('refuses an incomplete catalog before dispatching any visibility write', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: {
                ...catalog, retainedUnknown: { savedSecretId: formatSharedSavedSecretRefV1('unknown-resource') },
            } } },
        });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_visibility_write' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, details: { status: 'partial' },
        });
        expect(rowWrites).toBe(0);
        expect(machineTransport).not.toHaveBeenCalled();
    });

    it('preserves an unknown post-dispatch outcome without reporting updated or replaying the write', async () => {
        let catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog });
        let rowWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(1);
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account mutation');
                // This server may commit before its response is lost; only the writer owns
                // the uncertain receipt, and the Action must not replay or call it success.
                catalog = mutation.content.v;
                rowWrites += 1;
                return { dispatchThenFail: true };
            },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_catalog_outcome_unknown',
        });
        expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_a: false, pc_b: false });
        expect(rowWrites).toBe(1);
        expect(machineTransport).not.toHaveBeenCalled();
    });

    it('refuses an absent destination without initializing an empty catalog or retiring its source', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog, settings: {
            providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} },
        } });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: { status: 'absent' } });
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_initialization' } }; },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_source_retirement' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_catalog_unavailable',
            details: { status: 'unavailable', reason: 'authority-not-confirmed' },
        });
        expect(rowWrites).toBe(0);
        expect(settingsWrites).toBe(0);
        expect(machineTransport).not.toHaveBeenCalled();
    });

    it('refuses a deleted destination as an unknown connection without reseeding retained source', async () => {
        const catalog = catalogFixture();
        const { serverId, accountId } = await account.restore({ catalog, settings: {
            providerSettingsV1: { ...catalog, defaultsByAgentTargetKey: {} },
        } });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'deleted', revision: 4 },
        });
        let rowWrites = 0;
        let settingsWrites = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => { rowWrites += 1; return { status: 500, body: { error: 'unexpected_reseed' } }; },
        });
        account.home.answer(serverId, 'POST /v2/account/settings', {
            select: () => { settingsWrites += 1; return { status: 500, body: { error: 'unexpected_source_retirement' } }; },
        });
        expect(await executeSourceVisibility(serverId, accountId, false)).toMatchObject({
            ok: false, errorCode: 'provider_connection_not_found',
        });
        expect(rowWrites).toBe(0);
        expect(settingsWrites).toBe(0);
        expect(machineTransport).not.toHaveBeenCalled();
    });
});
