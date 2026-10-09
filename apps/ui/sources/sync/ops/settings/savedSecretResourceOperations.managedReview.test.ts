import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { tryWriteServerEnabledBitInPlace, openSavedSecretResourceStoredContentV1, sealSavedSecretResourceStoredContentV1,
    StoredApprovalRequestSchema, buildApprovalRequestArtifactHeaderV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { listAccountSettingsSavedSecretReferences } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretDeleteInputV1Schema, SavedSecretReferenceCensusV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { readProfileCatalog } from '@/sync/api/account/apiProfileCatalog';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { createSavedSecretResource, deleteSavedSecretResource, updateSavedSecretResource, promotePersonalSavedSecretResource } from './savedSecretResourceOperations';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretUpdateInputV1Schema, SavedSecretResourceEnvelopeRepairInputV1Schema,
    SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { deriveSettingsSecretsKeySet, encryptSecretString } from '@/sync/encryption/secretSettings';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { ArtifactCreateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { TeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import tweetnacl from 'tweetnacl';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { await connection?.dispose(); connection = null; resetTeamActionClientForTests(); });

const emptyReferenceCatalogRows = new Map<string, unknown>([
    [MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
    [ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
    [PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'absent' })],
    [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
    [`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' })],
]);

describe('Saved Secret native responsibility review through its real delete owner', () => {
    it('creates on a captured keyless Plain Account while the focused Account is E2EE', async () => {
        const accountId = 'plain-secret-owner';
        const targetUrl = 'https://plain-secret-create.test';
        const targetProfile = await upsertServerProfileOnly({ serverUrl: targetUrl, name: 'Plain destination' });
        const targetHome = await setServerProfileIdentityForUrl(targetProfile.serverUrl, 'srv_plain_secret_create');
        if (!targetHome) throw new Error('Missing destination Home identity');
        const targetCredentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
        const activeCredentials = { token: createAccountTokenForTests('focused-encrypted-account', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://focused-secret-create.test',
            serverIdentityId: 'srv_focused_secret_create', accountId: 'focused-encrypted-account', credentials: activeCredentials,
            request: async (rawUrl) => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const focusedEncryption = getSyncSingleton().encryption;
        expect(focusedEncryption).not.toBeNull();
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async url => (
            new URL(url).origin === targetUrl ? targetCredentials : activeCredentials
        ));
        const writes: unknown[] = [];
        const writeHomes: string[] = [];
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.create': ['ui'] } });
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: url.origin === targetUrl ? 'plain' : 'e2ee', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 4 });
            if (url.pathname === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'] && init?.method === 'POST') {
                writeHomes.push(url.origin);
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${targetCredentials.token}`);
                const body: unknown = JSON.parse(String(init?.body));
                writes.push(body);
                const parsed = SharedSavedSecretCreateInputV1Schema.parse(body);
                return parsed.encryptionMode === 'plain'
                    ? Response.json({ resourceId: parsed.resourceId, revision: 1 })
                    : Response.json({ error: 'encryption_mode_mismatch' }, { status: 400 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const result = await createSavedSecretResource({
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(targetHome.id), accountId },
            name: 'Destination token', kind: 'token', value: 'destination-private', accountGrants: [], teamGrants: [], groupGrants: [],
        });
        expect(result).toMatchObject({ ok: true, revision: 1 });
        expect(writeHomes).toEqual([targetUrl]);
        expect(writes).toEqual([expect.objectContaining({ encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Destination token', kind: 'token', value: 'destination-private' } } })]);
        expect(writes[0]).not.toHaveProperty('keyEnvelopes');
        expect(getSyncSingleton().encryption).toBe(focusedEncryption);
    });

    it.each(['convert', 'approved-promotion'] as const)('uses captured E2EE keys with a focused keyless Plain Account (%s)', async operation => {
        const accountId = 'encrypted-secret-owner';
        const targetUrl = 'https://encrypted-secret-target.test';
        const targetProfile = await upsertServerProfileOnly({ serverUrl: targetUrl, name: 'Encrypted destination' });
        const targetHome = await setServerProfileIdentityForUrl(targetProfile.serverUrl, 'srv_encrypted_secret_target');
        if (!targetHome) throw new Error('Missing encrypted Home identity');
        const targetCredentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(13), 'base64url') };
        const targetEncryption = await createEncryptionFromAuthCredentials(targetCredentials);
        const targetMaterial = resolveAccountScopedCryptoMaterialFromCredentials(targetCredentials);
        if (!targetEncryption || !targetMaterial) throw new Error('Missing genuine destination key material');
        const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: targetMaterial }).contentPublicKeyFingerprint);
        const activeCredentials = { token: createAccountTokenForTests('focused-plain-account', { currentAccount: true }) };
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://focused-plain-secret.test',
            serverIdentityId: 'srv_focused_plain_secret', accountId: 'focused-plain-account', credentials: activeCredentials,
            request: async rawUrl => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/health') return Response.json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 0 }));
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        expect(getSyncSingleton().encryption).toBeNull();
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async url => new URL(url).origin === targetUrl ? targetCredentials : activeCredentials);
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(targetHome.id), accountId };
        const secret = { id: 'personal-cross-home', name: 'Key', kind: 'token' as const, createdAt: 1, updatedAt: 2,
            encryptedValue: { _isSecretValue: true as const, encryptedValue: encryptSecretString('target-private', deriveSettingsSecretsKeySet(targetMaterial).writeKey) } };
        const resourceId = operation === 'convert' ? 'resource-cross-home' : deriveSavedSecretImportResourceIdV1({ accountId,
            source: { kind: 'personal-saved-secret', secretId: secret.id } });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, ...(operation === 'convert'
            ? { approvalWaivedSurfaces: { 'secrets.shared.update': ['ui'] } }
            : { actions: { 'secrets.shared.promote': { approvalRequiredSurfaces: ['ui'] } } }) });
        let source: Record<string, unknown> = { actionsSettingsV1, ...(operation === 'approved-promotion' ? { secrets: [secret] } : {}) };
        let approved = false;
        const resourceDataKey = new Uint8Array(32).fill(19);
        const writes: { path: string; body: unknown }[] = [];
        const artifacts: ArtifactCreateRequest[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
            expect(url.origin).toBe(targetUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${targetCredentials.token}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                settingsVersion: approved ? 5 : 4, signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'encrypted',
                c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: targetMaterial, payload: source, randomBytes: tweetnacl.randomBytes }) }, version: approved ? 5 : 4 });
            if (url.pathname === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], complete: true,
                nextCursor: null, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] });
            if (url.pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (url.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (url.pathname === REMOTE_HOST_ROWS_ROUTE_V1) return Response.json(RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
            if (emptyReferenceCatalogRows.has(url.pathname)) return Response.json(emptyReferenceCatalogRows.get(url.pathname));
            if (url.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: operation === 'approved-promotion' && !approved ? [] : [{
                resourceId, encryptionMode: approved ? 'e2ee' : 'plain',
                storedContent: approved ? sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
                    content: { v: 1, name: 'Key', kind: 'token', value: 'target-private' }, randomBytes: tweetnacl.randomBytes })
                    : { t: 'plain', v: { v: 1, name: 'Key', kind: 'token', value: 'target-private' } },
                recipientEnvelope: approved ? { encryptedDataKey: encryptDataKeyForRecipientV0(resourceDataKey, encodeBase64(targetEncryption.contentDataKey, 'base64')),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(targetEncryption.contentDataKey) } : null,
                entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                    name: 'Key', kind: 'token', revision: approved ? 1 : 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] });
            if (url.pathname === '/v1/account/saved-secrets/resources/envelope-census') return Response.json({ resourceId, revision: approved ? 1 : 4,
                nextCursor: null, recipients: [{ account: { kind: 'account', accountId: 'ready-recipient', firstName: null, lastName: null, username: null, avatarUrl: null }, envelopeStatus: 'missing',
                    readiness: { status: 'available', contentPublicKey: encodeBase64(targetEncryption.contentDataKey, 'base64'),
                        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(targetEncryption.contentDataKey) } }] });
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const artifact = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                artifacts.push(artifact);
                return Response.json({ ...artifact, ownerAccountId: accountId, access: 'owner', encryptionMode: 'e2ee',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            if (init?.method === 'POST') {
                const body: unknown = JSON.parse(String(init.body));
                writes.push({ path: url.pathname, body });
                if (url.pathname === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                    const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
                    if (mutation.nextSettings?.t !== 'encrypted') throw new Error('Expected captured encrypted source rewrite');
                    source = AccountSettingsPersistedObjectSchema.parse(openAccountScopedBlobCiphertext({ kind: 'account_settings',
                        material: targetMaterial, ciphertext: mutation.nextSettings.c })?.value);
                    approved = true;
                    return Response.json({ resourceId: mutation.resourceId, settingsVersion: 5 });
                }
                return Response.json({ resourceId, revision: approved ? 1 : 4 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        if (operation === 'convert') {
            expect(await updateSavedSecretResource({ scope, resourceId, expectedRevision: 3, toMode: 'e2ee',
                decryptDataKeyEnvelope: async () => null })).toEqual({ ok: true });
            const write = writes.find(value => value.path.endsWith('/update'));
            expect(write).toBeDefined();
            const mutation = SharedSavedSecretUpdateInputV1Schema.parse(write!.body);
            const key = await targetEncryption.decryptEncryptionKey(mutation.keyEnvelopes![0]!.encryptedDataKey, scope);
            expect(key).not.toBeNull();
            expect(openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey: key!, storedContent: mutation.storedContent })).toMatchObject({ value: 'target-private' });
        } else {
            const succeeded = vi.fn();
            const pending = await promotePersonalSavedSecretResource({ scope, expectedSettingsVersion: 4, secret,
                accountGrants: ['ready-recipient'], teamGrants: [], groupGrants: [], onApprovalSucceeded: succeeded }).catch((error: unknown) => error);
            expect(pending).toBeInstanceOf(TeamActionApprovalPendingError);
            if (!(pending instanceof TeamActionApprovalPendingError) || typeof pending.registration === 'string') throw new Error('Missing promotion continuation');
            const artifact = artifacts[0]!;
            const key = await targetEncryption.decryptEncryptionKey(artifact.dataEncryptionKey, scope);
            if (!key) throw new Error('Missing captured Artifact key');
            const decrypted = await new ArtifactEncryption(key).decryptBody(artifact.body!);
            if (!decrypted || typeof decrypted.body !== 'string') throw new Error('Missing captured Artifact body');
            const request = StoredApprovalRequestSchema.parse(JSON.parse(decrypted.body));
            if (request.v !== 2) throw new Error('Missing immutable approval origin');
            approved = true;
            source = { ...source, secrets: [] };
            const settledAt = request.createdAtMs + 1;
            const settled: ApprovalRequestV2 = { ...request, status: 'executed', updatedAtMs: settledAt, decision: { kind: 'approve', decidedAtMs: settledAt },
                execution: { ok: true, executedAtMs: settledAt, result: { resourceId, settingsVersion: 5 } } };
            const observation: DecryptedArtifact = { id: artifact.id, header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled),
                headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2, isDecrypted: true };
            expect(await pending.registration.onExecuted(observation)).toBe('consumed');
            expect(succeeded).toHaveBeenCalledWith({ ok: true, resourceRef: `happier:shared-secret:v1:${resourceId}` });
            const repairs = writes.filter(value => value.path.endsWith('/envelopes/repair'));
            expect(repairs).toHaveLength(1);
            expect(SavedSecretResourceEnvelopeRepairInputV1Schema.parse(repairs[0]!.body)).toMatchObject({ resourceId, expectedRevision: 1,
                keyEnvelopes: [{ recipientAccountId: 'ready-recipient' }] });
            expect(writes.some(value => value.path.endsWith('/promote'))).toBe(false);
        }
        expect(getSyncSingleton().encryption).toBeNull();
    });

    it.each(['review', 'manual-retry'] as const)('preserves the authoritative review and exact retry operands (%s)', async (phase) => {
        const resource = {
            managedId: 'managed-a', homeId: 'srv_secret_review', custodianAccountId: 'account-secret', intentRevision: 3,
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, allocation: 'bound' as const,
            resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' },
                schemaVersion: 1, value: { name: 'retained-guest-a' } },
        };
        const dispositions = [{ managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedResource: resource.resource, responsibility: 'manual' as const }];
        const features = createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: resource.homeId } },
        });
        expect(tryWriteServerEnabledBitInPlace(features, 'teams', true)).toBe(true);
        expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
        const deletes: unknown[] = [];
        const settingsWrites: unknown[] = [];
        const requests: string[] = [];
        // Characterize the immediate native-review result under this
        // Account's explicit persisted waiver. The shared default Ask and
        // approval replay are not bypassed by a caller-confirmed flag.
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'secrets.shared.delete': ['ui'] } });
        const transfer = ProfileTransferRowReadResponseV1Schema.parse({ status: 'absent' });
        const profileRows = ProfileRowsListResponseV1Schema.parse({ status: 'listed',
            rows: [{ id: 'retired-profile-a', revision: 7, content: null }],
            nextCursor: null, complete: true, referenceGuardRevision: 6, transferControl: transfer, diagnostics: [] });
        const profileGuard = ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 6 });
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://secret-review.test', serverIdentityId: resource.homeId, accountId: resource.custodianAccountId,
            credentials: { token: createAccountTokenForTests(resource.custodianAccountId, { currentAccount: true }) },
            request: async (rawUrl, init) => {
                const url = new URL(String(rawUrl));
                requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
                if (url.pathname === '/health') return Response.json({});
                if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }));
                if (url.pathname === PROFILE_ROWS_ROUTE_V1) return Response.json(profileRows);
                if (url.pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json(profileGuard);
                if (url.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json(transfer);
                if (url.pathname === REMOTE_HOST_ROWS_ROUTE_V1) return Response.json(RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
                if (emptyReferenceCatalogRows.has(url.pathname)) return Response.json(emptyReferenceCatalogRows.get(url.pathname));
                if (url.pathname === '/v2/account/settings') {
                    if (init?.method === 'POST') settingsWrites.push(JSON.parse(String(init.body)));
                    return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 4 });
                }
                if (url.pathname === '/v1/artifacts') return Response.json([]);
                if (url.pathname === '/v1/account/saved-secrets/resources/delete') {
                    const body: unknown = JSON.parse(String(init?.body));
                    deletes.push(body);
                    const parsed = SharedSavedSecretDeleteInputV1Schema.safeParse(body);
                    if (!parsed.success) return Response.json({ error: 'invalid_resource' }, { status: 400 });
                    // This Home still owns the retained resource. It accepts
                    // the retry only when the reviewed native identity is
                    // actually carried to the HTTP boundary, never merely
                    // because the UI named a retry phase.
                    const reviewed = phase === 'manual-retry'
                        && JSON.stringify(parsed.data.managedResourceDispositions) === JSON.stringify(dispositions);
                    return reviewed
                        ? Response.json({ resourceId: 'secret-a' })
                        : Response.json({ error: 'managed_resources_review_required', resources: [resource] }, { status: 409 });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: resource.custodianAccountId };
        const profiles = await readProfileCatalog(scope);
        expect(profiles).toMatchObject({ status: 'ready', referenceGuardRevision: 6,
            tombstones: [{ id: 'retired-profile-a', revision: 7 }] });
        if (profiles.status !== 'ready') throw new Error('The real Profile reference inventory must be readable');
        const referenceCensus = SavedSecretReferenceCensusV1Schema.parse({ accountMode: 'plain',
            remoteHosts: { revision: 'absent', resourceRefs: [] },
            catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent', connectedPurposes: 'absent' },
            profileTransferRevision: profiles.controlRevision, profiles: {
                referenceGuardRevision: profiles.referenceGuardRevision,
                rows: [...profiles.records.map(({ record, revision }) => ({ id: record.id, revision })),
                    ...(profiles.tombstones ?? []).map(({ id, revision }) => ({ id, revision }))],
            } });
        const expectedActionInput = SharedSavedSecretDeleteInputV1Schema.parse({
            resourceId: 'secret-a', expectedRevision: 2, expectedSettingsVersion: 4, referenceCensus,
            ...(phase === 'manual-retry' ? { managedResourceDispositions: dispositions } : {}),
        });
        // Prove the actual initialized Settings authority before classifying a
        // refusal as missing native-review behavior. No internal census mock.
        await expect(getSyncSingleton().mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: 4,
            mutate: raw => ({ settings: { ...raw }, value: {
                actionsSettingsV1: raw.actionsSettingsV1,
                references: listAccountSettingsSavedSecretReferences(raw, formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'secret-a' })),
            } }) })).resolves.toMatchObject({ status: 'applied', value: { actionsSettingsV1, references: [] } });
        const input = { scope, resourceId: 'secret-a', expectedRevision: 2, expectedSettingsVersion: 4,
            ...(phase === 'manual-retry' ? { managedResourceDispositions: dispositions } : {}) };
        const result = await deleteSavedSecretResource(input);
        const evidence = JSON.stringify({ result, requests });
        expect(deletes, evidence).toHaveLength(1);
        expect(result, evidence).toEqual(phase === 'review'
            ? { ok: false, reason: 'managed_resources_review_required', resources: [resource] } : { ok: true });
        expect(deletes).toEqual([expectedActionInput]);
        expect(settingsWrites).toEqual([]);
    });
});
