import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as catalog from './apiSavedSecretCatalog';
import type { ServerFetch } from '@/sync/http/client';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

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
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    await connection?.dispose();
    connection = null;
});

describe('SavedSecret catalog captured request boundary', () => {
    it('opens the selected plain resource keylessly and refuses stale or mode-mismatched material before returning a value', async () => {
        const ref = 'happier:shared-secret:v1:ssh-password';
        let current = true;
        let wrongMode = false;
        const context = { serverId: 'home-a', accountId: 'account-a',
            credentials: { token: createAccountTokenForTests('account-a') },
            resolveAccountMode: async () => 'plain' as const,
            resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
            assertCurrent: () => { if (!current) throw Object.assign(new Error('changed'), { code: 'action_account_scope_changed' }); },
            request: (async path => {
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                return Response.json({ resources: [{ resourceId: 'ssh-password', encryptionMode: wrongMode ? 'e2ee' : 'plain',
                    recipientEnvelope: null, storedContent: { t: 'plain', v: { v: 1, name: 'SSH', kind: 'password', value: 'private-password' } },
                    entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH', kind: 'password', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] });
            }) satisfies ServerFetch,
        };
        const read = 'readSavedSecretReferenceInContext' in catalog ? catalog.readSavedSecretReferenceInContext : undefined;
        expect(typeof read).toBe('function');
        if (typeof read !== 'function') throw new Error('missing_admitted_saved_secret_reference_reader');
        await expect(read(context, ref)).resolves.toEqual({ ok: true, value: 'private-password', revision: 1 });
        wrongMode = true;
        await expect(read(context, ref)).resolves.toEqual({ ok: false, reason: 'unavailable' });
        current = false;
        await expect(read(context, ref)).resolves.toEqual({ ok: false, reason: 'changed' });
    });

    it('uses an admitted caller request without opening a second Account authority and refuses malformed metadata', async () => {
        let malformed = false;
        const request: ServerFetch = async (path) => {
            expect(path).toBe('/v1/account/saved-secrets/resources/materials');
            return Response.json(malformed ? { resources: [{ resourceId: 'invalid' }] } : { resources: [] });
        };
        const context = { serverId: 'home-a', accountId: 'account-a', request, assertCurrent: () => {} };
        const read = 'readSavedSecretCatalogInContext' in catalog ? catalog.readSavedSecretCatalogInContext : undefined;
        expect(typeof read).toBe('function');
        if (typeof read !== 'function') throw new Error('missing_captured_saved_secret_reader');
        await expect(read(context)).resolves.toEqual({ ok: true, resources: [] });
        malformed = true;
        await expect(read(context)).resolves.toMatchObject({ ok: false, failure: { kind: 'invalid' } });
    });

    describe('incumbent loaded material demand', () => {
    beforeAll(loadSyncSingletonForTests);

    it('publishes retained-source diagnostics from actual material demand while keeping current resources usable', async () => {
        const accountId = 'saved-secret-demand-account';
        const homeId = 'srv_saved_secret_demand';
        const ref = 'happier:shared-secret:v1:current';
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: homeId } } });
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        const raw = { secrets: [{ id: 'future-material', name: 'Future', kind: 'token', createdAt: 1, updatedAt: 1,
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque' } } }] };
        const writes: string[] = [];
        const resourceMutationPaths = new Set<string>(Object.values(SHARED_SAVED_SECRET_ACTION_PATHS_V1));
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://saved-secret-demand.test', serverIdentityId: homeId, accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async (rawUrl, init) => {
                const path = new URL(String(rawUrl)).pathname;
                if (init?.method === 'POST' && (resourceMutationPaths.has(path) || path === '/v2/account/settings'
                    || path === '/v1/artifacts' || path.endsWith('/mutate'))) writes.push(path);
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: raw }, version: 4 });
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                    resourceId: 'current', encryptionMode: 'plain', recipientEnvelope: null,
                    storedContent: { t: 'plain', v: { v: 1, name: 'Current', kind: 'token', value: 'current-private' } },
                    entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                        name: 'Current', kind: 'token', revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }] });
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        await refreshSavedSecretCatalog(scope);
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready',
            legacyImport: { status: 'pending', reason: 'source-uncharacterized' } });
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready',
            secret: { id: ref, encryptedValue: { _isSecretValue: true, value: 'current-private' } } });
        expect(writes).toEqual([]);
    });

    it.each(['personal', 'legacy-inference'] as const)('retries retained %s history after fresh material demand without replaying an acknowledged import', async sourceKind => {
        const accountId = 'saved-secret-history-account';
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        const secret = { id: 'old-token', name: 'Old', kind: 'token', createdAt: 1, updatedAt: 2,
            encryptedValue: { _isSecretValue: true, value: 'old-private' } };
        const inference = sourceKind === 'legacy-inference';
        let raw: Record<string, unknown> = { ...(inference ? { inferenceOpenAIKey: 'old-private', preferredLanguage: 'fr' } : { secrets: [secret] }), actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'] } }) };
        let version = 4;
        let retained: AccountSettingsStoredContentEnvelope = { t: 'plain', v: raw };
        const resources: unknown[] = [];
        const promotions: unknown[] = [];
        const historyWrites: unknown[] = [];
        let historyAttempts = 0;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://saved-secret-history.test',
            serverIdentityId: 'srv_saved_secret_history', accountId,
            credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
            request: async (rawUrl, init) => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }));
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: raw }, version });
                if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                    complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] });
                if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
                if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
                // This Account has no rows in the other reference domains. Model
                // explicit wire absence, not an unsupported HTTP boundary.
                if ((init?.method ?? 'GET') === 'GET' && [REMOTE_HOST_ROWS_ROUTE_V1,
                    NOTIFICATION_CHANNELS_ROUTE_V1,
                    MCP_SERVER_CATALOG_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
                    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(path)) {
                    return Response.json({ status: 'absent' });
                }
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources });
                if (path === '/v2/account/settings/history') return Response.json({ snapshots: [{ version: 4,
                    createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(retained).length }] });
                if (path === '/v2/account/settings/history/4') return Response.json({ version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: retained });
                if (path === '/v2/account/settings/history/4/mutate') {
                    historyAttempts++;
                    if (historyAttempts === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
                    const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init?.body)));
                    historyWrites.push(mutation);
                    if (mutation.operation.kind !== 'normalize') throw new Error('Expected canonical history normalization');
                    retained = mutation.operation.content;
                    return Response.json({ status: 'applied' });
                }
                if (path === '/v1/account/saved-secrets/resources/promote') {
                    const mutation = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init?.body)));
                    promotions.push(mutation);
                    if (mutation.nextSettings?.t !== 'plain') throw new Error('Expected Plain source mutation');
                    raw = mutation.nextSettings.v;
                    resources.push({ resourceId: mutation.resourceId, encryptionMode: 'plain', storedContent: mutation.storedContent,
                        recipientEnvelope: null, entry: { ref: `happier:shared-secret:v1:${mutation.resourceId}`, source: 'shared_resource',
                            relationship: 'owner', ownerAccountId: accountId, name: mutation.displayName, kind: mutation.kind, revision: 1,
                            materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
                    return Response.json({ resourceId: mutation.resourceId, settingsVersion: ++version });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
        await refreshSavedSecretCatalog(scope);
        expect(promotions).toHaveLength(1);
        const promotion = SharedSavedSecretPromoteInputV1Schema.parse(promotions[0]);
        expect(promotion.referenceCensus).toMatchObject({
            remoteHosts: { revision: 'absent', resourceRefs: [] },
            notificationChannels: { revision: 'absent', resourceRefs: [] },
            catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent',
                connectedConfigurations: 'absent', connectedPurposes: 'absent' },
        });
        const ref = `happier:shared-secret:v1:${promotion.resourceId}`;
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready',
            secret: { encryptedValue: { _isSecretValue: true, value: 'old-private' } } });
        if (inference) {
            expect(raw).not.toHaveProperty('inferenceOpenAIKey');
            expect(raw).toHaveProperty('preferredLanguage', 'fr');
            expect(raw).not.toHaveProperty('secretBindingsByProfileId');
            expect(promotion.profileMutations).toEqual([]);
        }
        expect(historyAttempts).toBe(1);
        expect(historyWrites).toHaveLength(0);
        // Drop process-local demand custody; retry must derive only canonical source/resource facts.
        resetSavedSecretCatalogEngineForTests();
        await refreshSavedSecretCatalog(scope);
        expect(promotions).toHaveLength(1);
        expect(historyWrites).toHaveLength(1);
        if (inference) {
            expect(retained).toMatchObject({ t: 'plain', v: { preferredLanguage: 'fr' } });
            if (retained.t !== 'plain') throw new Error('Expected Plain retained source');
            expect(retained.v).not.toHaveProperty('inferenceOpenAIKey');
            expect(historyWrites[0]).toMatchObject({ operation: { savedSecretTransfers: [{
                source: { kind: 'legacy-inference-openai-key' }, resourceId: promotion.resourceId, expectedRevision: 1,
            }] } });
        } else expect(retained).toMatchObject({ t: 'plain', v: { secrets: [] } });
    });
    });
});
