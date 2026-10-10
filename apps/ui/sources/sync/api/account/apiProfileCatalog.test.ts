import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { readProfileCatalog, readProfileCatalogInContext, readProfileCatalogProjection, readProfileCatalogProjectionInContext, withProfileAccount, prepareProfileRecordMutationsInContext, writeProfileRecord } from './apiProfileCatalog';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import * as savedSecretCatalogApi from './apiSavedSecretCatalog';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferMutationV1Schema, type ProfileTransferRowReadResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProfileRowMutationV1Schema, type ProfileRowMutationV1, PROFILE_RECORDS_ROUTE_V1, PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PROFILE_REFERENCE_GUARD_ROUTE_V1, buildProfilePhysicalKey } from '@happier-dev/protocol/profiles/profileRecordV1';
import { observeProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { planSyncActionsFromChanges, plannedChangesAffectProfileCatalog } from '@/sync/runtime/orchestration/changesPlanner';
import { deleteSavedSecretResource, promotePersonalSavedSecretResource } from '@/sync/ops/settings/savedSecretResourceOperations';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createDeferred } from '@/dev/testkit';
import { refreshProfileCatalog, invalidateProfileCatalogProjection } from '@/sync/engine/settings/profileCatalogEngine';

installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const http = vi.fn<RuntimeFetch>();
let scope: { serverId: string; accountId: string };
let secretResources: unknown[];
let sourceRaw: Readonly<Record<string, unknown>>;
let guardRevision: number;
let profileArtifact: Artifact | null;
function readAbsentReferenceCatalogFixture(path: string, init?: RequestInit): Response | undefined {
    // These Accounts store no rows in the other reference domains. Explicit wire
    // absence lets the real census readers distinguish that fact from unsupported HTTP.
    if ((init?.method ?? 'GET') !== 'GET') return;
    if ([REMOTE_HOST_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1, MCP_SERVER_CATALOG_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1,
        PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
        `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(path)) {
        return Response.json({ status: 'absent' });
    }
}
function credentialsFor(name: string): AuthCredentials {
    return { token: `e30.${Buffer.from(JSON.stringify({ sub: `account-${name}` })).toString('base64url')}.signature` };
}
async function activateHome(name: string) {
    await disconnectActiveServerConnection();
    const profile = await upsertAndActivateServer({ serverUrl: `https://profile-home-${name}.example.test`, name });
    const next = { serverId: profile.id, accountId: `account-${name}` };
    const credentials = credentialsFor(name);
    await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id }, credentials);
    await restoreConnectionToActiveServer(credentials);
    getStorage().setState({ profileScope: next, settingsScope: next });
    return next;
}
const page = { status: 'listed', rows: [{ id: 'p', revision: 2, content: { t: 'plain', v: {
    v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {},
} } }], nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } };
beforeEach(async () => {
    retireActiveServerAccountScopeLifetime();
    http.mockReset();
    secretResources = [];
    sourceRaw = {};
    guardRevision = 3;
    profileArtifact = null;
    http.mockResolvedValue(Response.json(page));
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: sourceRaw } });
        if (path === '/v1/artifacts') return Response.json([]);
        if (path === '/v1/artifacts/a' && profileArtifact) return Response.json(profileArtifact);
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: guardRevision });
        if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: secretResources });
        const referenceCatalog = readAbsentReferenceCatalogFixture(path, init);
        if (referenceCatalog) return referenceCatalog;
        // A configured HTTP payload may be reused across requests; each actual
        // response still has its own body, including canonical rereads.
        if (path === '/v1/account/entity-rows/profiles') return (await http(url, init)).clone();
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    scope = await activateHome('a');
});
afterEach(async () => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    await disconnectActiveServerConnection();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
});
describe('Profile catalog captured Account transport', () => {
    it('publishes active destination Profiles before history cleanup without borrowing retired maintenance', async () => {
        const history = createDeferred<Response>();
        const replacementHistory = createDeferred<Response>();
        let historyPending = false;
        let historyReads = 0;
        let revision = 2;
        const active: ProfileTransferRowReadResponseV1 = { status: 'present', revision: 1, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 4, migratedLogicalRevision: 4, inventory: [],
        } } };
        const profile = AIBackendProfileSchema.parse({ id: 'p', name: 'Current Profile', createdAt: 1, updatedAt: 2 });
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json(active);
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ ...page, transferControl: active,
                rows: [{ id: 'p', revision, content: { t: 'plain', v: { ...page.rows[0].content.v,
                    definition: { kind: 'legacy', profile: { ...profile, name: `Revision ${revision}` } } } } }] });
            if (path === '/v2/account/settings/history') {
                historyPending = true;
                historyReads += 1;
                if (historyReads === 1) return history.promise;
                if (historyReads === 2) return replacementHistory.promise;
                return Response.json({ snapshots: [] });
            }
            return new Response(null, { status: 404 });
        });
        const pending = refreshProfileCatalog(scope);
        try {
            await vi.waitFor(() => expect(historyPending).toBe(true));
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ stale: false, source: 'destination',
                catalog: { status: 'ready', records: [{ revision: 2, record: { definition: { profile: { name: 'Revision 2' } } } }] } });
            revision = 3;
            const refreshed = invalidateProfileCatalogProjection(scope);
            expect(getProfileCatalogSnapshot(scope)?.stale).toBe(true);
            await refreshed;
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ stale: false,
                catalog: { status: 'ready', records: [{ revision: 3 }] } });
            expect(historyReads).toBe(1);
            // The same target key after reconnect is a new captured Account lifetime.
            // It must own cleanup, not borrow the old request's pending maintenance.
            scope = await activateHome('a');
            revision = 4;
            await refreshProfileCatalog(scope);
            await vi.waitFor(() => expect(historyReads).toBe(2));
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ stale: false,
                catalog: { status: 'ready', records: [{ revision: 4 }] } });
            history.resolve(Response.json({ snapshots: [] }));
            replacementHistory.resolve(Response.json({ snapshots: [] }));
            await vi.waitFor(() => expect(getProfileCatalogSnapshot(scope)).toMatchObject({ stale: false,
                cleanup: { status: 'complete' }, catalog: { status: 'ready', records: [{ revision: 4 }] } }));
        } finally {
            history.resolve(Response.json({ snapshots: [] }));
            replacementHistory.resolve(Response.json({ snapshots: [] }));
            await pending;
        }
    });
    it('keeps already-valid shared material available when an uncharacterized legacy material source remains pending', async () => {
        sourceRaw = { secrets: [{ id: 'future-material', name: 'Future', kind: 'token', createdAt: 1, updatedAt: 1,
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque' } } }] };
        const source = sourceRaw;
        http.mockImplementation(async () => Response.json({ ...page, rows: [] }));
        secretResources = [{ resourceId: 'already-ready', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Current', kind: 'token', value: 'current-private' } },
            entry: { ref: 'happier:shared-secret:v1:already-ready', source: 'shared_resource', relationship: 'owner',
                name: 'Current', kind: 'token', revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }];
        await refreshSavedSecretCatalog(scope);
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready',
            materializedSecrets: [{ id: 'happier:shared-secret:v1:already-ready', encryptedValue: { value: 'current-private' } }] });
        expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport)
            .toMatchObject({ status: 'pending', reason: 'source-uncharacterized' });
        expect(sourceRaw).toBe(source);
    });
    it('selects composite import only from captured legacy source and keeps fresh native inactive control on update', async () => {
        const otherPersonal = '00000000-0000-4000-8000-000000000001';
        const profile = AIBackendProfileSchema.parse({ id: 'p', name: 'Staged', createdAt: 1, updatedAt: 2 });
        const record = { ...page.rows[0].content.v, definition: { kind: 'legacy' as const, profile },
            secretBindings: { OTHER: otherPersonal } };
        sourceRaw = { profiles: [profile], secretBindingsByProfileId: { p: { OTHER: otherPersonal } } };
        http.mockResolvedValue(Response.json({ ...page, rows: [{ id: 'p', revision: 2, content: { t: 'plain', v: record } }] }));
        const prepare = () => withProfileAccount(scope, undefined, async context => {
            const catalog = await readProfileCatalogInContext(context, undefined, { readSourceBaseline: true });
            if (catalog.status !== 'ready') throw new Error(`fixture_catalog_${catalog.status}`);
            const source = catalog.source;
            const input = { catalog, records: [{ revision: 2, record: { ...record,
                secretBindings: { ...(source === 'legacy' ? { OTHER: otherPersonal } : {}), TOKEN: 'happier:shared-secret:v1:new' } } }],
                expectedMode: 'plain' as const, savedSecretRevisions: [{ resourceId: 'new', expectedRevision: 1 }] };
            return prepareProfileRecordMutationsInContext(context, input);
        });
        await expect(prepare()).resolves.toMatchObject([{ operation: 'import', expectedRevision: 2,
            referencedSavedSecretIds: [otherPersonal, 'happier:shared-secret:v1:new'],
            savedSecretRevisions: [{ resourceId: 'new', expectedRevision: 1 }] }]);
        sourceRaw = {};
        await expect(prepare()).resolves.toMatchObject([{ operation: 'update', expectedRevision: 2 }]);
    });
    it('retains an unknown promotion outcome when only the deterministic resource is visible and the source rewrite is not proven', async () => {
        const secret = { id: 'legacy-token', name: 'Legacy token', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'fixture-private' }, createdAt: 1, updatedAt: 2 };
        sourceRaw = { secrets: [secret], secretBindingsByProfileId: { p: { TOKEN: secret.id } } };
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: secret.id } });
        let dispatched = false;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: sourceRaw } });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ ...page, rows: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: dispatched ? [{
                resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: secret.name, kind: secret.kind, value: 'fixture-private' } },
                entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner',
                    name: secret.name, kind: secret.kind, revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] : [] });
            if (path === '/v1/account/saved-secrets/resources/promote' && init?.method === 'POST') {
                dispatched = true;
                throw new Error('fixture_response_lost');
            }
            const referenceCatalog = readAbsentReferenceCatalogFixture(path, init);
            if (referenceCatalog) return referenceCatalog;
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await expect(promotePersonalSavedSecretResource({ scope, expectedSettingsVersion: 4, secret,
            accountGrants: [], teamGrants: [], groupGrants: [] })).resolves.toEqual({ ok: false, reason: 'outcome_unknown' });
        expect(dispatched).toBe(true);
        expect(sourceRaw.secrets).toEqual([secret]);
        expect(sourceRaw.secretBindingsByProfileId).toEqual({ p: { TOKEN: secret.id } });
    });
    it.each(['plain', 'e2ee'] as const)('imports a legacy SavedSecret at the actual material demand owner in %s without replaying an already committed source', async mode => {
        const material = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) } : null;
        const secret = { id: 'legacy-token', name: 'Legacy token', kind: 'token',
            encryptedValue: material ? { _isSecretValue: true,
                encryptedValue: encryptSecretStringV1('fixture-private', deriveSettingsSecretsKeySetV1(material).writeKey,
                    length => new Uint8Array(length).fill(12)) }
                : { _isSecretValue: true, value: 'fixture-private' }, createdAt: 1, updatedAt: 2 };
        sourceRaw = { secrets: [secret], secretBindingsByProfileId: { 'builtin-default': { TOKEN: secret.id } },
            futureSibling: { preserve: true } };
        let version = 4;
        const contentKeyFingerprint = material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
        const rawEnvelope = () => mode === 'plain' ? { t: 'plain', v: sourceRaw } : { t: 'encrypted',
            c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: sourceRaw,
                randomBytes: length => new Uint8Array(length).fill(11) }) };
        const committed: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption/currentness') return Response.json({
                ...createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: version }), mode, contentKeyFingerprint,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' },
            });
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 0 });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') return Response.json({ version, content: rawEnvelope() });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ ...page, rows: [] });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: secretResources });
            if (path === '/v1/account/saved-secrets/resources/promote' && init?.method === 'POST') {
                const mutation = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init.body)));
                expect(mutation.expectedSettingsVersion).toBe(version);
                expect(mutation.referenceCensus).toMatchObject({ accountMode: mode, profileTransferRevision: 'absent',
                    profiles: { referenceGuardRevision: 3, rows: [] }, remoteHosts: { revision: 'absent', resourceRefs: [] },
                    catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent',
                        connectedConfigurations: 'absent', connectedPurposes: 'absent' } });
                expect(mutation.profileMutations).toEqual([]);
                if (mutation.nextSettings?.t === 'plain') sourceRaw = mutation.nextSettings.v;
                else if (mutation.nextSettings?.t === 'encrypted') sourceRaw = AccountSettingsPersistedObjectSchema.parse(
                    openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: mutation.nextSettings.c })?.value);
                else throw new Error('fixture_requires_settings');
                committed.push(mutation);
                const envelope = mutation.keyEnvelopes?.[0];
                secretResources.push({ resourceId: mutation.resourceId, encryptionMode: mode,
                    storedContent: mutation.storedContent, recipientEnvelope: envelope ? {
                        encryptedDataKey: envelope.encryptedDataKey,
                        recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
                    } : null,
                    entry: { ref: `happier:shared-secret:v1:${mutation.resourceId}`, source: 'shared_resource', relationship: 'owner',
                        name: secret.name, kind: secret.kind, revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
                return Response.json({ resourceId: mutation.resourceId, settingsVersion: ++version });
            }
            const referenceCatalog = readAbsentReferenceCatalogFixture(path, init);
            if (referenceCatalog) return referenceCatalog;
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        if (material) {
            await disconnectActiveServerConnection();
            const credentials: AuthCredentials = { ...credentialsFor('a'), secret: Buffer.from(material.secret).toString('base64url') };
            await TokenStorage.setCredentialsForServerUrl('https://profile-home-a.example.test', { serverId: scope.serverId }, credentials);
            await restoreConnectionToActiveServer(credentials);
            getStorage().setState({ profileScope: scope, settingsScope: scope });
        }
        await refreshSavedSecretCatalog(scope);
        const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: secret.id } });
        const resourceRef = `happier:shared-secret:v1:${resourceId}`;
        expect(committed).toHaveLength(1);
        expect(sourceRaw).toMatchObject({ secrets: [], secretBindingsByProfileId: { 'builtin-default': { TOKEN: resourceRef } },
            futureSibling: { preserve: true } });
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready',
            materializedSecrets: [{ id: resourceRef, encryptedValue: { value: 'fixture-private' } }] });
        await refreshSavedSecretCatalog(scope);
        expect(committed).toHaveLength(1);
    });
    it('requires promotion before sealing explicit credential literals while allowing public values and resource-bound templates', async () => {
        const writes: ProfileRowMutationV1[] = [];
        secretResources = [{ resourceId: 'bound', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Bound', kind: 'token', value: 'fixture' } },
            entry: { ref: 'happier:shared-secret:v1:bound', source: 'shared_resource', relationship: 'owner',
                name: 'Bound', kind: 'token', revision: 2, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: secretResources });
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json(page);
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
            if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
                writes.push(ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body))));
                return Response.json({ status: 'updated', revision: 3, cursor: 4, referenceGuardRevision: 4 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const profile = AIBackendProfileSchema.parse({ id: 'p', name: 'Credential', createdAt: 1, updatedAt: 2,
            environmentVariables: [{ name: 'TOKEN', value: 'fixture-literal', isSecret: true }] });
        const record = { ...page.rows[0].content.v, definition: { kind: 'legacy' as const, profile }, secretBindings: {} };
        await expect(writeProfileRecord(scope, { record, expectedRevision: 2, operation: 'update' }))
            .rejects.toMatchObject({ code: 'profile-secret-promotion-required' });
        const requiredRecord = { ...record, definition: { kind: 'legacy' as const, profile: AIBackendProfileSchema.parse({
            ...profile, environmentVariables: [{ name: 'TOKEN', value: 'fixture-literal', isSecret: false }],
            envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }],
        }) } };
        await expect(writeProfileRecord(scope, { record: requiredRecord, expectedRevision: 2, operation: 'update' }))
            .rejects.toMatchObject({ code: 'profile-secret-promotion-required' });
        expect(writes).toEqual([]);
        await expect(withProfileAccount(scope, undefined, async context => {
            const catalog = await readProfileCatalogInContext(context, undefined, { readSourceBaseline: true });
            if (catalog.status !== 'ready') throw new Error(`fixture_catalog_${catalog.status}`);
            return prepareProfileRecordMutationsInContext(context, { catalog, records: [{ record, revision: 2 }], expectedMode: 'plain' });
        }))
            .rejects.toMatchObject({ code: 'profile-secret-promotion-required' });
        const publicRecord = { ...record, definition: { kind: 'legacy' as const, profile: { ...profile,
            environmentVariables: [{ name: 'TEAM_FLAG', value: 'public-value', isSecret: false }] } } };
        await expect(writeProfileRecord(scope, { record: publicRecord, expectedRevision: 2, operation: 'update' }))
            .resolves.toMatchObject({ status: 'updated' });
        const boundRecord = { ...record, definition: { kind: 'legacy' as const, profile: { ...profile,
            environmentVariables: [{ name: 'TOKEN', value: '${TOKEN}', isSecret: true }] } },
            secretBindings: { TOKEN: 'happier:shared-secret:v1:bound' } };
        await expect(writeProfileRecord(scope, { record: boundRecord, expectedRevision: 2, operation: 'update' }))
            .resolves.toMatchObject({ status: 'updated' });
        expect(writes).toHaveLength(2);
        await expect(withProfileAccount(scope, undefined, async context => {
            const catalog = await readProfileCatalogInContext(context, undefined, { readSourceBaseline: true });
            if (catalog.status !== 'ready') throw new Error(`fixture_catalog_${catalog.status}`);
            return prepareProfileRecordMutationsInContext(context, { catalog, records: [{ record: boundRecord, revision: 2 }], expectedMode: 'plain' });
        }))
            .resolves.toMatchObject([{ savedSecretRevisions: [{ resourceId: 'bound', expectedRevision: 2 }] }]);
    });
    it('refetches a demanded Profile catalog on the incumbent Account row wake without advancing Settings or loading a sibling Home', async () => {
        const release = observeProfileCatalog(scope);
        try {
            await vi.waitFor(() => expect(getProfileCatalogSnapshot(scope)?.catalog.status).toBe('ready'));
            const settingsVersion = getStorage().getState().settingsVersion;
            const old = getProfileCatalogSnapshot(scope)!;
            guardRevision = 4;
            http.mockResolvedValue(Response.json({ ...page, referenceGuardRevision: 4,
                rows: [{ ...page.rows[0], revision: 3 }] }));
            const profileChange = { cursor: 1, kind: 'account' as const, entityId: buildProfilePhysicalKey('p'),
                changedAt: 1, hint: { profiles: true } };
            publishHomeAccountChange(scope.serverId, [profileChange.entityId], {
                profileCatalogAffects: plannedChangesAffectProfileCatalog(planSyncActionsFromChanges([profileChange])),
            });
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ catalog: { status: 'loading' }, data: old.data });
            await vi.waitFor(() => expect(getProfileCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready',
                referenceGuardRevision: 4, records: [{ revision: 3 }] }));
            const unchanged = getProfileCatalogSnapshot(scope);
            const sessionChange = { cursor: 2, kind: 'session' as const, entityId: 'unrelated-session', changedAt: 2, hint: null };
            publishHomeAccountChange(scope.serverId, [sessionChange.entityId], {
                profileCatalogAffects: plannedChangesAffectProfileCatalog(planSyncActionsFromChanges([sessionChange])),
            });
            expect(getProfileCatalogSnapshot(scope)).toBe(unchanged);
            expect(getProfileCatalogSnapshot(scope)?.catalog.status).toBe('ready');
            expect(getStorage().getState().settingsVersion).toBe(settingsVersion);
            expect(getProfileCatalogSnapshot({ serverId: 'unobserved-home', accountId: scope.accountId })).toBeNull();
        } finally { release(); }
    });
    it('selects native rows for a fresh Account without manufacturing transfer control', async () => {
        const projection = await readProfileCatalogProjection(scope);
        expect(projection.catalog.status).toBe('ready');
        expect(projection).toMatchObject({ source: 'destination' });
        expect(projection.catalog).toMatchObject({ authority: 'inactive', control: null,
            records: [{ record: { id: 'p' } }] });
        expect(http.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    });
    it('projects genuine inactive predecessor rows for repair without dropping inline credentials', async () => {
        sourceRaw = { profiles: [{ id: 'legacy', name: 'Legacy', environmentVariables: [
            { name: 'TOKEN', value: 'fixture-inline', isSecret: true }], defaultEnabled: false, createdAt: 1, updatedAt: 2 }] };
        http.mockResolvedValue(Response.json({ ...page, rows: [] }));
        const projection = await readProfileCatalogProjection(scope);
        expect(projection.catalog.status).toBe('ready');
        expect(projection).toMatchObject({ source: 'legacy', legacyProfiles: [{ id: 'legacy', enabled: false,
            environmentVariables: [{ name: 'TOKEN', value: 'fixture-inline', isSecret: true }] }] });
    });
    it('refuses an old empty row census when activation and source cleanup overtake the captured baseline read', async () => {
        let activated = false;
        const active: ProfileTransferRowReadResponseV1 = { status: 'present', revision: 1, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 4, migratedLogicalRevision: 4,
            inventory: [{ kind: 'account_row', id: 'legacy', revision: 0 }],
        } } };
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') { activated = true; return Response.json({ version: 5, content: { t: 'plain', v: {} } }); }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json(activated ? active : { status: 'absent' });
            if (path === '/v1/account/entity-rows/profiles') return Response.json({ ...page, rows: [], transferControl: { status: 'absent' } });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        await expect(readProfileCatalogProjection(scope)).resolves.toMatchObject({ source: null,
            catalog: { status: 'unavailable', reason: 'reference-conflict' } });
    });
    it('activates a genuine eligible predecessor through the captured transfer carrier then reloads native rows', async () => {
        sourceRaw = { futureSibling: { keep: true }, profiles: [{ id: 'legacy', name: 'Legacy', environmentVariables: [],
            defaultEnabled: false, createdAt: 1, updatedAt: 2 }] };
        let transfer: ProfileTransferRowReadResponseV1 = { status: 'absent' };
        let rows: ProfileRowV1[] = [];
        const posted: string[] = [];
        let allowCleanup = false;
        let sourceVersion = 4;
        let historyRead = false;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json({ ...createPlainAccountEncryptionCurrentnessFixture(), settingsVersion: sourceVersion });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST' && allowCleanup) {
                    const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    expect(mutation.expectedProfileTransferRevision).toBe(transfer.status === 'present' ? transfer.revision : 'absent');
                    expect(mutation.expectedVersion).toBe(sourceVersion);
                    if (mutation.content?.t !== 'plain') throw new Error('fixture_requires_plain');
                    sourceRaw = mutation.content.v;
                    return Response.json({ success: true, version: ++sourceVersion });
                }
                return Response.json({ version: sourceVersion, content: { t: 'plain', v: sourceRaw } });
            }
            if (path === '/v2/account/settings/history') { historyRead = true; return Response.json({ snapshots: [] }); }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) {
                if (init?.method !== 'POST') return Response.json(transfer);
                const mutation = ProfileTransferMutationV1Schema.parse(JSON.parse(String(init.body)));
                posted.push(mutation.operation);
                if (mutation.operation === 'prepare') rows = mutation.imports.map(row => ({ id: row.id, revision: 0, content: row.content }));
                const revision = transfer.status === 'present' ? transfer.revision + 1 : 0;
                transfer = { status: 'present', revision, content: mutation.content };
                return Response.json({ status: 'updated', revision, cursor: revision });
            }
            if (path === '/v1/account/entity-rows/profiles') return Response.json({ ...page, rows, transferControl: transfer });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const projection = await readProfileCatalogProjection(scope);
        expect(projection).toMatchObject({ source: 'destination', catalog: { status: 'ready', source: 'destination',
            authority: 'active', records: [{ record: { id: 'legacy', enabled: false } }] } });
        expect(posted).toEqual(['prepare', 'activate']);
        expect(projection).toMatchObject({ cleanup: { status: 'cleanup-pending' } });
        allowCleanup = true;
        const resumed = await readProfileCatalogProjection(scope);
        expect(resumed).toMatchObject({ source: 'destination', cleanup: { status: 'complete' } });
        expect(sourceRaw).toEqual({ futureSibling: { keep: true } });
        expect(historyRead).toBe(true);
        expect(posted).toEqual(['prepare', 'activate']);
    });
    it('merges a composite newly created Resource proof with fresh current revisions of other bindings', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
            profile: { v: 2, id: 'p', name: 'Published', createdAt: 1, updatedAt: 1 }, secretBindings: {} });
        profileArtifact = { id: 'a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(content)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 2, bodyVersion: 3,
            seq: 3, createdAt: 1, updatedAt: 2 };
        secretResources = [{ resourceId: 'existing', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Existing', kind: 'token', value: 'fixture' } },
            entry: { ref: 'happier:shared-secret:v1:existing', source: 'shared_resource', relationship: 'owner',
                name: 'Existing', kind: 'token', revision: 5, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }];
        const input = { records: [{ revision: 2, record: { ...page.rows[0].content.v,
            secretBindings: { TOKEN: 'happier:shared-secret:v1:new', OTHER: 'happier:shared-secret:v1:existing' } } }],
            expectedMode: 'plain' as const, savedSecretRevisions: [{ resourceId: 'new', expectedRevision: 1 }] };
        const prepare = () => withProfileAccount(scope, undefined, async context => {
            const { catalog, artifactsById } = await readProfileCatalogProjectionInContext(context);
            if (catalog.status !== 'ready') throw new Error(`fixture_catalog_${catalog.status}`);
            return prepareProfileRecordMutationsInContext(context, { ...input, catalog, artifactsById });
        });
        const mutations = await prepare();
        expect(mutations[0].savedSecretRevisions).toEqual([
            { resourceId: 'new', expectedRevision: 1 }, { resourceId: 'existing', expectedRevision: 5 },
        ]);
        secretResources = [];
        await expect(prepare()).rejects.toMatchObject({ code: 'invalid-reference' });
    });
    it('reads SavedSecret metadata through the already captured Profile Account request', async () => {
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const read = 'readSavedSecretCatalogInContext' in savedSecretCatalogApi
            ? savedSecretCatalogApi.readSavedSecretCatalogInContext : undefined;
        expect(typeof read).toBe('function');
        if (typeof read !== 'function') throw new Error('missing_captured_saved_secret_reader');
        await expect(withProfileAccount(scope, undefined, (context) => read(context)))
            .resolves.toEqual({ ok: true, resources: [] });
    });
    it('refuses shared-secret deletion when the real opened Profile inventory contains the reference', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
            profile: { v: 2, id: 'p', name: 'Published', createdAt: 1, updatedAt: 1 }, secretBindings: {} });
        profileArtifact = { id: 'a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(content)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 2, bodyVersion: 3,
            seq: 3, createdAt: 1, updatedAt: 2 };
        http.mockImplementation(async () => Response.json({ ...page, rows: [{ ...page.rows[0], content: { t: 'plain', v: {
            ...page.rows[0].content.v, secretBindings: { TOKEN: 'happier:shared-secret:v1:shared-a' },
        } } }] }));
        expect((await readProfileCatalog(scope)).status).toBe('ready');
        await expect(getSyncSingleton().mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: 4,
            mutate: raw => ({ settings: { ...raw }, value: undefined }) })).resolves.toMatchObject({ status: 'applied' });
        await expect(deleteSavedSecretResource({ scope, resourceId: 'shared-a', expectedRevision: 1,
            expectedSettingsVersion: 4 })).resolves.toMatchObject({ ok: false, reason: 'in_use',
            references: [{ owner: 'profile', path: 'profileRows.p.secretBindings.TOKEN' }] });
    });
    it('refuses shared-secret deletion before dispatch when Profile inventory is incomplete', async () => {
        http.mockImplementation(async () => Response.json({ ...page, complete: false }));
        await expect(deleteSavedSecretResource({ scope, resourceId: 'shared-a', expectedRevision: 1,
            expectedSettingsVersion: 4 })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    });
    it('opens the actual row schema without fabricating Plain Account keys', async () => {
        const catalog = await readProfileCatalog(scope);
        expect(catalog).toMatchObject({ status: 'ready', authority: 'inactive', control: null,
            controlRevision: 'absent', referenceGuardRevision: 3,
            records: [{ revision: 2, record: { id: 'p', enabled: true } }] });
        expect(http.mock.calls.every(([url]) => new URL(String(url)).hostname === 'profile-home-a.example.test')).toBe(true);
    });
    it('does not return a delayed A row after the captured Home lifetime retires', async () => {
        let finish!: (response: Response) => void;
        http.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const pending = readProfileCatalog(scope);
        await vi.waitFor(() => expect(http).toHaveBeenCalled());
        await activateHome('b');
        finish(Response.json(page));
        await expect(pending).resolves.toMatchObject({ status: 'unavailable', reason: 'scope-retired' });
    });
});
