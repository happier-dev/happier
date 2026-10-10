import { vi } from 'vitest';
import {
    AccountSettingsStoredContentEnvelopeSchema,
    AccountSettingsV2UpdateResponseSchema,
    SavedSecretCatalogEntryV1Schema,
    SavedSecretResourceEnvelopeRepairInputV1Schema,
    SavedSecretResourceMaterialV1Schema,
    SharedSavedSecretDeleteInputV1Schema,
    SharedSavedSecretUpdateInputV1Schema,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    computeContentPublicKeyFingerprint,
    sealAccountScopedBlobCiphertext,
    sealSavedSecretResourceStoredContentV1,
    openSavedSecretResourceStoredContentV1,
    tryWriteServerEnabledBitInPlace,
    type SavedSecretResourceEnvelopeCensusRecipientV1,
    type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { normalizeAccountSettingsForServerStorage, openAccountSettingsStoredContent } from '@/sync/domains/settings/accountSettingsNormalization';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

/** Real Home/Account/catalog/Action/crypto owners, with only HTTP and credential storage synthetic. */
export async function createSecretSettingsTestHarness(options: Readonly<{
    mode?: 'plain' | 'e2ee';
    sharedEnabled?: boolean;
    plaintextStorageEnabled?: boolean;
    settings?: Settings;
    rejectSettingsWrites?: boolean;
    approvalRequired?: boolean;
}> = {}) {
    await loadSyncSingletonForTests();
    const mode = options.mode ?? 'plain';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const credentials = mode === 'e2ee'
        ? { token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }
        : { token };
    const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : null;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'teams', options.sharedEnabled ?? true)
        || !tryWriteServerEnabledBitInPlace(features, 'encryption.plaintextStorage', options.plaintextStorageEnabled ?? true)) {
        throw new Error('Saved Secrets feature fixture is not writable');
    }
    const settings = options.settings ?? settingsParse({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        ...(options.approvalRequired ? { actions: { 'secrets.shared.promote': { approvalRequiredSurfaces: ['ui'] } } }
            : { approvalWaivedSurfaces: { 'secrets.shared.promote': ['ui'], 'secrets.shared.create': ['ui'] } }),
    }), secrets: mode === 'plain' ? [{
        id: 'personal-a', name: 'Personal', kind: 'token',
        encryptedValue: { _isSecretValue: true, value: 'value' }, createdAt: 1, updatedAt: 1,
    }] : [] });
    const raw = normalizeAccountSettingsForServerStorage({ raw: settings, mode,
        settingsSecretsKey: null, normalizeServerRaw: normalizeVoiceSettingsServerDelta }).value;
    let settingsContent = AccountSettingsStoredContentEnvelopeSchema.parse(encryption ? {
        t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
            payload: raw, randomBytes: getRandomBytes }),
    } : { t: 'plain', v: raw });
    let settingsVersion = 1;
    let referenceGuardRevision = 3;
    let losePromotionResponse = false;
    let rejectSettingsWrites = options.rejectSettingsWrites ?? false;
    const resources: SavedSecretResourceMaterialV1[] = [];
    const recipients: SavedSecretResourceEnvelopeCensusRecipientV1[] = [];
    const updates: Array<ReturnType<typeof SharedSavedSecretUpdateInputV1Schema.parse>> = [];
    const deletes: Array<ReturnType<typeof SharedSavedSecretDeleteInputV1Schema.parse>> = [];
    const repairs: Array<ReturnType<typeof SavedSecretResourceEnvelopeRepairInputV1Schema.parse>> = [];
    const settingsWrites: unknown[] = [];
    const promotions: Array<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>> = [];
    const catalogRows = new Map<string, unknown>();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: mode });
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const path = url.pathname;
        const artifactResponse = artifacts.handle(`${path}${url.search}`, init);
        if (artifactResponse) return await artifactResponse;
        if (path === '/v1/features') return Response.json(features);
        if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode, version: 1, updatedAt: 1,
            settingsVersion,
            signingKeyFingerprint: encryption ? 'signing' : null,
            contentKeyFingerprint: encryption ? computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey) : null,
            recipientEnvelopeReadiness: encryption ? { status: 'available' } : { status: 'unavailable', reason: 'plain_account' },
        });
        if (path === '/v2/account/settings') {
            if (init?.method !== 'POST') return Response.json({ content: settingsContent, version: settingsVersion });
            const body: unknown = JSON.parse(String(init.body));
            settingsWrites.push(body);
            if (!body || typeof body !== 'object' || !('expectedVersion' in body) || !('content' in body)) throw new Error('Invalid Settings request');
            if (rejectSettingsWrites || body.expectedVersion !== settingsVersion) {
                return Response.json(AccountSettingsV2UpdateResponseSchema.parse({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: settingsVersion,
                    currentContent: settingsContent,
                }));
            }
            const content = AccountSettingsStoredContentEnvelopeSchema.parse(body.content);
            if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && content.t !== 'encrypted')) {
                return Response.json({ error: 'settings_invalid' }, { status: 400 });
            }
            settingsContent = content;
            settingsVersion += 1;
            return Response.json({ success: true, version: settingsVersion });
        }
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources });
        if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
            complete: true, referenceGuardRevision, transferControl: { status: 'absent' }, diagnostics: [] });
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: referenceGuardRevision });
        if (path === PROFILE_TRANSFER_ROUTE_V1 || path === REMOTE_HOST_ROWS_ROUTE_V1 || path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json({ status: 'absent' });
        if (['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp', '/v1/account/entity-rows/provider-connections',
            '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes'].includes(path)) {
            return Response.json(catalogRows.get(path) ?? { status: 'absent' });
        }
        if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
            const input = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init?.body)));
            if (mode !== 'plain' || input.nextSettings?.t !== 'plain') throw new Error('Full-save fixture requires Plain Settings');
            if (rejectSettingsWrites || input.expectedSettingsVersion !== settingsVersion) {
                return Response.json({ error: 'settings_conflict' }, { status: 409 });
            }
            for (const resource of [input, ...(input.additionalSavedSecretResources ?? [])]) {
                const content = openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId,
                    mode: 'plain', storedContent: resource.storedContent });
                if (!content) throw new Error('Expected canonical resource content');
                resources.push(SavedSecretResourceMaterialV1Schema.parse({ resourceId: resource.resourceId,
                    encryptionMode: 'plain', storedContent: resource.storedContent, recipientEnvelope: null,
                    entry: { ref: `happier:shared-secret:v1:${resource.resourceId}`, source: 'shared_resource',
                        relationship: 'owner', ownerAccountId: 'account-a', name: content.name, kind: content.kind,
                        encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
                        audience: { accounts: [], teams: [], groups: [] },
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }));
            }
            promotions.push(input);
            settingsContent = AccountSettingsStoredContentEnvelopeSchema.parse(input.nextSettings);
            settingsVersion += 1;
            referenceGuardRevision += 1;
            if (losePromotionResponse) throw new TypeError('Response lost after accepting the full transaction');
            return Response.json({ resourceId: input.resourceId, settingsVersion });
        }
        if (path === '/v1/account/saved-secrets/resources/envelope-census') {
            const resource = resources.find((row) => 'resourceId' in row && row.resourceId === url.searchParams.get('resourceId'));
            if (!resource || !('resourceId' in resource)) return Response.json({ error: 'resource_not_found' }, { status: 404 });
            return Response.json({ resourceId: resource.resourceId, revision: resource.entry.revision, recipients, nextCursor: null });
        }
        if (path === '/v1/account/saved-secrets/resources/envelopes/repair') {
            const body = SavedSecretResourceEnvelopeRepairInputV1Schema.parse(JSON.parse(String(init?.body)));
            const resource = resources.find((row) => 'resourceId' in row && row.resourceId === body.resourceId);
            if (!resource || !('resourceId' in resource) || resource.entry.revision !== body.expectedRevision) {
                return Response.json({ error: 'resource_changed' }, { status: 409 });
            }
            repairs.push(body);
            return Response.json({ resourceId: body.resourceId, revision: body.expectedRevision });
        }
        if (path === '/v1/account/saved-secrets/resources/update') {
            const body = SharedSavedSecretUpdateInputV1Schema.parse(JSON.parse(String(init?.body)));
            const index = resources.findIndex((row) => 'resourceId' in row && row.resourceId === body.resourceId);
            const current = resources[index];
            if (!current || !('resourceId' in current)) return Response.json({ error: 'resource_not_found' }, { status: 404 });
            if (current.entry.revision !== body.expectedRevision) return Response.json({ error: 'resource_changed' }, { status: 409 });
            updates.push(body);
            const nextMode = body.toMode ?? current.encryptionMode;
            const ownerEnvelope = body.keyEnvelopes?.find((envelope) => envelope.recipientAccountId === 'account-a');
            const revision = body.expectedRevision + 1;
            resources[index] = SavedSecretResourceMaterialV1Schema.parse({ ...current,
                encryptionMode: nextMode, storedContent: body.storedContent,
                entry: { ...current.entry, encryptionMode: nextMode, name: body.displayName, kind: body.kind, revision },
                recipientEnvelope: nextMode === 'plain' ? null : ownerEnvelope ? {
                    encryptedDataKey: ownerEnvelope.encryptedDataKey,
                    recipientContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
                } : current.recipientEnvelope,
            });
            return Response.json({ resourceId: body.resourceId, revision });
        }
        if (path === '/v1/account/saved-secrets/resources/delete') {
            const body = SharedSavedSecretDeleteInputV1Schema.parse(JSON.parse(String(init?.body)));
            const index = resources.findIndex((row) => 'resourceId' in row ? row.resourceId === body.resourceId
                : row.entry.relationship === 'owner' && row.entry.repair.resourceId === body.resourceId);
            const resource = resources[index];
            const revision = resource && ('resourceId' in resource ? resource.entry.revision
                : resource.entry.relationship === 'owner' ? resource.entry.repair.expectedRevision : null);
            if (!resource || revision !== body.expectedRevision) return Response.json({ error: 'resource_changed' }, { status: 409 });
            deletes.push(body);
            if (index >= 0) resources.splice(index, 1);
            return Response.json({ resourceId: body.resourceId });
        }
        if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        return new Response('{}', { status: 404 });
    });
    const connection = await restoreServerAccountForTest({
        serverUrl: `https://secrets-${crypto.randomUUID()}.example.test`, accountId: 'account-a', credentials, request,
    });
    const { sync } = await import('@/sync/sync');
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    const scope = { serverId: connection.home.id, accountId: 'account-a' };
    storage.setState({ settings, settingsScope: scope, settingsVersion });
    return {
        credentials, encryption, scope, request, resources, recipients, updates, deletes, repairs, settingsWrites, promotions, catalogRows, artifacts,
        setRejectSettingsWrites(next: boolean) { rejectSettingsWrites = next; },
        setLosePromotionResponse(next: boolean) { losePromotionResponse = next; },
        get persistedSettings() {
            return settingsParse(openAccountSettingsStoredContent({ content: settingsContent, encryption, expectedMode: mode }).raw);
        },
        async addOwnerResource(resourceMode: 'plain' | 'e2ee' = mode) {
            const resourceDataKey = getRandomBytes(32);
            if (resourceMode === 'e2ee' && !encryption) throw new Error('E2EE fixture requires actual Account material');
            const recipientEnvelope = encryption && resourceMode === 'e2ee' ? {
                encryptedDataKey: await encryptDataKeyForRecipientV0(resourceDataKey, encodeBase64(encryption.contentDataKey, 'base64')),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
            } : null;
            const content = { v: 1 as const, name: 'Shared token', kind: 'token' as const, value: 'shared-value' };
            const storedContent = resourceMode === 'plain'
                ? sealSavedSecretResourceStoredContentV1({ mode: 'plain', resourceId: 'resource-a', content })
                : sealSavedSecretResourceStoredContentV1({ mode: 'e2ee', resourceId: 'resource-a', content, resourceDataKey, randomBytes: getRandomBytes });
            const entry = SavedSecretCatalogEntryV1Schema.parse({ ref: 'happier:shared-secret:v1:resource-a',
                source: 'shared_resource', relationship: 'owner', name: content.name, kind: content.kind,
                encryptionMode: resourceMode, ownerAccountId: 'account-a', revision: 3, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            });
            resources.push(SavedSecretResourceMaterialV1Schema.parse({ resourceId: 'resource-a', encryptionMode: resourceMode, entry, storedContent, recipientEnvelope }));
            return { entry, resourceDataKey };
        },
        dispose: connection.dispose,
    };
}
