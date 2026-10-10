import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getStorage } from '@/sync/domains/state/storage';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { removeProviderMachineStateV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema,
    splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { resetProviderCatalogEngineForTests } from '@/sync/engine/settings/providerCatalogEngine';
import { machineRevokeFromAccount, machineRevokeWithProviderCleanup, machineReplaceInAccount,
    machineClearReplacementFromAccount } from './machineAccount';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
const revokedSecretRef = formatSharedSavedSecretRefV1('secret-a');
const keptSecretRef = formatSharedSavedSecretRefV1('secret-b');
afterEach(async () => {
    resetProviderCatalogEngineForTests();
    resetProviderCatalogSnapshotsForTests();
    await disposeHome?.();
    disposeHome = undefined;
});

function providerFixture() {
    return splitProviderSettingsV1(ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
            v: 1, id: 'pc_a', source: { kind: 'custom', template: {
                v: 1, name: 'Local', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat',
                    baseUrl: 'http://127.0.0.1:1234/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
                        statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' },
            } }, role: 'named', displayName: 'Local', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            endpointOverridesByMachineId: {
                revoked: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/v1' }],
                kept: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:2234/v1' }],
            },
        }],
        machineGrants: ['revoked', 'kept'].map(machineId => ({ v: 1, machineId, connectionId: 'pc_a',
            endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 })),
        secretBindingsByConnectionId: { pc_a: { byMachineId: {
            revoked: { apiKey: revokedSecretRef }, kept: { apiKey: keptSecretRef },
        } } },
        manualModelsByConnectionId: { pc_a: [{ id: 'kept/model', addedAt: 1 }] },
    })).catalog;
}

