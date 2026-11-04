import { vi, type Mock } from 'vitest';
import {
    AccountSettingsStoredContentEnvelopeSchema,
    AccountSettingsV2UpdateResponseSchema,
    SavedSecretCatalogEntryV1Schema,
    SavedSecretResourceEnvelopeRepairInputV1Schema,
    SavedSecretResourceMaterialV1Schema,
    SharedSavedSecretDeleteInputV1Schema,
    SharedSavedSecretCreateInputV1Schema,
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
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { normalizeAccountSettingsForLocalStorage, normalizeAccountSettingsForServerStorage, openAccountSettingsStoredContent, type OpenedAccountSettingsStoredContent } from '@/sync/domains/settings/accountSettingsNormalization';
import { stripLocalOnlyAccountSettings } from '@/sync/domains/settings/localOnlyAccountSettings';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createConnectedPurposeCatalogHttpBoundary, type ConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export type SecretSettingsTestHarness = {
    credentials: AuthCredentials;
    encryption: Encryption | null;
    scope: ServerAccountScope;
    request: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
    resources: SavedSecretResourceMaterialV1[];
    recipients: SavedSecretResourceEnvelopeCensusRecipientV1[];
    updates: Array<ReturnType<typeof SharedSavedSecretUpdateInputV1Schema.parse>>;
    creations: Array<ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>>;
    deletes: Array<ReturnType<typeof SharedSavedSecretDeleteInputV1Schema.parse>>;
    repairs: Array<ReturnType<typeof SavedSecretResourceEnvelopeRepairInputV1Schema.parse>>;
    settingsWrites: unknown[];
    promotions: Array<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>>;
    catalogRows: Map<string, unknown>;
    artifacts: ArtifactStoreBoundary;
    purposes: ConnectedPurposeCatalogHttpBoundary | null;
    /** Publications from the synthetic Home boundary after a request settles. */
    subscribe(listener: () => void): () => void;
    setRejectSettingsWrites(next: boolean): void;
    setLosePromotionResponse(next: boolean): void;
    replaceSettings(next: Settings, options?: Readonly<{ version?: number; publish?: boolean }>): void;
    readonly persistedSettings: Settings;
    readonly persistedRawSettings: OpenedAccountSettingsStoredContent['raw'];
    addOwnerResource(resourceMode?: 'plain' | 'e2ee'): Promise<{
        entry: ReturnType<typeof SavedSecretCatalogEntryV1Schema.parse>;
        resourceDataKey: Uint8Array;
    }>;
    dispose: Awaited<ReturnType<typeof restoreServerAccountForTest>>['dispose'];
};

/** Real Home/Account/catalog/Action/crypto owners, with only HTTP and credential storage synthetic. */
export async function createSecretSettingsTestHarness(options: Readonly<{
    accountId?: string;
    /** Provenance-bearing credential for composed CLI/daemon/app Account ingress. */
    token?: string;
    serverIdentityId?: string;
    features?: ReturnType<typeof createRootLayoutFeaturesResponse>;
    mode?: 'plain' | 'e2ee';
    sharedEnabled?: boolean;
    plaintextStorageEnabled?: boolean;
    settings?: Settings;
    /** Retained/future HTTP source bodies are intentionally wider than the UI projection. */
    rawSettings?: Readonly<Record<string, unknown>>;
    rejectSettingsWrites?: boolean;
    approvalRequired?: boolean;
    connectedPurposes?: ConnectedPurposeCatalogV1;
    voiceEnabled?: boolean;
}> = {}): Promise<SecretSettingsTestHarness> {
    await loadSyncSingletonForTests();
    const mode = options.mode ?? 'plain';
    const accountId = options.accountId ?? 'account-a';
    const token = options.token ?? `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = mode === 'e2ee'
        ? { token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }
        : { token };
    const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(credentials) : null;
    const features = options.features ?? createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: options.serverIdentityId ?? null },
    } });
    if (options.voiceEnabled !== undefined && !tryWriteServerEnabledBitInPlace(features, 'voice', options.voiceEnabled)) {
        throw new Error('Voice feature fixture is not writable');
    }
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
    // Seed the synthetic Home's incoming document. Client write admission runs
    // only after restoration has established this device's real local custody.
    const raw = options.rawSettings ?? normalizeVoiceSettingsServerDelta(stripLocalOnlyAccountSettings(settings));
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
    const creations: Array<ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>> = [];
    const deletes: Array<ReturnType<typeof SharedSavedSecretDeleteInputV1Schema.parse>> = [];
    const repairs: Array<ReturnType<typeof SavedSecretResourceEnvelopeRepairInputV1Schema.parse>> = [];
    const settingsWrites: unknown[] = [];
    const promotions: Array<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>> = [];
    const catalogRows = new Map<string, unknown>();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: mode });
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const handleRequest = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const path = url.pathname;
        const purposeResponse = purposes ? await purposes.handle(input, init) : null;
        if (purposeResponse) return purposeResponse;
        const artifactResponse = artifacts.handle(`${path}${url.search}`, init);
        if (artifactResponse) return await artifactResponse;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
        if (path === '/v2/changes') return Response.json(ChangesResponseSchema.parse({ changes: [], nextCursor: 0 }));
        if (path === '/v1/account/profile') return new Headers(init?.headers).get('Authorization') === `Bearer ${token}`
            ? Response.json(AccountProfileSchema.parse({ id: accountId }))
            : Response.json({ error: 'Not authenticated' }, { status: 401 });
        if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
        if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
        } }));
        if (path.startsWith('/v1/account/authoring-memory/')) return Response.json({ status: 'absent' });
        if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
        if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode, version: 1, updatedAt: 1,
            settingsVersion,
            signingKeyFingerprint: encryption ? 'signing' : null,
            contentKeyFingerprint: encryption ? computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey) : null,
            recipientEnvelopeReadiness: encryption ? { status: 'available' } : { status: 'unavailable', reason: 'plain_account' },
        });
        if (path === '/v2/account/settings/history' && init?.method === 'GET') {
            // This fresh Home fixture retains no history snapshots. The real
            // importer still performs its inventory and authority recapture.
            return Response.json(AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }));
        }
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
        if (path === '/v1/account/saved-secrets/resources' && (!init?.method || init.method === 'GET')) {
            return Response.json({ resources: resources.map(resource => resource.entry) });
        }
        if (path === '/v1/account/saved-secrets/resources' && init?.method === 'POST') {
            const body=SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init.body)));
            creations.push(body);
            const ownerEnvelope=body.keyEnvelopes?.find(envelope=>envelope.recipientAccountId===accountId);
            resources.push(SavedSecretResourceMaterialV1Schema.parse({resourceId:body.resourceId,encryptionMode:body.encryptionMode,
                storedContent:body.storedContent,recipientEnvelope:ownerEnvelope?{encryptedDataKey:ownerEnvelope.encryptedDataKey,
                    recipientContentPublicKeyFingerprint:ownerEnvelope.recipientContentPublicKeyFingerprint}:null,
                entry:{ref:`happier:shared-secret:v1:${body.resourceId}`,source:'shared_resource',relationship:'owner',ownerAccountId:accountId,
                    name:body.displayName,kind:body.kind,encryptionMode:body.encryptionMode,revision:1,materialStatus:'ready',
                    audience:{accounts:[],teams:[],groups:[]},capabilities:{use:true,rename:true,rotate:true,manageAccess:true,delete:true}},
            }));
            return Response.json({resourceId:body.resourceId,revision:1});
        }
        if (path === PROFILE_ROWS_ROUTE_V1) return Response.json(catalogRows.get(path) ?? { status: 'listed', rows: [], nextCursor: null,
            complete: true, referenceGuardRevision, transferControl: { status: 'absent' }, diagnostics: [] });
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: referenceGuardRevision });
        if (path === PROFILE_TRANSFER_ROUTE_V1 || path === REMOTE_HOST_ROWS_ROUTE_V1 || path === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json(catalogRows.get(path) ?? { status: 'absent' });
        if (['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp', '/v1/account/entity-rows/provider-connections',
            '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes',
            '/v1/account/entity-rows/prompt-library/registry-sources'].includes(path)) {
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
                        relationship: 'owner', ownerAccountId: accountId, name: content.name, kind: content.kind,
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
            const ownerEnvelope = body.keyEnvelopes?.find((envelope) => envelope.recipientAccountId === accountId);
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
    };
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        try { return await handleRequest(input, init); }
        finally { notify(); }
    });
    const purposes = options.connectedPurposes ? createConnectedPurposeCatalogHttpBoundary({
        initialValue: options.connectedPurposes, mode,
        material: mode === 'e2ee' ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null,
        settingsRequest: (url, init) => request(url, init),
    }) : null;
    const serverUrl = `https://secrets-${crypto.randomUUID()}.example.test`;
    // Account restoration publishes its coarse cursor wake after Settings has
    // settled. Finish that real bootstrap before a test admits a catalog read.
    let finishBootstrap!: () => void;
    const bootstrapReady = new Promise<void>(resolve => { finishBootstrap = resolve; });
    const detachBootstrap = subscribeHomeAccountChange(event => {
        if (event.source === undefined && event.entityIds === undefined
            && areServerProfileIdentifiersEquivalent(event.serverId, options.serverIdentityId ?? new URL(serverUrl).host)) finishBootstrap();
    });
    const connection = await restoreServerAccountForTest({
        serverUrl, accountId, credentials, request,
        ...(options.serverIdentityId ? { serverIdentityId: options.serverIdentityId } : {}),
        credentialScope: 'restored-home',
    }).then(async connection => { await bootstrapReady; return connection; }).finally(detachBootstrap);
    const { sync } = await import('@/sync/sync');
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    const scope = { serverId: connection.serverId, accountId };
    const keys = await resolveSettingsSecretsKeySet({ credentials, scope });
    if (!keys) throw new Error('Secret Settings fixture could not initialize local secret custody');
    const localSettings = (source: Settings) => normalizeAccountSettingsForLocalStorage({ raw: source, mode,
        settingsSecretsKey: keys.writeKey, settingsSecretsReadKeys: keys.readKeys,
        normalizeServerRaw: normalizeVoiceSettingsServerDelta });
    storage.setState({ settings: localSettings(settings), settingsScope: scope, settingsVersion });
    return {
        credentials, encryption, scope, request, resources, recipients, updates, creations, deletes, repairs, settingsWrites, promotions, catalogRows, artifacts, purposes,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setRejectSettingsWrites(next: boolean) { rejectSettingsWrites = next; },
        setLosePromotionResponse(next: boolean) { losePromotionResponse = next; },
        replaceSettings(next: Settings, options?: Readonly<{ version?: number; publish?: boolean }>) {
            const previousVersion = settingsVersion;
            settingsVersion = options?.version ?? settingsVersion;
            const nextRaw = normalizeAccountSettingsForServerStorage({ raw: next, mode,
                settingsSecretsKey: keys.writeKey, settingsSecretsReadKeys: keys.readKeys,
                normalizeServerRaw: normalizeVoiceSettingsServerDelta }).value;
            settingsContent = AccountSettingsStoredContentEnvelopeSchema.parse(encryption ? {
                t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                    payload: nextRaw, randomBytes: getRandomBytes }),
            } : { t: 'plain', v: nextRaw });
            if (options?.publish !== false) {
                if (options?.version !== undefined && options.version > previousVersion) {
                    // Incoming revisions use the same scope, ordering and
                    // unchanged-key reconciliation as real server settings.
                    storage.getState().applySettingsForScope(scope, localSettings(next), settingsVersion);
                } else {
                    // Retain same-version fixture setup; it is not server ingress.
                    storage.setState({ settings: localSettings(next), settingsVersion, settingsScope: scope });
                }
            }
            notify();
        },
        get persistedSettings() {
            return settingsParse(openAccountSettingsStoredContent({ content: settingsContent, encryption, expectedMode: mode }).raw);
        },
        get persistedRawSettings() {
            return openAccountSettingsStoredContent({ content: settingsContent, encryption, expectedMode: mode }).raw;
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
                encryptionMode: resourceMode, ownerAccountId: accountId, revision: 3, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            });
            resources.push(SavedSecretResourceMaterialV1Schema.parse({ resourceId: 'resource-a', encryptionMode: resourceMode, entry, storedContent, recipientEnvelope }));
            notify();
            return { entry, resourceDataKey };
        },
        dispose: connection.dispose,
    };
}