async function serveMachineAccount() {
    const accountId = 'machine-revoke-account';
    const state = {
        revision: 1, catalog: providerFixture(), content: undefined as unknown,
        revoked: false, revokeFailure: undefined as { status: number; error: string } | undefined,
        writeBehavior: 'updated' as 'updated' | 'conflict' | 'unknown',
        secretUsable: true,
        settingsWrites: 0, mutations: [] as ReturnType<typeof ProviderConnectionsRowMutationV1Schema.parse>[],
        requests: [] as Array<{ path: string; method: string; body: unknown }>,
        onRevoke: undefined as (() => Promise<void>) | undefined,
    };
    const restored = await restoreServerAccountForTest({
        serverUrl: 'https://machine-revoke.example.test', accountId,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const method = init?.method ?? 'GET';
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            state.requests.push({ path, method, body });
            if (path === '/health') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') {
                if (method === 'POST') state.settingsWrites += 1;
                return Response.json({ version: 7, content: { t: 'plain', v: {
                    providerDefaultModelSelectionsByAgentTargetKeyV1: {}, unrelated: 'preserved',
                } } });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (path.startsWith(`${AUTHORING_MEMORY_ROUTE_V1}/`) && method === 'GET') return Response.json({ status: 'absent' });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                resourceId: 'secret-b', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: state.secretUsable
                    ? { t: 'plain', v: { v: 1, name: 'Kept', kind: 'apiKey', value: 'test-credential' } } : null,
                entry: { ref: keptSecretRef, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId, name: 'Kept', kind: 'apiKey',
                    encryptionMode: 'plain', revision: 8, materialStatus: state.secretUsable ? 'ready' : 'access_removed',
                    capabilities: { use: state.secretUsable, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                if (method === 'POST') {
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
                    state.mutations.push(mutation);
                    if (state.writeBehavior === 'conflict') return Response.json({ status: 'conflict', revision: state.revision + 1 });
                    if (mutation.expectedRevision !== state.revision) return Response.json({ status: 'conflict', revision: state.revision });
                    if (mutation.content?.t === 'plain') state.catalog = mutation.content.v;
                    state.revision += 1;
                    if (state.writeBehavior === 'unknown') throw new TypeError('disconnected after commit');
                    return Response.json({ status: 'updated', revision: state.revision, cursor: state.revision });
                }
                return Response.json({ status: 'present', revision: state.revision,
                    content: state.content ?? { t: 'plain', v: state.catalog } });
            }
            if (path === '/v1/machines/revoked/revoke') {
                if (state.revokeFailure) return Response.json({ error: state.revokeFailure.error }, { status: state.revokeFailure.status });
                await state.onRevoke?.();
                if (state.revoked) return Response.json({ error: 'machine_revoked' }, { status: 410 });
                state.revoked = true;
                return Response.json({});
            }
            if (path.endsWith('/replacement')) return Response.json({});
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    disposeHome = restored.dispose;
    const scope = { serverId: restored.home.id, accountId };
    getStorage().setState({ profileScope: scope, settingsScope: scope, settingsVersion: 7 });
    return { state, scope };
}

function cleanup(scope: ServerAccountScope | null) {
    return machineRevokeWithProviderCleanup('revoked', scope);
}

describe('machine Account operations through captured HTTP', () => {
    it('removes only revoked Machine state through Provider row CAS with retained SavedSecret revision, without Settings writes', async () => {
        const { state, scope } = await serveMachineAccount();
        const result = await cleanup(scope);
        expect(result).toEqual({ ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete' });
        expect(state.catalog.machineGrants.map(grant => grant.machineId)).toEqual(['kept']);
        expect(state.catalog.connections[0]?.endpointOverridesByMachineId).toEqual({
            kept: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:2234/v1' }],
        });
        expect(state.catalog.secretBindingsByConnectionId.pc_a?.byMachineId).toEqual({ kept: { apiKey: keptSecretRef } });
        expect(state.catalog.manualModelsByConnectionId.pc_a).toEqual([{ id: 'kept/model', addedAt: 1 }]);
        expect(state.mutations).toHaveLength(1);
        expect(state.mutations[0]).toMatchObject({ expectedRevision: 1, referencedSavedSecretIds: [keptSecretRef],
            savedSecretRevisions: [{ resourceId: 'secret-b', expectedRevision: 8 }] });
        expect(state.settingsWrites).toBe(0);
        expect(getStorage().getState().settingsVersion).toBe(7);
    });

    it('refuses revoke for a retired rendered Account and does not clean up after a rejected revoke', async () => {
        const { state, scope } = await serveMachineAccount();
        await expect(cleanup({ ...scope, accountId: 'other-account' })).resolves.toMatchObject({
            ok: false, status: 409, error: 'account_settings_scope_changed',
        });
        expect(state.requests.filter(request => request.path.endsWith('/revoke'))).toEqual([]);
        state.revokeFailure = { status: 403, error: 'forbidden' };
        await expect(cleanup(scope)).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' });
        expect(state.mutations).toEqual([]);
        expect(state.settingsWrites).toBe(0);
    });

    it('leaves a conflicting winner unchanged and retries from its current row after an already-revoked receipt', async () => {
        const { state, scope } = await serveMachineAccount();
        state.writeBehavior = 'conflict';
        await expect(cleanup(scope)).resolves.toMatchObject({ ok: false, machineRevoked: true,
            providerCleanup: 'pending', retryable: true });
        expect(state.catalog.machineGrants.map(grant => grant.machineId)).toEqual(['revoked', 'kept']);
        expect(state.mutations).toHaveLength(1);
        state.catalog = { ...state.catalog, manualModelsByConnectionId: { pc_a: [{ id: 'concurrent/model', addedAt: 9 }] } };
        state.revision = 2;
        state.writeBehavior = 'updated';
        await expect(cleanup(scope)).resolves.toEqual({ ok: true, machineAlreadyRevoked: true, providerCleanup: 'complete' });
        expect(state.catalog.manualModelsByConnectionId.pc_a).toEqual([{ id: 'concurrent/model', addedAt: 9 }]);
        expect(state.mutations.at(-1)?.expectedRevision).toBe(2);
        expect(state.settingsWrites).toBe(0);
    });

    it('does not replay a disconnected post-commit write and verifies the cleaned row on explicit retry', async () => {
        const { state, scope } = await serveMachineAccount();
        state.writeBehavior = 'unknown';
        await expect(cleanup(scope)).resolves.toMatchObject({ ok: false, machineRevoked: true, providerCleanup: 'pending' });
        expect(state.mutations).toHaveLength(1);
        expect(state.catalog.machineGrants.map(grant => grant.machineId)).toEqual(['kept']);
        await expect(cleanup(scope)).resolves.toEqual({ ok: true, machineAlreadyRevoked: true, providerCleanup: 'not_needed' });
        expect(state.mutations).toHaveLength(1);
    });

    it.each([
        { v: 99, connections: [{ id: 'pc_future', future: true }] },
        { ...providerFixture(), machineGrants: 'malformed' },
    ])('preserves an incomplete or unsupported Provider row before any cleanup write', async catalog => {
        const { state, scope } = await serveMachineAccount();
        const content = { t: 'plain', v: catalog };
        state.content = content;
        await expect(cleanup(scope)).resolves.toMatchObject({ ok: false, machineRevoked: true,
            error: 'provider_settings_unreadable', providerCleanup: 'pending', retryable: false });
        expect(state.content).toBe(content);
        expect(state.mutations).toEqual([]);
        expect(state.settingsWrites).toBe(0);
    });

    it('stops captured cleanup when the Account retires after revoke', async () => {
        const { state, scope } = await serveMachineAccount();
        state.onRevoke = disconnectActiveServerConnection;
        await expect(cleanup(scope)).resolves.toMatchObject({ ok: false, machineRevoked: true,
            providerCleanup: 'pending', retryable: true });
        expect(state.mutations).toEqual([]);
    });

    it('leaves cleanup pending when a retained SavedSecret cannot be admitted', async () => {
        const { state, scope } = await serveMachineAccount();
        state.secretUsable = false;
        await expect(cleanup(scope)).resolves.toMatchObject({ ok: false, machineRevoked: true, providerCleanup: 'pending' });
        expect(state.catalog.machineGrants.map(grant => grant.machineId)).toEqual(['revoked', 'kept']);
        expect(state.mutations).toEqual([]);
        expect(state.settingsWrites).toBe(0);
    });

    it('reports an authoritative no-op without rewriting a catalog or Settings', async () => {
        const { state, scope } = await serveMachineAccount();
        state.catalog = splitProviderSettingsV1(removeProviderMachineStateV1({ ...state.catalog, defaultsByAgentTargetKey: {} }, 'revoked')).catalog;
        await expect(cleanup(scope)).resolves.toEqual({ ok: true, machineAlreadyRevoked: false, providerCleanup: 'not_needed' });
        expect(state.mutations).toEqual([]);
        expect(state.settingsWrites).toBe(0);
    });

    it('keeps replacement and revoke endpoint results structured', async () => {
        const { state } = await serveMachineAccount();
        await expect(machineRevokeFromAccount('revoked')).resolves.toEqual({ ok: true });
        await expect(machineRevokeFromAccount('revoked')).resolves.toEqual({ ok: false, status: 410, error: 'machine_revoked' });
        await expect(machineReplaceInAccount({ oldMachineId: 'old', replacementMachineId: 'new', confirmActiveOldMachine: true }))
            .resolves.toEqual({ ok: true });
        expect(state.requests.find(request => request.path === '/v1/machines/old/replacement')).toMatchObject({
            method: 'POST', body: { replacementMachineId: 'new', confirmActiveOldMachine: true },
        });
        await expect(machineClearReplacementFromAccount('old')).resolves.toEqual({ ok: true });
        expect(state.requests.at(-1)).toMatchObject({ path: '/v1/machines/old/replacement', method: 'DELETE' });
        await expect(machineReplaceInAccount({ oldMachineId: 'old', replacementMachineId: ' ' }))
            .resolves.toEqual({ ok: false, status: 400, error: 'replacement_machine_id_required' });
    });
});
