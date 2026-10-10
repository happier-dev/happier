import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import React from 'react';
import { act } from 'react-test-renderer';
import { buildApprovalRequestArtifactHeaderV1, decodePlainArtifactStoredContent, openSavedSecretResourceStoredContentV1,
    sealSavedSecretResourceStoredContentV1, tryWriteServerEnabledBitInPlace, StoredApprovalRequestSchema,
    type ApprovalRequestV2, type SavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema,
    SharedSavedSecretUpdateInputV1Schema, SharedSavedSecretGrantsSetInputV1Schema,
    SavedSecretResourceEnvelopeRepairInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { SavedSecretResourceMaterialsResponseV1Schema, formatSavedSecretCatalogFingerprintV1, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, sealProfileRecordContentV1, type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { storage } from '@/sync/domains/state/storage';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { Artifact, ArtifactCreateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { resetTeamActionClientForTests, TeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { createSavedSecretResource, promotePersonalSavedSecretResource, updateSavedSecretResource,
    deleteSavedSecretResource, setSavedSecretResourceGrants, repairCustodiedSavedSecretResourceEnvelopesBestEffort,
    captureSavedSecretReferenceStateInContext, importLegacySavedSecretsInContext } from './savedSecretResourceOperations';
import { withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { prepareConnectedAccountCatalogMutationInContext, readConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { AccountSettingsV2UpdateRequestSchema, AccountSettingsV2HistoryListResponseSchema,
    AccountSettingsV2HistoryDetailResponseSchema, AccountSettingsV2HistoryMutationRequestSchema,
    AccountSettingsV2HistoryMutationResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { deriveSavedSecretImportResourceIdV1, promotePersonalSavedSecretReference, qualifyPluginAccountSecretBindingKey, readSavedSecretTransferSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { observeSavedSecretCatalog, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRecordV1Schema, RemoteHostCatalogRowMutationV1Schema,
    openRemoteHostCatalogContentV1, sealRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { McpServerCatalogV1Schema, sealMcpServerCatalogContentV1, McpServerCatalogRowMutationV1Schema,
    remapMcpServerCatalogSavedSecretReferencesV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { SavedSecretCatalogRevisionsV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { settingsParse } from '@/sync/domains/settings/settings';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { applySavedSecretCatalogVoiceCredentialSourceMutationV1, type SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { createAccountVoiceCredentialReplacementMutation, mutateScopedAccountVoiceCredentialSource, resolveAccountVoiceCredentialApprovalDigest } from '@/voice/credentials/accountVoiceCredential';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { LegacyVoiceCredentialBindingV1Schema } from '@happier-dev/protocol/voice/realtime/providerSettings';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogRecordV1Schema,
    NotificationChannelCatalogMutationV1Schema, openNotificationChannelCatalogContentV1,
    sealNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { openAccountSettingsStoredContent } from '@/sync/domains/settings/accountSettingsNormalization';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { readNotificationChannelCatalogProjectionInContext } from '@/sync/api/account/apiNotificationChannelCatalog';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { sealSecretsDeep } from '@/sync/encryption/secretSettings';

function PrivateSavedSecretCreateHarness(props: Readonly<{ scope: ServerAccountScope; onCreated: (ref: string) => void }>) {
    const catalog = useSavedSecretCatalog({ scope: props.scope });
    const approval = useActionApprovalContinuation({
        scopeKey: `${props.scope.serverId}:${props.scope.accountId}`,
        serverId: props.scope.serverId,
        onExecuted: () => { void catalog.reload(); },
    });
    return React.createElement(SavedSecretCreateEditor, {
        scope: props.scope,
        sharedAvailable: false,
        onCreatePersonal: catalog.personalMutations.create,
        approvalPending: approval.approvalPending,
        approvalId: approval.approvalId,
        requestApproval: approval.requestApproval,
        onOpenApproval: () => {},
        onCancel: () => {},
        onCreated: props.onCreated,
    });
}

// Expo's native UUID adapter is absent in the host runner; use the real OS randomness boundary.
vi.mock('expo-crypto', async importOriginal => ({ ...await importOriginal<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks({
    reactNavigation: async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
});
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
beforeEach(() => { resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); resetServerFeaturesClientForTests(); });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { await standardCleanup(); clearActiveUnsavedChangesGuard(); await connection?.dispose(); connection = null; resetTeamActionClientForTests(); });

/** Only HTTP, credentials and Socket transport are substituted; Account/Action/Settings/crypto owners stay real. */
async function openAccount(mode: 'plain' | 'e2ee' = 'plain', options: { ask?: boolean; teams?: boolean; home?: string;
    raw?: Record<string, unknown>; captureSourceTrace?: boolean; historySnapshot?: Record<string, unknown> } = {}) {
    const accountId = 'secret-owner';
    const credentials = mode === 'plain'
        ? { token: createAccountTokenForTests(accountId, { currentAccount: true }) }
        : { token: createAccountTokenForTests(accountId, { currentAccount: true }), secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
    let persistedMode = mode;
    // Server fixture material remains available when the client deliberately has token-only credentials.
    let serverCredentials = { token: credentials.token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, ...(options.ask ? { actions: {
        'secrets.shared.create': { approvalRequiredSurfaces: ['ui'] },
        'secrets.shared.promote': { approvalRequiredSurfaces: ['ui'] },
        'secrets.shared.update': { approvalRequiredSurfaces: ['ui'] },
        'secrets.shared.delete': { approvalRequiredSurfaces: ['ui'] },
        'secrets.shared.grants.set': { approvalRequiredSurfaces: ['ui'] },
    } } : { approvalWaivedSurfaces: {
        'secrets.shared.create': ['ui'], 'secrets.shared.promote': ['ui'], 'secrets.shared.update': ['ui'],
        'secrets.shared.delete': ['ui'], 'secrets.shared.grants.set': ['ui'],
    } }) });
    let raw: Record<string, unknown> = { ...options.raw, actionsSettingsV1 };
    let settingsVersion = 7;
    let referenceGuardRevision = 3;
    let profileReadStatus = 200;
    const resources = new Map<string, SavedSecretResourceMaterialV1>();
    const rows: ProfileRowV1[] = [];
    const catalogRows = new Map<string, unknown>();
    const writes: { path: string; body: unknown }[] = [];
    const settingsWriteStacks: string[] = [];
    const sourceReads: { version: number;
        chatSource: NonNullable<ReturnType<typeof readSavedSecretTransferSourceV1>['legacyChatCredential']>['source'] | undefined;
        voiceSources: readonly NonNullable<ReturnType<typeof readSavedSecretTransferSourceV1>['legacyVoiceCredentials']>[number]['source'][];
        voicePresent: boolean }[] = [];
    const censusReads: string[] = [];
    const catalogReadPaths: string[] = [];
    const artifacts: Artifact[] = [];
    let materialReadStatus = 200;
    let beforeMaterialRead: (() => void | Promise<void>) | undefined;
    let beforeProfileRead: (() => void) | undefined;
    let beforeHistoryRead: (() => void | Promise<void>) | undefined;
    let historyContent = options.historySnapshot ? AccountSettingsV2HistoryDetailResponseSchema.parse({ version: 4,
        createdAt: '2026-01-01T00:00:00.000Z', content: { t: 'plain', v: options.historySnapshot } }).content : null;
    const mutationPaths = new Set<string>([...Object.values(SHARED_SAVED_SECRET_ACTION_PATHS_V1),
        '/v1/account/saved-secrets/resources/envelopes/repair']);
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'teams', options.teams ?? true)).toBe(true);
    expect(tryWriteServerEnabledBitInPlace(features, 'teams.credentialResources', true)).toBe(true);
    let effect: ((path: string, body: unknown) => Promise<Response> | Response) | undefined;
    const sourceContent = () => {
        if (persistedMode === 'plain') return { t: 'plain', v: raw };
        const material = resolveAccountScopedCryptoMaterialFromCredentials(serverCredentials);
        if (!material) throw new Error('Expected genuine E2EE Settings material');
        return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: raw, randomBytes: tweetnacl.randomBytes }) };
    };
    connection = await restoreServerAccountForTest({ serverUrl: `https://saved-secret-operations-${mode}${options.home ?? ''}.test`,
        serverIdentityId: `srv_secret_operations_${mode}${options.home ?? ''}`, accountId, credentials,
        request: async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/health') return Response.json({});
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` && init?.method === 'POST') {
                return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption') return Response.json({ mode: persistedMode, updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') {
                if (persistedMode === 'plain') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
                const material = resolveAccountScopedCryptoMaterialFromCredentials(serverCredentials);
                if (!material) throw new Error('Expected genuine E2EE credential material');
                const fingerprint = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint;
                return Response.json({ mode: persistedMode, version: 1, settingsVersion, signingKeyFingerprint: null,
                    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(fingerprint),
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                writes.push({ path, body: input });
                if (options.captureSourceTrace) settingsWriteStacks.push(new Error('Account Settings HTTP write').stack ?? '');
                if (input.expectedVersion !== settingsVersion) return Response.json({ success: false,
                    error: 'version-mismatch', currentVersion: settingsVersion, currentContent: sourceContent() });
                const opened = input.content === null ? { raw: {} } : openAccountSettingsStoredContent({ content: input.content,
                    encryption: getSyncSingleton().encryption, expectedMode: persistedMode });
                if (opened.raw === null) throw new Error('Fixture Settings mutation must open in the persisted Account mode');
                raw = opened.raw;
                settingsVersion += 1;
                return Response.json({ success: true, version: settingsVersion });
            }
            if (path === '/v2/account/settings') {
                if (options.captureSourceTrace) sourceReads.push({ version: settingsVersion,
                    chatSource: readSavedSecretTransferSourceV1(raw).legacyChatCredential?.source,
                    voiceSources: (readSavedSecretTransferSourceV1(raw).legacyVoiceCredentials ?? []).map(credential => credential.source),
                    voicePresent: raw.voice !== undefined });
                return Response.json({ content: sourceContent(), version: settingsVersion });
            }
            if (path === PROFILE_ROWS_ROUTE_V1) beforeProfileRead?.();
            if (path === PROFILE_ROWS_ROUTE_V1 && profileReadStatus !== 200) return Response.json({ error: 'temporarily_unavailable' }, { status: profileReadStatus });
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows, nextCursor: null,
                complete: true, referenceGuardRevision, transferControl: { status: 'absent' }, diagnostics: [] });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: referenceGuardRevision });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === REMOTE_HOST_ROWS_ROUTE_V1) return Response.json(catalogRows.get(path) ?? { status: 'absent' });
            if (['/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp',
                '/v1/account/entity-rows/provider-connections', '/v1/account/entity-rows/connected-accounts/configurations',
                '/v1/account/entity-rows/connected-accounts/purposes', NOTIFICATION_CHANNELS_ROUTE_V1].includes(path)) {
                if (init?.method === 'POST' && effect) {
                    const body: unknown = JSON.parse(String(init.body));
                    writes.push({ path, body });
                    return effect(path, body);
                }
                catalogReadPaths.push(path);
                return Response.json(catalogRows.get(path) ?? { status: 'absent' });
            }
            if (path === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                const stored: Artifact = { ...write, ownerAccountId: accountId, access: 'owner', encryptionMode: persistedMode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                artifacts.push(stored);
                return Response.json(stored);
            }
            if (path === '/v1/artifacts') return Response.json(artifacts);
            if (path === '/v1/account/saved-secrets/resources/materials') {
                const response = materialReadStatus === 200
                    ? Response.json({ resources: [...resources.values()] })
                    : Response.json({ error: 'temporarily_unavailable' }, { status: materialReadStatus });
                // HTTP can deliver a snapshot captured before a concurrent write commits.
                await beforeMaterialRead?.();
                return response;
            }
            if (path === '/v1/account/saved-secrets/resources/envelope-census' && effect) {
                censusReads.push(String(rawUrl));
                return effect(path, undefined);
            }
            if (path === '/v2/account/settings/history') {
                await beforeHistoryRead?.();
                return Response.json(AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: historyContent ? [{ version: 4,
                    createdAt: '2026-01-01T00:00:00.000Z', contentKind: historyContent.t,
                    byteLength: JSON.stringify(historyContent).length }] : [] }));
            }
            if (path === '/v2/account/settings/history/4') return Response.json(AccountSettingsV2HistoryDetailResponseSchema.parse({
                version: 4, createdAt: '2026-01-01T00:00:00.000Z', content: historyContent,
            }));
            if (path === '/v2/account/settings/history/4/mutate' && init?.method === 'POST') {
                const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(JSON.parse(String(init.body)));
                writes.push({ path, body: mutation });
                if (mutation.expectedSettingsVersion !== settingsVersion
                    || JSON.stringify(mutation.expectedContent) !== JSON.stringify(historyContent))
                    return Response.json(AccountSettingsV2HistoryMutationResponseSchema.parse({ status: 'conflict' }));
                if (mutation.operation.kind !== 'normalize') throw new Error('This fixture admits only canonical history normalization');
                historyContent = mutation.operation.content;
                return Response.json(AccountSettingsV2HistoryMutationResponseSchema.parse({ status: 'applied' }));
            }
            if (init?.method === 'POST' && mutationPaths.has(path)) {
                const body: unknown = JSON.parse(String(init.body));
                writes.push({ path, body });
                if (effect) return effect(path, body);
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    if (options.ask) {
        await vi.waitFor(() => expect(storage.getState().settings.actionsSettingsV1).toEqual(actionsSettingsV1));
    }
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId };
    function materialRow(resourceId: string, resourceMode: 'plain' | 'e2ee', storedContent: SavedSecretResourceStoredContentV1,
        revision = 3, key?: Uint8Array, relationship: 'owner' | 'recipient' = 'owner') {
        const encryption = getSyncSingleton().encryption;
        const content = resourceMode === 'plain'
            ? openSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', storedContent })
            : key ? openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', storedContent, resourceDataKey: key }) : null;
        const row = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: resourceMode, storedContent,
            recipientEnvelope: key && encryption ? { encryptedDataKey: encryptDataKeyForRecipientV0(key, encodeBase64(encryption.contentDataKey, 'base64')),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) } : null,
            entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship,
                ownerAccountId: relationship === 'owner' ? accountId : 'other-owner', name: content?.name ?? 'Key', kind: content?.kind ?? 'token', revision,
                materialStatus: 'ready', capabilities: { use: true, rename: relationship === 'owner', rotate: relationship === 'owner',
                    manageAccess: relationship === 'owner', delete: relationship === 'owner' } } }] }).resources[0]!;
        resources.set(resourceId, row);
        return row;
    }
    return { scope, writes, settingsWriteStacks, sourceReads, censusReads, catalogReadPaths, artifacts, rows, catalogRows, resources, materialRow,
        get raw() { return raw; }, set raw(value: Record<string, unknown>) { raw = value; },
        get settingsVersion() { return settingsVersion; }, set settingsVersion(value: number) { settingsVersion = value; },
        get referenceGuardRevision() { return referenceGuardRevision; }, set referenceGuardRevision(value: number) { referenceGuardRevision = value; },
        setProfileReadStatus(value: number) { profileReadStatus = value; },
        setMaterialReadStatus(value: number) { materialReadStatus = value; },
        setBeforeMaterialRead(value: (() => void | Promise<void>) | undefined) { beforeMaterialRead = value; },
        setBeforeProfileRead(value: (() => void) | undefined) { beforeProfileRead = value; },
        setBeforeHistoryRead(value: (() => void | Promise<void>) | undefined) { beforeHistoryRead = value; },
        readHistoryContent: () => historyContent,
        rotateServerContentKey() { serverCredentials = { ...serverCredentials, secret: encodeBase64(new Uint8Array(32).fill(25), 'base64url') }; },
        setPersistedMode(value: 'plain' | 'e2ee') { persistedMode = value; },
        setEffect(value: typeof effect) { effect = value; } };
}

describe('Saved Secret operations through their real Account and Action owners', () => {
    it.each(['stable', 'before-import', 'during-history'] as const)('pinned importer returns only its own acknowledged source frontier (%s)', async drift => {
        const secret = { id: 'pinned-source', name: 'Original key', kind: 'token' as const, createdAt: 1, updatedAt: 2,
            encryptedValue: { _isSecretValue: true as const, value: 'original-value' } };
        const account = await openAccount('plain', { raw: { secrets: [secret], originalCommand: 'original' } });
        const sourceExpectation = { mode: 'plain' as const, raw: structuredClone(account.raw), version: account.settingsVersion };
        if (drift === 'before-import') {
            account.raw = { ...account.raw, originalCommand: 'foreign' };
            account.settingsVersion += 1;
        }
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected Plain pinned source');
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            if (drift === 'during-history') account.setBeforeHistoryRead(() => {
                account.setBeforeHistoryRead(undefined);
                account.raw = { ...account.raw, originalCommand: 'foreign' };
                account.settingsVersion += 1;
            });
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        const result = await withProfileAccount(account.scope, undefined, (context, mode) =>
            importLegacySavedSecretsInContext(context, mode, account.scope, undefined, sourceExpectation));
        if (drift !== 'stable') {
            expect(result).toEqual({ status: 'pending', reason: 'changed' });
            expect(account.raw.originalCommand).toBe('foreign');
            expect(account.writes).toHaveLength(drift === 'before-import' ? 0 : 1);
            return;
        }
        const resourceRef = `happier:shared-secret:v1:${deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: secret.id } })}`;
        expect(result).toEqual({ status: 'complete', sourceSettingsVersion: 8,
            verifiedReferences: [{ source: { kind: 'personal-saved-secret', secretId: secret.id }, resourceRef, revision: 1 }] });
        expect(account.raw.originalCommand).toBe('original');
        expect(account.writes).toHaveLength(1);
    });
    it('private creation approval remains presented by the existing editor without replaying its Action', async () => {
        const account = await openAccount('plain', { ask: true });
        const onCreated = vi.fn();
        const screen = await renderScreen(React.createElement(PrivateSavedSecretCreateHarness, { scope: account.scope, onCreated }));
        await act(async () => {
            screen.findByTestId('saved-secret-create-name')!.props.onChangeText('Private key');
            screen.findByTestId('saved-secret-create-value')!.props.onChangeText('private-value');
        });
        await act(async () => { screen.findByTestId('saved-secret-create-submit')!.props.onPress(); });
        await vi.waitFor(() => expect(Boolean(screen.findByTestId('saved-secret-create-approval'))).toBe(true));
        expect(account.artifacts).toHaveLength(1);
        expect(account.writes).toEqual([]);
        expect(onCreated).not.toHaveBeenCalled();
        const artifact = account.artifacts[0]!;
        const body = decodePlainArtifactStoredContent(artifact.body!);
        if (!body || typeof body !== 'object') throw new Error('Expected actual Plain approval body');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(String(Reflect.get(body, 'body'))));
        if (request.v !== 2 || !request.actionArgs || typeof request.actionArgs !== 'object') throw new Error('Expected immutable create approval');
        const resourceId = Reflect.get(request.actionArgs, 'resourceId');
        if (typeof resourceId !== 'string') throw new Error('Expected the original resource identity');
        account.materialRow(resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Private key', kind: 'apiKey', value: 'private-value' } }), 1);
        const settledAt = request.createdAtMs + 1;
        const settled: ApprovalRequestV2 = { ...request, status: 'executed', updatedAtMs: settledAt,
            decision: { kind: 'approve', decidedAtMs: settledAt },
            execution: { ok: true, executedAtMs: settledAt, result: { resourceId, revision: 1 } } };
        // The canonical Artifact store receives the Home's terminal observation;
        // the real mounted reader/continuation must finish the original gesture.
        await act(async () => { storage.getState().updateArtifact({ id: artifact.id,
            header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled),
            title: null, headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2, isDecrypted: true }); });
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(`happier:shared-secret:v1:${resourceId}`, 'personal'));
        expect(account.artifacts).toHaveLength(1);
        expect(account.writes).toEqual([]);
    });
    it('compound catalog save creates every draft credential in one transaction despite unrelated Settings drift', async () => {
        const account = await openAccount('plain', { raw: { userNote: 'initial' } });
        const destination = '/v1/account/entity-rows/mcp';
        account.catalogRows.set(destination, { status: 'present', revision: 10, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } });
        // An unrelated locked/invalid domain is not part of this destination-only save.
        account.catalogRows.set('/v1/account/entity-rows/acp', { status: 'present', revision: 12,
            content: { t: 'plain', v: { v: 1, definitions: [{ unsupported: true }] } } });
        const drafts = ['draft-a', 'draft-b'].map(id => ({ id, name: id, kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: `value-${id}` }, createdAt: 1, updatedAt: 1 }));
        const candidate = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'imported-server', name: 'imported-server',
            transport: 'stdio', stdio: { command: 'server', args: [] }, env: {
                KEY_A: { t: 'savedSecret', secretId: drafts[0]!.id }, KEY_B: { t: 'savedSecret', secretId: drafts[1]!.id },
            }, createdAt: 1, updatedAt: 1 }], bindings: [] });
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one composite transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.expectedSettingsVersion !== undefined && input.expectedSettingsVersion !== account.settingsVersion) {
                return Response.json({ error: 'settings_conflict' }, { status: 409 });
            }
            const mutation = McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations?.mcp);
            for (const resource of [input, ...(input.additionalSavedSecretResources ?? [])]) {
                account.materialRow(resource.resourceId, 'plain', resource.storedContent, 1);
            }
            account.catalogRows.set(destination, { status: 'present', revision: 11, content: mutation.content });
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope, resources: drafts,
            catalogKeys: ['mcp'], mutateCatalogs: ({ resourceRefs, catalogRevisions }: Readonly<{
                resourceRefs: ReadonlyMap<string, string>; catalogRevisions: Partial<SavedSecretCatalogRevisionsV1>;
            }>) => {
                expect(catalogRevisions.mcp).toBe(10);
                account.raw = { ...account.raw, userNote: 'changed elsewhere' };
                account.settingsVersion += 1;
                return { catalogs: { mcp: remapMcpServerCatalogSavedSecretReferencesV1(candidate, Object.fromEntries(resourceRefs)) } };
            } });
        expect(result).toMatchObject({ ok: true });
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        const input = SharedSavedSecretPromoteInputV1Schema.parse(account.writes[0]?.body);
        expect(input).toMatchObject({ nextSettings: null, profileMutations: [],
            referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: { mcp: 10 } } });
        expect(input).not.toHaveProperty('expectedSettingsVersion');
        expect([input.resourceId, ...(input.additionalSavedSecretResources ?? []).map(resource => resource.resourceId)]).toEqual(drafts.map(draft => draft.id));
        expect(input.catalogMutations?.mcp).toMatchObject({ referencedSavedSecretIds: drafts.map(draft => `happier:shared-secret:v1:${draft.id}`),
            savedSecretRevisions: drafts.map(draft => ({ resourceId: draft.id, expectedRevision: 1 })) });
        expect(account.resources.size).toBe(2);
        expect(account.raw.userNote).toBe('changed elsewhere');
        expect(account.raw.secrets ?? []).toEqual([]);
    });
    it.each([{ conflict: false, previousShared: false, throughVoice: false, activeShared: false }, { conflict: true, previousShared: false, throughVoice: false, activeShared: false },
        { conflict: false, previousShared: true, throughVoice: false, activeShared: false },
        { conflict: false, previousShared: true, throughVoice: true, activeShared: false },
        { conflict: false, previousShared: true, throughVoice: true, activeShared: true }])('full reference credential save commits Voice, purpose and Profile bindings atomically (conflict: $conflict, previous shared: $previousShared, Voice entry: $throughVoice, active shared: $activeShared)', async ({ conflict, previousShared, throughVoice, activeShared }) => {
        const contribution = { pluginId: 'happier.voice.openai', localId: 'realtime-openai' };
        const declaration = VoiceProviderContributionSchema.parse({ id: contribution.localId, title: 'OpenAI Realtime',
            kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: false } },
            credentials: { slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                requirement: { kind: 'always' }, sources: [{ kind: 'savedSecret', secretKinds: ['apiKey'],
                    rawGrants: [{ realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders',
                        origin: 'https://api.openai.com', headerNames: ['authorization'] } }] },
                    { kind: 'connectedAccount', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }] },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' } });
        const oldSharedRef = 'happier:shared-secret:v1:revoked-old-voice-resource';
        const account = await openAccount('plain', { raw: normalizeVoiceSettingsServerDelta({ untouched: { preserve: true }, voiceSettingsV1: {
            providers: {}, credentialBindings: [{ contribution, credentialSlotId: 'api_key',
                credentialSource: { kind: previousShared ? 'savedSecret' : 'connectedAccount' },
                credentialBindings: { account: previousShared ? { api_key: oldSharedRef } : {} } }],
        } }) });
        if (activeShared) account.materialRow('revoked-old-voice-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'revoked-old-voice-resource', mode: 'plain',
            content: { v: 1, name: 'Existing Voice credential', kind: 'apiKey', value: 'existing-voice-value' },
        }), 4);
        const purposePath = '/v1/account/entity-rows/connected-accounts/purposes';
        const originalPurpose = { status: 'present', revision: 9, content: { t: 'plain', v: {
            key: 'purposes', value: { v: 1, bindings: [{ purpose: { consumer: contribution, purpose: 'voice.client-auth' },
                target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    accountId: 'existing-connected-account' } } }] },
        } } };
        account.catalogRows.set(purposePath, originalPurpose);
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'full-save-profile', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'full-save-profile', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: {} });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        const replacement = createAccountVoiceCredentialReplacementMutation({ settings: settingsParse(account.raw), contribution,
            credentialSlotId: 'api_key', value: 'new-voice-private-key', generateId: () => 'full-voice-draft', now: 10,
            expectedSecretId: previousShared ? oldSharedRef : null, expectedSecretUpdatedAt: null });
        const profileDraft = { id: 'full-profile-draft', name: 'Profile key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'new-profile-private-key' }, createdAt: 10, updatedAt: 10 };
        const before = account.raw;
        const requiredRecipientContractDigest = `sha256:${'a'.repeat(64)}`;
        let finalDigest = resolveAccountVoiceCredentialApprovalDigest({ requiredRecipientContractDigest,
            savedSecret: { kind: 'shared_resource', fingerprint: formatSavedSecretCatalogFingerprintV1({
                ref: 'happier:shared-secret:v1:full-voice-draft', source: 'shared_resource', revision: 1,
            })! } });
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one full resource transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (conflict || input.expectedSettingsVersion !== account.settingsVersion) return Response.json({ error: 'settings_conflict' }, { status: 409 });
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected canonical prepared Settings');
            const purpose = ConnectedAccountCatalogRowMutationV1Schema.parse(input.catalogMutations?.connectedPurposes);
            for (const resource of [input, ...(input.additionalSavedSecretResources ?? [])]) account.materialRow(resource.resourceId, 'plain', resource.storedContent, 1);
            account.raw = input.nextSettings.v;
            account.settingsVersion = 23;
            account.catalogRows.set(purposePath, { status: 'present', revision: 10, content: purpose.content });
            for (const mutation of input.profileMutations) {
                if (mutation.content?.t !== 'plain') throw new Error('Expected canonical prepared Profile');
                const index = account.rows.findIndex(row => row.id === mutation.id);
                account.rows[index] = { id: mutation.id, revision: 3, content: mutation.content };
            }
            return Response.json({ resourceId: input.resourceId, settingsVersion: 23 });
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = throughVoice ? await mutateScopedAccountVoiceCredentialSource({ scope: account.scope,
            mutation: { contribution, credentialSlotId: 'api_key', expectedSettingsVersion: 7,
                selection: { kind: 'savedSecret' },
                savedSecretMutation: { ...replacement.mutation, approvedRecipientContractDigest: requiredRecipientContractDigest } },
            requiredRecipientContractDigest,
            expectedDeclaration: declaration, resolveCurrentDeclaration: () => declaration,
        }) : await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            resources: [replacement.mutation.secret, profileDraft], referenceScope: 'full',
            mutateCatalogs: ({ rawSettings, settingsVersion, catalogs, resourceFingerprints }: Readonly<{
                rawSettings: Readonly<Record<string, unknown>>; settingsVersion: number; catalogs: SavedSecretReferenceCatalogsV1;
                resourceFingerprints: ReadonlyMap<string, string>;
            }>) => {
                finalDigest = resolveAccountVoiceCredentialApprovalDigest({ requiredRecipientContractDigest,
                    savedSecret: { kind: 'shared_resource', fingerprint: resourceFingerprints.get(replacement.secretId)! } });
                if (!finalDigest) throw new Error('Expected the final shared-resource approval digest');
                const candidate = applySavedSecretCatalogVoiceCredentialSourceMutationV1(rawSettings, { contribution,
                    credentialSlotId: 'api_key', expectedSettingsVersion: settingsVersion, selection: { kind: 'savedSecret' },
                    savedSecretMutation: { ...replacement.mutation, approvedRecipientContractDigest: finalDigest },
                }, declaration, catalogs);
                return { settings: { ...candidate.settings, secrets: [...settingsParse(candidate.settings).secrets, profileDraft] },
                    catalogs: { ...catalogs, connectedPurposes: candidate.connectedPurposes,
                        profileRecords: catalogs.profileRecords.map(current => current.id === record.id
                            ? { ...current, secretBindings: { TOKEN: profileDraft.id } } : current) } };
            } });
        if (conflict) {
            expect(account.raw).toEqual(before);
            expect(account.resources.size).toBe(0);
            expect(account.catalogRows.get(purposePath)).toEqual(originalPurpose);
            expect(account.rows[0]).toMatchObject({ revision: 2, content: { v: { secretBindings: {} } } });
        }
        expect(result).toMatchObject(throughVoice ? { status: 'applied', settingsVersion: 23, selection: { kind: 'savedSecret' } }
            : conflict ? { ok: false, reason: 'changed' } : { ok: true, settingsVersion: 23 });
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        const input = SharedSavedSecretPromoteInputV1Schema.parse(account.writes[0]?.body);
        expect(input).toMatchObject({ expectedSettingsVersion: 7, referenceCensus: { accountMode: 'plain',
            profiles: { referenceGuardRevision: 3, rows: [{ id: record.id, revision: 2 }] },
            catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent', connectedPurposes: 9 },
            remoteHosts: { revision: 'absent', resourceRefs: [] } },
            nextSettings: { t: 'plain', v: { secrets: [], untouched: { preserve: true }, voiceSettingsV1: {
                credentialBindings: [{ credentialSource: { kind: 'savedSecret' },
                    credentialBindings: { account: { api_key: 'happier:shared-secret:v1:full-voice-draft' } },
                    approvedRecipientContractDigest: finalDigest }],
            } } }, additionalSavedSecretResources: throughVoice ? [] : [{ resourceId: profileDraft.id }],
            profileMutations: throughVoice ? [] : [{ id: record.id, expectedRevision: 2, content: { t: 'plain', v: {
                secretBindings: { TOKEN: 'happier:shared-secret:v1:full-profile-draft' },
            } } }], catalogMutations: { connectedPurposes: { expectedRevision: 9, content: { t: 'plain', v: {
                key: 'purposes', value: { v: 1, bindings: [] },
            } } } } });
        if (!conflict) {
            expect(account.resources.size).toBe((throughVoice ? 1 : 2) + (activeShared ? 1 : 0));
            if (activeShared) expect(account.resources.get('revoked-old-voice-resource')).toMatchObject({ entry: { revision: 4 } });
            expect(account.raw.secrets).toEqual([]);
            expect(account.catalogRows.get(purposePath)).toMatchObject({ revision: 10, content: { v: { value: { bindings: [] } } } });
            expect(account.rows[0]).toMatchObject(throughVoice ? { revision: 2, content: { v: { secretBindings: {} } } }
                : { revision: 3, content: { v: { secretBindings: { TOKEN: 'happier:shared-secret:v1:full-profile-draft' } } } });
        }
    });
    it('full reference credential save refuses a changed original source before any resource or row write', async () => {
        const account = await openAccount('plain', { raw: { untouched: 'original' } });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'full-source-profile', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'full-source-profile', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: {} });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        const draft = { id: 'full-source-draft', name: 'Profile key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-profile-key' }, createdAt: 10, updatedAt: 10 };
        const originalSource = { rawSettings: account.raw, settingsVersion: account.settingsVersion };
        account.raw = { ...account.raw, untouched: 'changed elsewhere' };
        account.settingsVersion = 8;
        const changedSettings = account.raw;
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected only a full transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.expectedSettingsVersion !== account.settingsVersion) return Response.json({ error: 'settings_conflict' }, { status: 409 });
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected canonical prepared Settings');
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            account.raw = input.nextSettings.v;
            account.settingsVersion = 23;
            return Response.json({ resourceId: input.resourceId, settingsVersion: 23 });
        });
        const params = { scope: account.scope, resources: [draft], referenceScope: 'full' as const, originalSource,
            mutateCatalogs: ({ rawSettings, catalogs }: Readonly<{ rawSettings: Readonly<Record<string, unknown>>;
                catalogs: SavedSecretReferenceCatalogsV1 }>) => ({ settings: { ...rawSettings, secrets: [draft] },
                catalogs: { ...catalogs, profileRecords: catalogs.profileRecords.map(current => current.id === record.id
                    ? { ...current, secretBindings: { TOKEN: draft.id } } : current) } }),
        };
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        expect(await createSavedSecretResourcesWithCatalogMutation(params)).toMatchObject({ ok: false, reason: 'changed' });
        expect(account.writes).toEqual([]);
        expect(account.resources.size).toBe(0);
        expect(account.raw).toEqual(changedSettings);
        expect(account.settingsVersion).toBe(8);
        expect(account.rows[0]).toMatchObject({ revision: 2, content: { v: { secretBindings: {} } } });
    });
    it('full reference credential save refuses an invalid notification reference facet before creating its resource', async () => {
        const account = await openAccount('plain');
        const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
            v: 1, id: 'notification-webhook', kind: 'webhook', url: 'https://notifications.example.test/hook',
            topics: {}, signingSecretRef: null,
        }] });
        const content = sealNotificationChannelCatalogContentV1({ record, mode: 'plain', material: null });
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 12, content });
        const draft = { id: 'unprepared-notification-draft', name: 'Signing key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'new-signing-key' }, createdAt: 10, updatedAt: 10 };
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected only the full transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected canonical Plain Settings');
            account.raw = input.nextSettings.v;
            account.settingsVersion = 23;
            return Response.json({ resourceId: input.resourceId, settingsVersion: 23 });
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            referenceScope: 'full', resources: [draft],
            mutateCatalogs: ({ rawSettings, catalogs, resourceRefs }) => ({
                settings: { ...rawSettings, secrets: [draft] },
                catalogs: { ...catalogs, notificationChannels: { ...record,
                    channels: record.channels.map(channel => channel.kind === 'webhook'
                        ? { ...channel, signingSecretRef: resourceRefs.get(draft.id)!,
                            futureCredentialRef: { t: 'savedSecret', secretId: resourceRefs.get(draft.id)! } } : channel) } },
            }),
        });
        expect(result).toEqual({ ok: false, reason: 'unavailable' });
        expect(account.resources.size).toBe(0);
        expect(account.catalogRows.get(NOTIFICATION_CHANNELS_ROUTE_V1)).toEqual({ status: 'present', revision: 12, content });
        expect(account.writes).toEqual([]);
    });
    it.each([{ mode: 'plain', staleTarget: false }, { mode: 'plain', staleTarget: true },
        { mode: 'e2ee', staleTarget: false }, { mode: 'e2ee', staleTarget: true }] as const)(
        'full reference credential save commits a notification signing resource atomically ($mode, stale target: $staleTarget)', async ({ mode, staleTarget }) => {
        const account = await openAccount(mode);
        const capturedCrypto = await withProfileAccount(account.scope, undefined, async (context, accountMode, material) => ({
            accountMode, material, encryption: (await context.resolveAccountEncryption()).encryption,
        }));
        const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
            v: 1, id: 'notification-webhook', kind: 'webhook', url: 'https://notifications.example.test/hook',
            topics: {}, signingSecretRef: null,
        }] });
        const content = sealNotificationChannelCatalogContentV1({ record, mode: capturedCrypto.accountMode, material: capturedCrypto.material });
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 12, content });
        const originalSettings = account.raw;
        const draft = { id: 'notification-signing-draft', name: 'Signing key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'new-signing-key' }, createdAt: 10, updatedAt: 10 };
        const ref = `happier:shared-secret:v1:${draft.id}`;
        account.setEffect(async (path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one outer resource transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            const notification = NotificationChannelCatalogMutationV1Schema.parse(input.notificationChannelMutation);
            expect(notification.expectedRevision).toBe(12);
            expect(notification.savedSecretRevisions).toEqual([{ resourceRef: ref, revision: 1 }]);
            expect(notification.settingsMutation).toBeUndefined();
            expect(input.referenceCensus.notificationChannels).toEqual({ revision: 12, resourceRefs: [] });
            expect(input.encryptionMode).toBe(mode);
            expect(notification.content?.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
            expect(input.nextSettings).toBeNull();
            expect(openNotificationChannelCatalogContentV1({ content: notification.content,
                mode: capturedCrypto.accountMode, material: capturedCrypto.material })).toMatchObject({ status: 'opened',
                record: { channels: [{ signingSecretRef: ref }] } });
            if (mode === 'e2ee') expect(JSON.stringify(input)).not.toContain('new-signing-key');
            if (staleTarget) account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 13, content });
            const currentRow = account.catalogRows.get(NOTIFICATION_CHANNELS_ROUTE_V1);
            // The real HTTP boundary enforces row CAS before any resource or Settings mutation.
            if (!currentRow || typeof currentRow !== 'object' || !('revision' in currentRow)
                || currentRow.revision !== notification.expectedRevision) return Response.json({ error: 'references_conflict' }, { status: 409 });
            if (input.expectedSettingsVersion !== account.settingsVersion) return Response.json({ error: 'settings_conflict' }, { status: 409 });
            const envelope = input.keyEnvelopes?.find(value => value.recipientAccountId === account.scope.accountId);
            const key = envelope && capturedCrypto.encryption
                ? await capturedCrypto.encryption.decryptEncryptionKey(envelope.encryptedDataKey, account.scope) : null;
            if (mode === 'e2ee' && !key) throw new Error('Expected an authenticated owner resource envelope');
            account.materialRow(input.resourceId, mode, input.storedContent, 1, key ?? undefined);
            account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 13, content: notification.content });
            return Response.json({ resourceId: input.resourceId, settingsVersion: 7, notificationChannelRevision: 13 });
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            referenceScope: 'full', resources: [draft], mutateCatalogs: ({ rawSettings, catalogs, resourceRefs }) => ({
                settings: rawSettings,
                catalogs: { ...catalogs, notificationChannels: NotificationChannelCatalogRecordV1Schema.parse({ ...record,
                    channels: record.channels.map(channel => channel.kind === 'webhook'
                        ? { ...channel, signingSecretRef: resourceRefs.get(draft.id)! } : channel) }) },
            }),
        });
        if (staleTarget) {
            expect(account.resources.size).toBe(0);
            expect(account.raw).toEqual(originalSettings);
            expect(account.settingsVersion).toBe(7);
            expect(account.catalogRows.get(NOTIFICATION_CHANNELS_ROUTE_V1)).toEqual({ status: 'present', revision: 13, content });
            expect(result).toMatchObject({ ok: false });
        } else {
            expect(result).toMatchObject({ ok: true, settingsVersion: 7 });
            expect(account.resources.size).toBe(1);
            expect(account.raw).toEqual(originalSettings);
            expect(account.settingsVersion).toBe(7);
            const captured = await withProfileAccount(account.scope, undefined, (context, accountMode) =>
                captureSavedSecretReferenceStateInContext(context, accountMode));
            expect(captured).toMatchObject({ ok: true, catalogs: { notificationChannels: { channels: [{ signingSecretRef: ref }] } },
                referenceCensus: { notificationChannels: { revision: 13, resourceRefs: [ref] } } });
            expect(await withProfileAccount(account.scope, undefined, context => readSavedSecretReferenceInContext(context, ref)))
                .toEqual({ ok: true, value: 'new-signing-key', revision: 1 });
        }
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
    });
    it.each([true, false])('signed notification source initialization safely reuses a preexisting deterministic Resource (exact: %s)', async exact => {
        const sourceValue = ' preexisting signing source\n ';
        const account = await openAccount('plain', { raw: {
            notificationChannelsV1: [{ v: 1, id: 'preexisting-signing-webhook', kind: 'webhook', enabled: true,
                url: 'https://notifications.example.test/preexisting', topics: {},
                readyIncludeMessageText: false, requestIncludeMessageText: false,
                signingSecret: { _isSecretValue: true, value: sourceValue } }],
            futurePreference: { preserve: 'opaque sibling' },
        } });
        const sourceRaw = account.raw;
        const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: account.scope.accountId,
            raw: sourceRaw, settingsSecretsReadKeys: [] });
        if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 1)
            throw new Error('Expected one genuine signed predecessor channel');
        const signing = prepared.signingSecrets[0]!;
        const channel = prepared.record.channels.find(row => row.kind === 'webhook');
        if (!channel || channel.kind !== 'webhook' || channel.signingSecretRef === null)
            throw new Error('Expected the canonical deterministic Resource reference');
        const existingMaterial = account.materialRow(signing.resourceId, 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: signing.resourceId, mode: 'plain', content: {
                v: 1, name: signing.displayName, kind: signing.kind, value: exact ? sourceValue : 'different existing material',
            },
        }), 9);
        account.setEffect((path, body) => {
            if (path !== NOTIFICATION_CHANNELS_ROUTE_V1)
                throw new Error('Existing deterministic Resources must not be created or overwritten');
            const mutation = NotificationChannelCatalogMutationV1Schema.parse(body);
            expect(mutation).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7,
                savedSecretRevisions: [{ resourceRef: channel.signingSecretRef, revision: 9 }] });
            expect(mutation.settingsMutation).toBeUndefined();
            expect(mutation.content).toEqual({ t: 'plain', v: prepared.record });
            if (account.catalogRows.has(NOTIFICATION_CHANNELS_ROUTE_V1))
                return Response.json({ status: 'conflict', revision: 1 });
            if (account.settingsVersion !== mutation.sourceSettingsVersion)
                return Response.json({ status: 'settings-conflict', revision: 0 });
            if (account.resources.get(signing.resourceId)?.entry.revision !== 9)
                return Response.json({ status: 'references-conflict' });
            account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, {
                status: 'present', revision: 1, content: mutation.content,
            });
            return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        });
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const projection = await readNotificationChannelCatalogProjectionInContext(context);
            if (exact) {
                expect(projection.catalog).toMatchObject({ status: 'ready', revision: 1, channels: prepared.record.channels });
                expect(account.writes.filter(write => write.path === NOTIFICATION_CHANNELS_ROUTE_V1)).toHaveLength(1);
                expect(account.raw.futurePreference).toEqual({ preserve: 'opaque sibling' });
            } else {
                expect(projection.catalog.status).not.toBe('ready');
                expect(account.catalogRows.has(NOTIFICATION_CHANNELS_ROUTE_V1)).toBe(false);
                expect(account.raw).toEqual(sourceRaw);
                expect(account.settingsVersion).toBe(7);
                expect(account.writes).toEqual([]);
            }
            expect(account.resources.size).toBe(1);
            expect(account.resources.get(signing.resourceId)).toBe(existingMaterial);
            expect(account.writes.filter(write => write.path.startsWith('/v1/account/saved-secrets/'))).toEqual([]);
        } finally { context.dispose(); }
    });
    it('preserves a mixed signed notification source when its proved existing Resource rotates before full transaction preparation', async () => {
        const sourceChannel = (id: string, value: string) => ({ v: 1, id, kind: 'webhook', enabled: true,
            url: `https://notifications.example.test/${id}`, topics: {}, readyIncludeMessageText: false,
            requestIncludeMessageText: false, signingSecret: { _isSecretValue: true, value } });
        const account = await openAccount('plain', { raw: {
            notificationChannelsV1: [sourceChannel('retained-key', 'exact retained source bytes'),
                sourceChannel('fresh-key', 'exact new source bytes')], futurePreference: { preserve: true },
        } });
        const sourceRaw = account.raw;
        const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: account.scope.accountId,
            raw: sourceRaw, settingsSecretsReadKeys: [] });
        if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 2)
            throw new Error('Expected two genuine signed predecessor bindings');
        const retained = prepared.signingSecrets[0]!;
        const fresh = prepared.signingSecrets[1]!;
        const sealRetained = (value: string) => sealSavedSecretResourceStoredContentV1({ resourceId: retained.resourceId,
            mode: 'plain', content: { v: 1, name: retained.displayName, kind: retained.kind, value } });
        account.materialRow(retained.resourceId, 'plain', sealRetained(retained.value), 9);
        let materialReads = 0;
        let rotated = false;
        account.setBeforeMaterialRead(() => { materialReads += 1; });
        account.setBeforeProfileRead(() => {
            // Metadata and the genuine opener establish the API's revision-9
            // proof before the full owner's independent Profile census begins.
            // This boundary remains reachable when packet preparation reuses
            // the captured proof instead of reopening Resource material.
            if (!rotated && materialReads >= 2) {
                rotated = true;
                account.materialRow(retained.resourceId, 'plain', sealRetained('rotated different bytes'), 10);
            }
        });
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])
                throw new Error('Expected the same full Resource transaction owner');
            const packet = SharedSavedSecretPromoteInputV1Schema.parse(body);
            const notification = NotificationChannelCatalogMutationV1Schema.parse(packet.notificationChannelMutation);
            const retainedProof = notification.savedSecretRevisions.find(proof => proof.resourceRef === `happier:shared-secret:v1:${retained.resourceId}`);
            const currentRetained = account.resources.get(retained.resourceId);
            if (!currentRetained || !('resourceId' in currentRetained)) throw new Error('Expected the stored retained Resource');
            if (retainedProof?.revision !== currentRetained.entry.revision)
                return Response.json({ error: 'references_conflict' }, { status: 409 });
            // A writer that silently adopts revision 10 would admit the wrong
            // signing material. Exercise that real storage outcome, not a spy.
            account.materialRow(packet.resourceId, 'plain', packet.storedContent, 1);
            account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 1, content: notification.content });
            return Response.json({ resourceId: packet.resourceId, settingsVersion: account.settingsVersion });
        });
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const projection = await readNotificationChannelCatalogProjectionInContext(context);
            expect(rotated).toBe(true);
            expect(projection.catalog.status).not.toBe('ready');
            expect(account.catalogRows.has(NOTIFICATION_CHANNELS_ROUTE_V1)).toBe(false);
            expect(account.resources.has(fresh.resourceId)).toBe(false);
            expect(account.resources.get(retained.resourceId)).toMatchObject({ entry: { revision: 10 } });
            expect(account.raw).toEqual(sourceRaw);
            expect(account.settingsVersion).toBe(7);
        } finally { context.dispose(); }
    });
    it.each([true, false])('signed notification source cleanup requires exact owned Resource material (exact: %s)', async exact => {
        const sourceValue = ' exact source signing key\n ';
        const sourceChannel = { v: 1, id: 'signed-cleanup-webhook', kind: 'webhook', enabled: true,
            url: 'https://notifications.example.test/cleanup', topics: {},
            readyIncludeMessageText: false, requestIncludeMessageText: false,
            signingSecret: { _isSecretValue: true, value: sourceValue } };
        const account = await openAccount('plain', { raw: {
            notificationChannelsV1: [sourceChannel],
            futurePreference: { preserve: 'opaque sibling' },
        }, historySnapshot: { notificationChannelsV1: [sourceChannel], preferredLanguage: 'de' } });
        const sourceRaw = account.raw;
        const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: account.scope.accountId,
            raw: sourceRaw, settingsSecretsReadKeys: [] });
        if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 1)
            throw new Error('Expected one genuine signed predecessor channel');
        const signing = prepared.signingSecrets[0]!;
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, {
            status: 'present', revision: 12, content: { t: 'plain', v: prepared.record },
        });
        account.materialRow(signing.resourceId, 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: signing.resourceId, mode: 'plain', content: {
                v: 1, name: signing.displayName, kind: signing.kind, value: exact ? sourceValue : 'rotated current signing key',
            },
        }), 3);
        account.setEffect(() => { throw new Error('Existing Resource proof must not create or overwrite material'); });
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const projection = await readNotificationChannelCatalogProjectionInContext(context);
            expect(projection.catalog).toMatchObject({ status: 'ready', revision: 12, channels: prepared.record.channels,
                cleanup: { status: exact ? 'complete' : 'cleanup-pending' } });
            expect(account.raw.futurePreference).toEqual({ preserve: 'opaque sibling' });
            if (exact) {
                expect(account.raw).not.toHaveProperty('notificationChannelsV1');
                expect(account.settingsVersion).toBe(8);
                expect(account.readHistoryContent()).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
            } else {
                expect(account.raw).toEqual(sourceRaw);
                expect(account.settingsVersion).toBe(7);
                expect(account.readHistoryContent()).toMatchObject({ t: 'plain', v: { notificationChannelsV1: [sourceChannel] } });
            }
            expect(account.writes.filter(write => write.path === '/v2/account/settings/history/4/mutate')).toHaveLength(exact ? 1 : 0);
            expect(account.writes.filter(write => write.path !== '/v2/account/settings'
                && write.path !== '/v2/account/settings/history/4/mutate')).toEqual([]);
            expect(account.resources.get(signing.resourceId)?.entry.revision).toBe(3);
        } finally { context.dispose(); }
    });
    it('retries signed notification history cleanup after the current source was purged without losing exact Resource proof', async () => {
        const signedChannel = { v: 1, id: 'signed-history-retry', kind: 'webhook', enabled: true,
            url: 'https://notifications.example.test/history-retry', topics: {}, readyIncludeMessageText: false,
            requestIncludeMessageText: false, signingSecret: { _isSecretValue: true, value: ' exact retained historical bytes\n' } };
        const account = await openAccount('plain', {
            raw: { notificationChannelsV1: [signedChannel], futurePreference: { preserve: 'current sibling' } },
            historySnapshot: { notificationChannelsV1: [signedChannel], preferredLanguage: 'de' },
        });
        const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: account.scope.accountId,
            raw: account.raw, settingsSecretsReadKeys: [] });
        if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 1) throw new Error('Expected genuine signed source');
        const signing = prepared.signingSecrets[0]!;
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 12,
            content: { t: 'plain', v: prepared.record } });
        account.materialRow(signing.resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId: signing.resourceId,
            mode: 'plain', content: { v: 1, name: signing.displayName, kind: signing.kind, value: signing.value } }), 3);
        account.setBeforeHistoryRead(() => {
            account.setBeforeHistoryRead(undefined);
            throw new TypeError('History transport temporarily offline after source cleanup');
        });
        account.setEffect(() => { throw new Error('History retries must not create or overwrite Resources'); });
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const initial = await readNotificationChannelCatalogProjectionInContext(context);
            expect(initial.catalog).toMatchObject({ status: 'ready', cleanup: { status: 'cleanup-pending' } });
            expect(account.raw).not.toHaveProperty('notificationChannelsV1');
            expect(account.settingsVersion).toBe(8);
            expect(account.readHistoryContent()).toMatchObject({ t: 'plain', v: { notificationChannelsV1: [signedChannel] } });
            const retry = await readNotificationChannelCatalogProjectionInContext(context);
            expect(retry.catalog).toMatchObject({ status: 'ready', cleanup: { status: 'complete' } });
            expect(account.readHistoryContent()).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
            expect(account.raw.futurePreference).toEqual({ preserve: 'current sibling' });
            expect(account.settingsVersion).toBe(8);
            expect(account.writes.filter(write => write.path === '/v2/account/settings')).toHaveLength(1);
            expect(account.writes.filter(write => write.path === '/v2/account/settings/history/4/mutate')).toHaveLength(1);
            expect(account.writes.filter(write => write.path.startsWith('/v1/account/saved-secrets/'))).toEqual([]);
        } finally { context.dispose(); }
    });
    it('initializes an E2EE signed notification source using the canonical enc-v1 key resolver and full Resource transaction', async () => {
        const account = await openAccount('e2ee');
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const keys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope: account.scope });
            if (!keys) throw new Error('Expected genuine E2EE Settings-secret keys');
            const exactValue = '  encrypted signing source\nwith exact bytes\t ';
            const channel = sealSecretsDeep({ v: 1, id: 'signed-e2ee-source', kind: 'webhook', enabled: true,
                url: 'https://notifications.example.test/e2ee-source', topics: {}, readyIncludeMessageText: false,
                requestIncludeMessageText: false, signingSecret: { _isSecretValue: true, value: exactValue } }, keys.writeKey);
            expect(channel.signingSecret).toMatchObject({ encryptedValue: { t: 'enc-v1' } });
            expect(JSON.stringify(channel)).not.toContain(exactValue);
            account.raw = { ...account.raw, notificationChannelsV1: [channel], futurePreference: { preserve: 'encrypted sibling' } };
            const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: account.scope.accountId,
                raw: account.raw, settingsSecretsReadKeys: keys.readKeys });
            if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 1) throw new Error('Expected genuinely openable enc-v1 source');
            const signing = prepared.signingSecrets[0]!;
            const { accountMode, encryption } = await context.resolveAccountEncryption();
            const material = resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
            if (accountMode !== 'e2ee' || !encryption || !material) throw new Error('Expected captured E2EE Account material');
            account.setEffect(async (path, body) => {
                if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])
                    throw new Error('E2EE source initialization must use the same full Resource owner');
                const packet = SharedSavedSecretPromoteInputV1Schema.parse(body);
                const notification = NotificationChannelCatalogMutationV1Schema.parse(packet.notificationChannelMutation);
                expect(packet.resourceId).toBe(signing.resourceId);
                expect(packet.encryptionMode).toBe('e2ee');
                expect(packet.storedContent.t).toBe('encrypted');
                expect(notification.content?.t).toBe('encrypted');
                expect(packet.nextSettings).toBeNull();
                expect(packet.expectedSettingsVersion).toBe(7);
                expect(notification).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7 });
                expect(JSON.stringify(packet)).not.toContain(exactValue);
                expect(JSON.stringify(packet)).not.toContain('signingSecret"');
                expect(openNotificationChannelCatalogContentV1({ mode: accountMode, material, content: notification.content }))
                    .toMatchObject({ status: 'opened', record: prepared.record });
                const envelope = packet.keyEnvelopes?.find(row => row.recipientAccountId === account.scope.accountId);
                const key = envelope ? await encryption.decryptEncryptionKey(envelope.encryptedDataKey, account.scope) : null;
                if (!key) throw new Error('Expected the genuine owner Resource envelope');
                expect(openSavedSecretResourceStoredContentV1({ resourceId: packet.resourceId, mode: 'e2ee',
                    storedContent: packet.storedContent, resourceDataKey: key })?.value).toBe(exactValue);
                if (packet.expectedSettingsVersion !== account.settingsVersion || account.catalogRows.has(NOTIFICATION_CHANNELS_ROUTE_V1))
                    return Response.json({ error: 'references_conflict' }, { status: 409 });
                account.materialRow(packet.resourceId, 'e2ee', packet.storedContent, 1, key);
                account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 1, content: notification.content });
                return Response.json({ resourceId: packet.resourceId, settingsVersion: account.settingsVersion });
            });
            const projection = await readNotificationChannelCatalogProjectionInContext(context);
            expect(projection.catalog).toMatchObject({ status: 'ready', revision: 1, channels: prepared.record.channels });
            expect(await readSavedSecretReferenceInContext(context, `happier:shared-secret:v1:${signing.resourceId}`))
                .toEqual({ ok: true, value: exactValue, revision: 1 });
            expect(account.writes.filter(write => write.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])).toHaveLength(1);
            expect(account.raw.futurePreference).toEqual({ preserve: 'encrypted sibling' });
        } finally { context.dispose(); }
    });
    it.each([false, true])('signed notification source initialization uses the full Resource transaction (lost ACK: %s)', async lostAck => {
        const exactValue = '  signing-key\nwith exact bytes\t ';
        const account = await openAccount('plain', { raw: {
            notificationChannelsV1: [{ v: 1, id: 'signed-source-webhook', kind: 'webhook',
                enabled: true, url: 'https://notifications.example.test/import',
                topics: { ready: true, permissionRequest: false, userActionRequest: true },
                readyIncludeMessageText: false, requestIncludeMessageText: false,
                signingSecret: { _isSecretValue: true, value: exactValue } }],
            futurePreference: { preserve: 'opaque sibling' },
        } });
        const prepared = prepareLegacyNotificationChannelCatalogV1({
            accountId: account.scope.accountId, raw: account.raw, settingsSecretsReadKeys: [],
        });
        if (prepared.status !== 'ready' || prepared.signingSecrets.length !== 1)
            throw new Error('Expected a genuinely readable signed predecessor source');
        const signing = prepared.signingSecrets[0]!;
        const signingChannel = prepared.record.channels.find(channel => channel.kind === 'webhook');
        if (!signingChannel || signingChannel.kind !== 'webhook' || signingChannel.signingSecretRef === null)
            throw new Error('Expected the canonical prepared Resource reference');
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])
                throw new Error('Signed source initialization must use the captured full Resource owner');
            const packet = SharedSavedSecretPromoteInputV1Schema.parse(body);
            const notification = NotificationChannelCatalogMutationV1Schema.parse(packet.notificationChannelMutation);
            expect(packet.resourceId).toBe(signing.resourceId);
            expect(packet.nextSettings).toBeNull();
            expect(packet.expectedSettingsVersion).toBe(7);
            expect(account.settingsVersion).toBe(7);
            expect(notification).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7 });
            expect(notification.settingsMutation).toBeUndefined();
            expect(notification.content).toEqual({ t: 'plain', v: prepared.record });
            if (packet.expectedSettingsVersion !== account.settingsVersion)
                return Response.json({ error: 'settings_conflict' }, { status: 409 });
            if (account.catalogRows.has(NOTIFICATION_CHANNELS_ROUTE_V1))
                return Response.json({ error: 'references_conflict' }, { status: 409 });
            const content = openSavedSecretResourceStoredContentV1({
                resourceId: packet.resourceId, mode: 'plain', storedContent: packet.storedContent,
            });
            expect(content?.value).toBe(exactValue);
            // This is the real HTTP storage boundary: admit both before persisting
            // either, without staging a Resource or issuing a Settings mutation.
            account.materialRow(packet.resourceId, 'plain', packet.storedContent, 1);
            account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, {
                status: 'present', revision: 1, content: notification.content,
            });
            if (lostAck) throw new TypeError('Network response lost after atomic admission');
            // The existing S2 receipt has no notification cursor. Do not invent one.
            return Response.json({ resourceId: packet.resourceId, settingsVersion: account.settingsVersion });
        });
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const projection = await readNotificationChannelCatalogProjectionInContext(context);
            expect(projection.catalog).toMatchObject({ status: 'ready', revision: 1, channels: prepared.record.channels });
            expect(account.writes.filter(write => write.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']))
                .toHaveLength(1);
            expect(account.resources.size).toBe(1);
            expect(await readSavedSecretReferenceInContext(context, signingChannel.signingSecretRef))
                .toEqual({ ok: true, value: exactValue, revision: 1 });
            expect(account.raw.futurePreference).toEqual({ preserve: 'opaque sibling' });
        } finally { context.dispose(); }
    });
    it.each([{ mode: 'plain', staleTarget: false }, { mode: 'e2ee', staleTarget: false },
        { mode: 'plain', staleTarget: true }] as const)(
        'full reference credential save commits an SSH password resource atomically ($mode, stale target: $staleTarget)', async ({ mode, staleTarget }) => {
        const account = await openAccount(mode);
        const capturedCrypto = await withProfileAccount(account.scope, undefined, async (context, accountMode, material) => ({
            accountMode, material, encryption: (await context.resolveAccountEncryption()).encryption,
        }));
        const record = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{
            id: 'atomic-ssh-host', name: 'SSH host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
            ssh: { target: 'user@host.example.test', authMode: 'password', passwordSecretRef: null },
        }] });
        const content = sealRemoteHostCatalogContentV1({ record, mode: capturedCrypto.accountMode, material: capturedCrypto.material });
        account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 14, content });
        const originalSettings = account.raw;
        const draft = { id: 'atomic-ssh-password', name: 'SSH password', kind: 'password' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'new-ssh-password' }, createdAt: 10, updatedAt: 10 };
        const ref = `happier:shared-secret:v1:${draft.id}`;
        account.setEffect(async (path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one outer resource transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            const remoteHost = RemoteHostCatalogRowMutationV1Schema.parse(input.remoteHostMutation);
            expect(remoteHost.expectedRevision).toBe(14);
            expect(remoteHost.referencedSavedSecretRevisions).toEqual([{ resourceId: draft.id, revision: 1 }]);
            expect(input.nextSettings).toBeNull();
            expect(input.referenceCensus.remoteHosts).toEqual({ revision: 14, resourceRefs: [] });
            expect(openRemoteHostCatalogContentV1({ content: remoteHost.content,
                mode: capturedCrypto.accountMode, material: capturedCrypto.material })).toMatchObject({ status: 'ready',
                hosts: [{ ssh: { passwordSecretRef: ref } }] });
            if (mode === 'e2ee') expect(JSON.stringify(input)).not.toContain('new-ssh-password');
            if (staleTarget) account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 15, content });
            const currentRow = account.catalogRows.get(REMOTE_HOST_ROWS_ROUTE_V1);
            // The HTTP boundary refuses the stale row before publishing resources or Settings.
            if (!currentRow || typeof currentRow !== 'object' || !('revision' in currentRow)
                || currentRow.revision !== remoteHost.expectedRevision) return Response.json({ error: 'references_conflict' }, { status: 409 });
            const envelope = input.keyEnvelopes?.find(value => value.recipientAccountId === account.scope.accountId);
            const key = envelope && capturedCrypto.encryption
                ? await capturedCrypto.encryption.decryptEncryptionKey(envelope.encryptedDataKey, account.scope) : null;
            if (mode === 'e2ee' && !key) throw new Error('Expected authenticated owner resource envelope');
            account.materialRow(input.resourceId, mode, input.storedContent, 1, key ?? undefined);
            account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 15, content: remoteHost.content });
            return Response.json({ resourceId: input.resourceId, settingsVersion: 7, remoteHostRevision: 15 });
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            referenceScope: 'full', resources: [draft], mutateCatalogs: ({ rawSettings, catalogs, resourceRefs }) => ({
                settings: rawSettings,
                catalogs: { ...catalogs, remoteHostRecords: record.hosts.map(host => ({ ...host,
                    ssh: { ...host.ssh, passwordSecretRef: resourceRefs.get(draft.id)! } })) },
            }),
        });
        if (staleTarget) {
            expect(result).toMatchObject({ ok: false });
            expect(account.resources.size).toBe(0);
            expect(account.raw).toEqual(originalSettings);
            expect(account.settingsVersion).toBe(7);
            expect(account.catalogRows.get(REMOTE_HOST_ROWS_ROUTE_V1)).toEqual({ status: 'present', revision: 15, content });
        } else {
            expect(result).toMatchObject({ ok: true, settingsVersion: 7 });
            expect(account.resources.size).toBe(1);
            expect(account.raw).toEqual(originalSettings);
            expect(account.settingsVersion).toBe(7);
            const captured = await withProfileAccount(account.scope, undefined, (context, accountMode) =>
                captureSavedSecretReferenceStateInContext(context, accountMode));
            expect(captured).toMatchObject({ ok: true, catalogs: { remoteHostRecords: [{ ssh: { passwordSecretRef: ref } }] },
                referenceCensus: { remoteHosts: { revision: 15, resourceRefs: [ref] } } });
            expect(await withProfileAccount(account.scope, undefined, context => readSavedSecretReferenceInContext(context, ref)))
                .toEqual({ ok: true, value: 'new-ssh-password', revision: 1 });
        }
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
    });
    it('full reference credential save refuses an incomplete SSH facet before resource dispatch', async () => {
        const account = await openAccount();
        const record = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{
            id: 'unclassified-ssh-host', name: 'SSH host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
            ssh: { target: 'user@host.example.test', authMode: 'agent' },
        }] });
        const content = sealRemoteHostCatalogContentV1({ record, mode: 'plain', material: null });
        account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 14, content });
        const draft = { id: 'unclassified-ssh-password', name: 'SSH password', kind: 'password' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'new-ssh-password' }, createdAt: 10, updatedAt: 10 };
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            referenceScope: 'full', resources: [draft], mutateCatalogs: ({ rawSettings, catalogs, resourceRefs }) => ({
                settings: { ...rawSettings, secrets: [draft] },
                catalogs: { ...catalogs, remoteHostRecords: record.hosts.map(host => ({ ...host,
                    ssh: { ...host.ssh, passwordSecretRef: resourceRefs.get(draft.id)! },
                    futureCredentialRef: { t: 'savedSecret', secretId: resourceRefs.get(draft.id)! } })) },
            }),
        });
        expect(result).toEqual({ ok: false, reason: 'unavailable' });
        expect(account.resources.size).toBe(0);
        expect(account.catalogRows.get(REMOTE_HOST_ROWS_ROUTE_V1)).toEqual({ status: 'present', revision: 14, content });
        expect(account.writes).toEqual([]);
    });
    it.each([true, false])('full reference credential save borrows the original caller lifetime without owning disposal (retired: %s)', async retired => {
        const account = await openAccount('plain');
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'borrowed-full-profile', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'borrowed-full-profile', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: {} });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        const draft = { id: 'borrowed-full-draft', name: 'Profile key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'borrowed-private-key' }, createdAt: 10, updatedAt: 10 };
        const cancellation = new AbortController();
        const context = await captureLazyActionAccountContext(account.scope.serverId, cancellation.signal);
        try {
            const originalSource = { rawSettings: await context.readRawSettings(), settingsVersion: account.settingsVersion };
            let callbackReached = false;
            account.setEffect((path, body) => {
                if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected only the captured full transaction');
                const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
                if (input.nextSettings?.t !== 'plain') throw new Error('Expected canonical prepared Settings');
                account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
                account.raw = input.nextSettings.v;
                account.settingsVersion = 23;
                return Response.json({ resourceId: input.resourceId, settingsVersion: 23 });
            });
            if (retired) cancellation.abort();
            const { createSavedSecretResourcesWithCatalogMutationInContext } = await import('./savedSecretResourceOperations');
            const result = await createSavedSecretResourcesWithCatalogMutationInContext(context, { scope: account.scope,
                resources: [draft], referenceScope: 'full', originalSource,
                mutateCatalogs: ({ rawSettings, catalogs }) => {
                    callbackReached = true;
                    return { settings: { ...rawSettings, secrets: [draft] },
                        catalogs: { ...catalogs, profileRecords: catalogs.profileRecords.map(current => current.id === record.id
                            ? { ...current, secretBindings: { TOKEN: draft.id } } : current) } };
                },
            });
            expect(result).toMatchObject(retired ? { ok: false } : { ok: true, settingsVersion: 23 });
            expect(callbackReached).toBe(!retired);
            expect(account.writes.map(write => write.path)).toEqual(retired ? [] : [SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
            expect(account.resources.size).toBe(retired ? 0 : 1);
            expect(context.accountLifetime.isCurrent()).toBe(!retired);
            if (!retired) {
                expect(await context.readRawSettings()).toMatchObject({ secrets: [] });
                expect(await readSavedSecretReferenceInContext(context, `happier:shared-secret:v1:${draft.id}`))
                    .toEqual({ ok: true, value: 'borrowed-private-key', revision: 1 });
                // A disposed context loses its credential watch even though a GET can still succeed.
                const deviceStorage = installLocalStorageMock();
                try {
                    const activeScopeFence = captureActiveServerAccountScopeCurrentness();
                    expect(activeScopeFence.isCurrent()).toBe(true);
                    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
                    expect(await TokenStorage.setCredentialsForServerUrl(context.endpointUrl,
                        { serverId: context.serverId }, context.credentials)).toBe(true);
                    expect(activeScopeFence.isCurrent()).toBe(true);
                    expect(context.accountLifetime.isCurrent()).toBe(false);
                    await expect(context.request('/v2/account/settings', { method: 'GET' }, { retry: 'none' }))
                        .rejects.toMatchObject({ code: 'action_account_scope_changed' });
                } finally { deviceStorage.restore(); }
            }
        } finally { context.dispose(); }
    });
    it('full reference credential save settles its captured approval with the actual Settings receipt and no replay', async () => {
        const account = await openAccount('plain', { ask: true });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'full-approval-profile', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'full-approval-profile', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: {} });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        const draft = { id: 'full-approval-draft', name: 'Profile key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-profile-key' }, createdAt: 10, updatedAt: 10 };
        const succeeded = vi.fn();
        const failed = vi.fn();
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const pending = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope,
            resources: [draft], referenceScope: 'full', onApprovalSucceeded: succeeded, onApprovalFailed: failed,
            mutateCatalogs: ({ rawSettings, catalogs }) => ({ settings: { ...rawSettings, secrets: [draft] },
                catalogs: { ...catalogs, profileRecords: catalogs.profileRecords.map(current => current.id === record.id
                    ? { ...current, secretBindings: { TOKEN: draft.id } } : current) } }),
        }).catch((error: unknown) => error);
        expect(pending).toBeInstanceOf(TeamActionApprovalPendingError);
        if (!(pending instanceof TeamActionApprovalPendingError) || typeof pending.registration === 'string') throw new Error('Expected full result-bearing approval');
        expect(account.artifacts).toHaveLength(1);
        const artifact = account.artifacts[0]!;
        const body = decodePlainArtifactStoredContent(artifact.body!);
        if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected Plain Artifact body');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(Reflect.get(body, 'body')));
        if (request.v !== 2) throw new Error('Expected canonical immutable approval origin');
        const input = SharedSavedSecretPromoteInputV1Schema.parse(request.actionArgs);
        expect(input).toMatchObject({ resourceId: draft.id, expectedSettingsVersion: 7,
            nextSettings: { t: 'plain', v: { secrets: [] } },
            referenceCensus: { profiles: { rows: [{ id: record.id, revision: 2 }] } },
            profileMutations: [{ id: record.id, content: { t: 'plain', v: { secretBindings: {
                TOKEN: `happier:shared-secret:v1:${draft.id}`,
            } } } }],
        });
        const settledAt = request.createdAtMs + 1;
        const settled: ApprovalRequestV2 = { ...request, status: 'executed', updatedAtMs: settledAt,
            decision: { kind: 'approve', decidedAtMs: settledAt }, execution: { ok: true, executedAtMs: settledAt,
                result: { resourceId: input.resourceId, settingsVersion: 23 } } };
        const observation: DecryptedArtifact = { id: artifact.id, header: buildApprovalRequestArtifactHeaderV1(settled),
            body: JSON.stringify(settled), headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2, isDecrypted: true };
        expect(await pending.registration.onExecuted(observation)).toBe('consumed');
        expect(succeeded).toHaveBeenCalledWith({ ok: true, settingsVersion: 23,
            resourceRefs: new Map([[draft.id, `happier:shared-secret:v1:${draft.id}`]]),
            resourceFingerprints: new Map([[draft.id, formatSavedSecretCatalogFingerprintV1({
                ref: `happier:shared-secret:v1:${draft.id}`, source: 'shared_resource', revision: 1,
            })]]),
        });
        expect(failed).not.toHaveBeenCalled();
        expect(account.writes).toEqual([]);
        expect(account.resources.size).toBe(0);
    });
    it.each([
        { mode: 'plain', observation: 'matching' }, { mode: 'plain', observation: 'unchanged-settings' },
        { mode: 'plain', observation: 'top-only' }, { mode: 'plain', observation: 'changed-settings' },
        { mode: 'plain', observation: 'changed-profile' }, { mode: 'plain', observation: 'changed-notification' },
        { mode: 'plain', observation: 'changed-ssh' }, { mode: 'e2ee', observation: 'matching' },
        { mode: 'e2ee', observation: 'unchanged-settings' },
    ] as const)(
        'verifies an unknown full credential commit without replaying its original intent ($mode, $observation)', async ({ mode, observation }) => {
        const account = await openAccount(mode, { raw: { untouched: 'original' } });
        const crypto = await withProfileAccount(account.scope, undefined, async (context, accountMode, material) => ({
            accountMode, material, encryption: (await context.resolveAccountEncryption()).encryption,
        }));
        const draft = { id: 'full-unknown-resource', name: 'Recovered credential', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'private-original-value' }, createdAt: 10, updatedAt: 10 };
        const ref = `happier:shared-secret:v1:${draft.id}`;
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'full-unknown-profile', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'full-unknown-profile', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: {} });
        const profileContent = sealProfileRecordContentV1({ record, mode, material: crypto.material, randomBytes: tweetnacl.randomBytes });
        account.rows.push({ id: record.id, revision: 2, content: profileContent });
        const notification = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1,
            id: 'unknown-signing-channel', kind: 'webhook', url: 'https://notifications.example.test/unknown', topics: {}, signingSecretRef: null }] });
        const hosts = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{ id: 'unknown-ssh-host', name: 'SSH',
            createdAt: 1, updatedAt: 1, lastUsedAt: null, ssh: { target: 'user@host.example.test', authMode: 'password', passwordSecretRef: null } }] });
        const notificationContent = sealNotificationChannelCatalogContentV1({ record: notification, mode, material: crypto.material });
        const hostContent = sealRemoteHostCatalogContentV1({ record: hosts, mode, material: crypto.material });
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 12, content: notificationContent });
        account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 14, content: hostContent });
        const original = account.raw;
        account.setEffect(async (path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected only the original S2 intent');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            expect(input.resourceId).toBe(draft.id);
            expect(input.expectedSettingsVersion).toBe(7);
            expect(input.nextSettings === null).toBe(observation === 'unchanged-settings' || observation === 'top-only');
            if (input.nextSettings) {
                const opened = openAccountSettingsStoredContent({ content: input.nextSettings, encryption: crypto.encryption, expectedMode: mode });
                if (!opened.raw) throw new Error('Expected the canonical sent Settings candidate');
                account.raw = opened.raw;
                account.settingsVersion = 8;
            }
            for (const mutation of input.profileMutations) {
                if (!mutation.content) throw new Error('Expected a Profile attachment');
                account.rows[0] = { id: mutation.id, revision: 3, content: mutation.content };
            }
            if (observation !== 'top-only') account.referenceGuardRevision = 4;
            account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 13,
                content: NotificationChannelCatalogMutationV1Schema.parse(input.notificationChannelMutation).content });
            account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 15,
                content: RemoteHostCatalogRowMutationV1Schema.parse(input.remoteHostMutation).content });
            const envelope = input.keyEnvelopes?.[0];
            const key = envelope ? await crypto.encryption!.decryptEncryptionKey(envelope.encryptedDataKey, account.scope) : null;
            const resource = account.materialRow(input.resourceId, mode, input.storedContent, 1, key ?? undefined);
            if (!('resourceId' in resource)) throw new Error('Expected complete authoritative resource material');
            account.resources.set(input.resourceId, { ...resource,
                ...(envelope ? { recipientEnvelope: { encryptedDataKey: envelope.encryptedDataKey,
                    recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } } : {}), entry: { ...resource.entry,
                audience: { accounts: [], teams: [], groups: [] } } });
            key?.fill(0);
            if (mode === 'e2ee') expect(JSON.stringify(input)).not.toContain('private-original-value');
            throw new TypeError('Lost response after accepting the complete full transaction');
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope, referenceScope: 'full', resources: [draft],
            mutateCatalogs: ({ rawSettings, catalogs, resourceRefs }) => ({
                settings: observation === 'unchanged-settings' || observation === 'top-only' ? rawSettings : { ...rawSettings, untouched: 'committed' },
                catalogs: { ...catalogs, profileRecords: observation === 'top-only' ? catalogs.profileRecords : catalogs.profileRecords.map(current => ({ ...current,
                    secretBindings: { TOKEN: resourceRefs.get(draft.id)! } })),
                    notificationChannels: { ...notification, channels: notification.channels.map(channel => ({ ...channel, signingSecretRef: ref })) },
                    remoteHostRecords: hosts.hosts.map(host => ({ ...host, ssh: { ...host.ssh, passwordSecretRef: ref } })) },
            }) });
        expect(result).toMatchObject({ ok: false, reason: 'outcome_unknown' });
        if (observation === 'changed-settings') { account.raw = { ...account.raw, untouched: 'different winner' }; account.settingsVersion = 9; }
        if (observation === 'changed-profile') account.rows[0] = { id: record.id, revision: 3, content: profileContent };
        if (observation === 'changed-notification') account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1,
            { status: 'present', revision: 13, content: notificationContent });
        if (observation === 'changed-ssh') account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1,
            { status: 'present', revision: 15, content: hostContent });
        const verify = Reflect.get(result, 'verifyOutcome');
        const verified = typeof verify === 'function' ? await verify() : result;
        expect(verified).toMatchObject(observation === 'matching' || observation === 'unchanged-settings' || observation === 'top-only'
            ? { ok: true, settingsVersion: observation === 'matching' ? 8 : 7 }
            : { ok: false, reason: 'outcome_unknown' });
        expect(typeof verify).toBe('function');
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        expect([...account.resources.keys()]).toEqual([draft.id]);
        if (observation === 'unchanged-settings' || observation === 'top-only') expect(account.raw).toEqual(original);
    });
    it.each([
        ['plain', 'matching'], ['plain', 'changed-row'], ['plain', 'changed-resource'], ['plain', 'corrupt-resource'], ['plain', 'incomplete-audience'], ['plain', 'retired-scope'],
        ['e2ee', 'matching'], ['e2ee', 'changed-envelope'], ['e2ee', 'changed-account-key'],
    ] as const)('verifies an unknown compound credential commit only from exact authoritative material (%s, %s)', async (mode, observation) => {
        const account = await openAccount(mode);
        const path = '/v1/account/entity-rows/mcp';
        await withProfileAccount(account.scope, undefined, async (_context, accountMode, material) => {
            account.catalogRows.set(path, { status: 'present', revision: 4, content: sealMcpServerCatalogContentV1({
                mode: accountMode, material, catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }), randomBytes: tweetnacl.randomBytes,
            }) });
        });
        const draft = { id: 'unknown-draft-key', name: 'Imported key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'secret-value' }, createdAt: 1, updatedAt: 1 };
        const second = { ...draft, id: 'unknown-second-key', name: 'Second key' };
        const candidate = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'unknown-server', name: 'unknown-server',
            transport: 'stdio', stdio: { command: 'mcp-server', args: [] }, env: {
                TOKEN: { t: 'savedSecret', secretId: draft.id }, SECOND_TOKEN: { t: 'savedSecret', secretId: second.id } },
            createdAt: 1, updatedAt: 1 }], bindings: [] });
        account.setEffect(async (effectPath, body) => {
            if (effectPath !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected single S2 mutation');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            const mutation = McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations?.mcp);
            for (const created of [input, ...(input.additionalSavedSecretResources ?? [])]) {
                const envelope = created.keyEnvelopes?.[0];
                const key = envelope ? await getSyncSingleton().encryption!.decryptEncryptionKey(envelope.encryptedDataKey,
                    { serverId: account.scope.serverId, accountId: account.scope.accountId }) : null;
                const resource = account.materialRow(created.resourceId, mode, created.storedContent, 1, key ?? undefined);
                if ((observation !== 'incomplete-audience' || created.resourceId !== second.id) && 'resourceId' in resource) {
                    account.resources.set(resource.resourceId, { ...resource,
                        ...(envelope ? { recipientEnvelope: { encryptedDataKey: envelope.encryptedDataKey,
                            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } } : {}), entry: { ...resource.entry,
                        audience: { accounts: [], teams: [], groups: [] } } });
                }
                key?.fill(0);
            }
            account.catalogRows.set(path, { status: 'present', revision: 5, content: mutation.content });
            throw new TypeError('Connection lost after the atomic commit');
        });
        const { createSavedSecretResourcesWithCatalogMutation } = await import('./savedSecretResourceOperations');
        const result = await createSavedSecretResourcesWithCatalogMutation({ scope: account.scope, resources: [draft, second], catalogKeys: ['mcp'],
            mutateCatalogs: ({ resourceRefs }) => ({ catalogs: { mcp: remapMcpServerCatalogSavedSecretReferencesV1(candidate,
                Object.fromEntries(resourceRefs)) } }) });
        expect(result).toMatchObject({ ok: false, reason: 'outcome_unknown' });
        if (observation === 'changed-row') account.catalogRows.set(path, { status: 'present', revision: 5,
            content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } });
        if (observation === 'changed-resource') account.materialRow(second.id, 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: second.id, mode: 'plain', content: { v: 1, name: second.name, kind: second.kind, value: 'different-material' },
        }), 1);
        if (observation === 'corrupt-resource') account.resources.set(second.id, { entry: {
            materialStatus: 'resource_corrupt', relationship: 'owner',
            repair: { kind: 'delete_resource', resourceId: second.id, expectedRevision: 1 },
        } });
        if (observation === 'changed-envelope') {
            const resource = account.resources.get(second.id);
            if (!resource || !('resourceId' in resource) || !resource.recipientEnvelope) throw new Error('Expected committed encrypted material');
            account.resources.set(second.id, { ...resource, recipientEnvelope: { ...resource.recipientEnvelope,
                recipientContentPublicKeyFingerprint: 'different-content-key' } });
        }
        if (observation === 'retired-scope') await openAccount('plain', { home: 'verification-other-home' });
        if (observation === 'changed-account-key') account.setBeforeMaterialRead(() => account.rotateServerContentKey());
        const verify = Reflect.get(result, 'verifyOutcome');
        const verified = typeof verify === 'function' ? await verify() : result;
        expect(verified).toMatchObject(observation === 'matching' ? { ok: true } : { ok: false, reason: 'outcome_unknown' });
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        expect(account.resources.size).toBe(2);
    });
    it.each(['rename', 'rotate'] as const)('current picker %s preserves resource identity and never recreates a Settings credential', async action => {
        const account = await openAccount();
        account.materialRow('managed-key', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'managed-key', mode: 'plain', content: { v: 1, name: 'Managed key', kind: 'token', value: 'first-value' },
        }), 3);
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']) throw new Error('Expected resource update');
            const input = SharedSavedSecretUpdateInputV1Schema.parse(body);
            account.materialRow(input.resourceId, 'plain', input.storedContent, 4);
            return Response.json({ resourceId: input.resourceId, revision: 4 });
        });
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await act(async () => { await hook.getCurrent().reload(); });
        const secret = hook.getCurrent().materializedSecrets[0];
        if (!secret) throw new Error('Expected actual opened resource material');
        const applied = action === 'rename' ? await hook.getCurrent().personalMutations.rename(secret, 'Renamed key')
            : await hook.getCurrent().personalMutations.rotate(secret, 'second-value');
        expect(applied).toBe(true);
        const input = SharedSavedSecretUpdateInputV1Schema.parse(account.writes[0]?.body);
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']]);
        expect(input).toMatchObject({ resourceId: 'managed-key', expectedRevision: 3 });
        expect(openSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'plain', storedContent: input.storedContent }))
            .toMatchObject({ name: action === 'rename' ? 'Renamed key' : 'Managed key', value: action === 'rotate' ? 'second-value' : 'first-value' });
        expect(account.raw.secrets ?? []).toEqual([]);
    });
    it('a mounted picker retains its initiating Home scope when the active Home changes', async () => {
        const account = await openAccount();
        account.materialRow('initiating-home-key', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'initiating-home-key', mode: 'plain', content: { v: 1, name: 'Initiating Home key', kind: 'token', value: 'first-value' },
        }), 1);
        await refreshSavedSecretCatalog(account.scope);
        const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
        const onClose = vi.fn();
        const onSelectId = vi.fn();
        const pickerProps = { scope: account.scope, onClose, onSelectId, selectedId: null };
        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, pickerProps));
        const capturedCatalog = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        expect(screen.findByTestId('saved-secret:happier:shared-secret:v1:initiating-home-key')).toBeTruthy();
        const initiatingConnection = connection;
        let otherHomeWrites: typeof account.writes = [];
        await act(async () => {
            await initiatingConnection?.dispose();
            const other = await openAccount('plain', { home: '-other' });
            otherHomeWrites = other.writes;
            other.materialRow('other-home-key', 'plain', sealSavedSecretResourceStoredContentV1({
                resourceId: 'other-home-key', mode: 'plain', content: { v: 1, name: 'Other Home key', kind: 'token', value: 'other-value' },
            }), 1);
            await refreshSavedSecretCatalog(other.scope);
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(onSelectId).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('saved-secret:happier:shared-secret:v1:other-home-key'))).toBe(false);
        expect(await capturedCatalog.getCurrent().personalMutations.create({ name: 'Retired draft', value: 'old-home-value' })).toBeNull();
        expect(account.writes).toEqual([]);
        expect(otherHomeWrites).toEqual([]);
        await capturedCatalog.unmount();
    });
    it('an E2EE Account can use an owned resource explicitly converted to Plain', async () => {
        const account = await openAccount('e2ee');
        account.materialRow('plain-trust-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'plain-trust-resource', mode: 'plain', content: { v: 1, name: 'Converted key', kind: 'token', value: 'resource-value' },
        }), 3);
        expect(await withProfileAccount(account.scope, undefined, context =>
            readSavedSecretReferenceInContext(context, 'happier:shared-secret:v1:plain-trust-resource')))
            .toEqual({ ok: true, value: 'resource-value', revision: 3 });
        expect(account.writes).toEqual([]);
    });
    it('private resource credentials remain usable without Account material for an owned Plain resource on a keyless E2EE Account', async () => {
        const account = await openAccount('plain');
        account.materialRow('keyless-plain-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'keyless-plain-resource', mode: 'plain', content: { v: 1, name: 'Plain key', kind: 'token', value: 'plain-resource-value' },
        }), 4);
        account.setPersistedMode('e2ee');
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            expect(await readSavedSecretReferenceInContext(context, 'happier:shared-secret:v1:keyless-plain-resource'))
                .toEqual({ ok: true, value: 'plain-resource-value', revision: 4 });
            expect(account.writes).toEqual([]);
        } finally { context.dispose(); }
    });
    it.each(['rename', 'rotate'] as const)('keyless E2EE Account can %s an owned Plain resource without Account material', async action => {
        const account = await openAccount('plain');
        account.materialRow('keyless-update-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'keyless-update-resource', mode: 'plain', content: { v: 1, name: 'Plain key', kind: 'token', value: 'original-value' },
        }), 3);
        account.setPersistedMode('e2ee');
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']) throw new Error('Expected canonical resource update');
            const input = SharedSavedSecretUpdateInputV1Schema.parse(body);
            account.materialRow(input.resourceId, 'plain', input.storedContent, 4);
            return Response.json({ resourceId: input.resourceId, revision: 4 });
        });
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await act(async () => { await hook.getCurrent().reload(); });
        const secret = hook.getCurrent().usableSecrets[0];
        if (!secret) throw new Error('Expected the owned Plain material');
        const result = action === 'rename'
            ? await hook.getCurrent().personalMutations.rename(secret, 'Renamed key')
            : await hook.getCurrent().personalMutations.rotate(secret, 'new-value');
        expect(result).toBe(true);
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']]);
        const input = SharedSavedSecretUpdateInputV1Schema.parse(account.writes[0]?.body);
        expect(input).toMatchObject({ resourceId: 'keyless-update-resource', expectedRevision: 3 });
        expect(openSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'plain', storedContent: input.storedContent }))
            .toMatchObject({ name: action === 'rename' ? 'Renamed key' : 'Plain key', value: action === 'rotate' ? 'new-value' : 'original-value' });
    });
    it('resource-only picker opens owned Plain material on a keyless E2EE Account', async () => {
        const account = await openAccount('plain');
        account.materialRow('keyless-picker-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'keyless-picker-resource', mode: 'plain', content: { v: 1, name: 'Existing key', kind: 'token', value: 'plain-resource-value' },
        }), 4);
        account.setPersistedMode('e2ee');
        const picker = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await act(async () => { await refreshSavedSecretCatalog(account.scope).catch(() => undefined); });
        expect(picker.getCurrent().usableSecrets).toMatchObject([{
            id: 'happier:shared-secret:v1:keyless-picker-resource', encryptedValue: { value: 'plain-resource-value' },
        }]);
        expect(account.writes).toEqual([]);
        await picker.unmount();
    });
    it('reference reads refuse persisted Account mode drift during material capture', async () => {
        const account = await openAccount('plain');
        account.materialRow('mode-drift-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'mode-drift-resource', mode: 'plain', content: { v: 1, name: 'Key', kind: 'token', value: 'private-value' },
        }), 4);
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            expect(await context.resolveAccountMode()).toBe('plain');
            account.setBeforeMaterialRead(() => account.setPersistedMode('e2ee'));
            expect(await readSavedSecretReferenceInContext(context, 'happier:shared-secret:v1:mode-drift-resource'))
                .toEqual({ ok: false, reason: 'unavailable' });
            expect(account.writes).toEqual([]);
        } finally { context.dispose(); }
    });
    it('reference reads refuse E2EE material whose own envelope cannot authenticate its content', async () => {
        const account = await openAccount('e2ee');
        const contentKey = new Uint8Array(32).fill(9);
        const wrongEnvelopeKey = new Uint8Array(32).fill(8);
        const row = account.materialRow('locked-resource', 'e2ee', sealSavedSecretResourceStoredContentV1({
            resourceId: 'locked-resource', mode: 'e2ee', resourceDataKey: contentKey,
            content: { v: 1, name: 'Locked key', kind: 'token', value: 'resource-value' }, randomBytes: tweetnacl.randomBytes,
        }), 3, contentKey);
        const encryption = getSyncSingleton().encryption;
        if (!('resourceId' in row) || !row.recipientEnvelope || !encryption) throw new Error('Expected genuine E2EE material');
        account.resources.set(row.resourceId, { ...row, recipientEnvelope: { ...row.recipientEnvelope,
            encryptedDataKey: encryptDataKeyForRecipientV0(wrongEnvelopeKey, encodeBase64(encryption.contentDataKey, 'base64')),
        } });
        expect(await withProfileAccount(account.scope, undefined, context =>
            readSavedSecretReferenceInContext(context, 'happier:shared-secret:v1:locked-resource')))
            .toEqual({ ok: false, reason: 'unavailable' });
        expect(account.writes).toEqual([]);
    });
    it.each<ConnectedAccountCatalogRecordV1>([
        { key: 'purposes', value: { v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } },
        }] } },
        { key: 'configurations', value: { v: 1, entries: [{
            service: { pluginId: 'happier.provider.openai', localId: 'openai' }, modeId: 'public-endpoint',
            revision: '1', values: { endpoint: 'https://public.example/v1' }, secretRefs: {},
        }] } },
    ])('connected activation admits its nonsecret $key source while unrelated personal promotion is unavailable', async record => {
        const unrelated = { id: 'unrelated-personal-key', name: 'Unrelated key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'unrelated-value' }, createdAt: 1, updatedAt: 2 };
        const root = record.key === 'purposes' ? 'connectedAccountPurposeBindingsV1' : 'connectedAccountServiceConfigurationsV1';
        const account = await openAccount('plain', { home: `-nonsecret-${record.key}`, raw: { secrets: [unrelated], [root]: record.value } });
        const destination = `/v1/account/entity-rows/connected-accounts/${record.key}`;
        account.setEffect((path, body) => {
            if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            }
            if (path !== destination) throw new Error('Unexpected fixture mutation');
            const input = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
            account.catalogRows.set(destination, { status: 'present', revision: 1, content: input.content });
            return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        });
        const catalog = await withProfileAccount(account.scope, undefined, context =>
            readConnectedAccountCatalogInContext(context, record.key));
        expect(catalog, JSON.stringify({ catalog, writes: account.writes.map(write => write.path) }))
            .toMatchObject({ status: 'ready', record });
        expect(account.writes.filter(write => write.path === destination).map(write => write.body))
            .toEqual([expect.objectContaining({ expectedRevision: 'absent', sourceSettingsVersion: 7 })]);
        expect(account.writes.some(write => write.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])).toBe(false);
        expect(account.raw.secrets).toEqual([unrelated]);
    });
    it.each([false, true])('connected activation imports legacy material before taking the source snapshot (import unavailable: %s)', async unavailable => {
        const legacy = { id: 'legacy-connected-key', name: 'Legacy key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'legacy-value' }, createdAt: 1, updatedAt: 2 };
        const account = await openAccount('plain', { raw: { secrets: [legacy], connectedAccountServiceConfigurationsV1: { v: 1, entries: [{
            service: { pluginId: 'happier.provider.openai', localId: 'openai' }, modeId: 'api-key',
            revision: '1', values: {}, secretRefs: { apiKey: legacy.id },
        }] } } });
        const destination = '/v1/account/entity-rows/connected-accounts/configurations';
        account.setEffect((path, body) => {
            if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                if (unavailable) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
                const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
                if (input.nextSettings?.t !== 'plain') throw new Error('Expected Plain importer content');
                account.raw = input.nextSettings.v;
                account.settingsVersion += 1;
                account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
                return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
            }
            if (path !== destination) throw new Error('Unexpected fixture mutation');
            const input = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
            account.catalogRows.set(destination, { status: 'present', revision: 1, content: input.content });
            return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        });
        const catalog = await withProfileAccount(account.scope, undefined, context =>
            readConnectedAccountCatalogInContext(context, 'configurations'));
        if (unavailable) {
            expect(catalog).toMatchObject({ status: 'unavailable' });
            expect(account.writes.some(write => write.path === destination || write.path === '/v2/account/settings')).toBe(false);
        } else {
            const importedId = deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
                source: { kind: 'personal-saved-secret', secretId: legacy.id } });
            expect(account.writes[0]?.path).toBe(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']);
            expect(catalog).toMatchObject({ status: 'ready', record: { key: 'configurations', value: { entries: [{
                secretRefs: { apiKey: `happier:shared-secret:v1:${importedId}` },
            }] } } });
            const activation = account.writes.find(write => write.path === destination);
            expect(activation?.body).toMatchObject({ sourceSettingsVersion: 8,
                referencedSavedSecretIds: [`happier:shared-secret:v1:${importedId}`],
                savedSecretRevisions: [{ resourceId: importedId, expectedRevision: 1 }] });
        }
    });
    it('foreground legacy importer preserves the exact pending approval registration without dispatching or replaying its source transaction', async () => {
        const legacy = { id: 'approval-legacy-key', name: 'Legacy credential', kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'legacy-approval-value' }, createdAt: 1, updatedAt: 2 };
        const account = await openAccount('plain', { ask: true, raw: { secrets: [legacy] } });
        const outcome = await withProfileAccount(account.scope, undefined, (context, mode) =>
            importLegacySavedSecretsInContext(context, mode, account.scope)).then(
                value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
        // A real pending Artifact proves that admission reached Ask, rather than
        // failing upstream on capture or fixture setup.
        expect(account.artifacts).toHaveLength(1);
        expect(account.resources.size).toBe(0);
        expect(account.writes).toEqual([]);
        expect(account.raw.secrets).toEqual([legacy]);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind !== 'rejected') throw new Error('Expected the original approval continuation');
        expect(outcome.error).toBeInstanceOf(TeamActionApprovalPendingError);
        if (!(outcome.error instanceof TeamActionApprovalPendingError)) throw new Error('Expected the canonical approval error');
        const registration = outcome.error.registration;
        expect(typeof registration).toBe('object');
        if (typeof registration === 'string') throw new Error('Expected result-bearing approval custody');
        expect(registration.scope).toEqual(account.scope);
        expect(registration.artifactId).toBe(account.artifacts[0]?.id);
    });
    it('background legacy import observation contains pending approval in the existing typed availability projection', async () => {
        const legacy = { id: 'background-approval-key', name: 'Legacy credential', kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'background-approval-value' }, createdAt: 1, updatedAt: 2 };
        const account = await openAccount('plain', { ask: true, raw: { secrets: [legacy] } });
        const release = observeSavedSecretCatalog(account.scope);
        try {
            await vi.waitFor(() => expect(['ready', 'error']).toContain(getSavedSecretCatalogSnapshot(account.scope)?.status));
            expect(account.artifacts).toHaveLength(1);
            expect(account.resources.size).toBe(0);
            expect(account.writes).toEqual([]);
            expect(account.raw.secrets).toEqual([legacy]);
            expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({ status: 'error', stale: true,
                error: { kind: 'unreachable', retryable: true } });
        } finally { release(); }
    });
    it.each([false, true])('catalog importer transfers a predecessor ElevenLabs inline credential and Voice binding through one source transaction (bound personal source: %s)', async boundPersonal => {
        const apiKey = { _isSecretValue: true as const, value: 'legacy-elevenlabs-value' };
        const personal = { id: 'retained-elevenlabs-personal-key', name: 'Existing ElevenLabs key', kind: 'apiKey' as const,
            encryptedValue: apiKey, createdAt: 1, updatedAt: 2 };
        const voice = { providerId: 'realtime_elevenlabs', ...(boundPersonal ? { credentialBindings: [
            LegacyVoiceCredentialBindingV1Schema.parse({ providerId: 'realtime_elevenlabs',
                credentialBindings: { account: { api_key: personal.id } } }),
        ] } : {}), adapters: { realtime_elevenlabs: { byo: { apiKey } } } };
        const account = await openAccount('plain', { raw: { voice, ...(boundPersonal ? { secrets: [personal] } : {}),
            untouched: { preserve: true } }, captureSourceTrace: true });
        expect(settingsParse(account.raw).secrets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: boundPersonal ? personal.id : 'voice:realtime_elevenlabs:api_key', encryptedValue: apiKey }),
        ]));
        if (!boundPersonal) expect(account.raw).not.toHaveProperty('secrets');
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one source transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected the original Plain source transaction');
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        await refreshSavedSecretCatalog(account.scope);
        const input = SharedSavedSecretPromoteInputV1Schema.parse(account.writes.find(write =>
            write.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'])?.body);
        if (input.nextSettings?.t !== 'plain') throw new Error('Expected the original Plain source transaction');
        expect(input.resourceId).toBe(deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: boundPersonal ? personal.id : 'voice:realtime_elevenlabs:api_key' } }));
        expect(input.personalSecretPromotions).toEqual(boundPersonal
            ? [{ personalSecretId: personal.id, resourceId: input.resourceId }] : undefined);
        expect(settingsParse(input.nextSettings.v).voiceSettingsV1.credentialBindings).toEqual(expect.arrayContaining([
            expect.objectContaining({ credentialBindings: { account: { api_key: `happier:shared-secret:v1:${input.resourceId}` } } }),
        ]));
        expect(input.nextSettings.v).toMatchObject({ untouched: { preserve: true } });
        // The canonical Voice serializer may emit a null slot default; it must
        // not retain a credential origin or any original inline material.
        expect(readSavedSecretTransferSourceV1(input.nextSettings.v).legacyVoiceCredentials ?? []).toEqual([]);
        expect(getSavedSecretCatalogSnapshot(account.scope)?.materializedSecrets, JSON.stringify({
            legacyImport: getSavedSecretCatalogSnapshot(account.scope)?.legacyImport,
            writes: account.writes.map(write => write.path), sourceReads: account.sourceReads,
            settingsWriteStacks: account.settingsWriteStacks,
        })).toEqual(expect.arrayContaining([
            expect.objectContaining({ encryptedValue: apiKey }),
        ]));
        expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toEqual({ status: 'complete' });
        if (boundPersonal) expect(account.raw.secrets).toEqual([]);
        else expect(account.raw).not.toHaveProperty('secrets');
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
    });
    it.each([false, true])('catalog importer verifies an already Shared predecessor ElevenLabs origin without creating another resource (source drift: %s)', async sourceDrift => {
        const resourceId = 'already-bound-elevenlabs-resource';
        const resourceRef = `happier:shared-secret:v1:${resourceId}`;
        const encryptedValue = { _isSecretValue: true as const, value: 'bound-elevenlabs-value' };
        const voice = { providerId: 'realtime_elevenlabs', credentialBindings: [LegacyVoiceCredentialBindingV1Schema.parse({
            providerId: 'realtime_elevenlabs', credentialBindings: { account: { api_key: resourceRef } },
        })], adapters: { realtime_elevenlabs: { byo: { apiKey: encryptedValue } } } };
        const account = await openAccount('plain', { raw: { voice }, captureSourceTrace: true });
        const receipt = readSavedSecretTransferSourceV1(account.raw).legacyVoiceCredentials?.[0];
        expect(receipt?.source).toEqual({ kind: 'existing-resource-reference', resourceRef });
        account.materialRow(resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Existing ElevenLabs credential', kind: 'apiKey', value: encryptedValue.value } }), 4);
        if (sourceDrift) account.setBeforeMaterialRead(() => {
            account.raw = { ...account.raw, voice: { ...voice, adapters: { realtime_elevenlabs: {
                byo: { apiKey: { _isSecretValue: true, value: 'changed-elevenlabs-value' } },
            } } } };
            account.settingsVersion += 1;
            account.setBeforeMaterialRead(undefined);
        });
        await refreshSavedSecretCatalog(account.scope);
        expect(account.writes, JSON.stringify({ paths: account.writes.map(write => write.path), sourceReads: account.sourceReads })).toEqual([]);
        expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toMatchObject(sourceDrift
            ? { status: 'pending', reason: 'changed' }
            : { status: 'complete', verifiedReferences: [{ source: receipt?.source, resourceRef, revision: 4 }] });
        expect(account.resources.size).toBe(1);
    });
    it.each(['stable', 'resource-use-withdrawal', 'source-drift'] as const)('catalog importer revalidates its earlier Shared Voice receipt after its own Chat resource ACK (observation: %s)', async observation => {
        const resourceId = 'mixed-existing-elevenlabs';
        const resourceRef = `happier:shared-secret:v1:${resourceId}`;
        const elevenValue = { _isSecretValue: true as const, value: 'mixed-elevenlabs-value' };
        const chatValue = { _isSecretValue: true as const, value: 'mixed-chat-value' };
        const voice = { providerId: 'realtime_elevenlabs', credentialBindings: [LegacyVoiceCredentialBindingV1Schema.parse({
            providerId: 'realtime_elevenlabs', credentialBindings: { account: { api_key: resourceRef } },
        })], adapters: { realtime_elevenlabs: { byo: { apiKey: elevenValue } }, local_conversation: {
            agent: { backend: 'openai_compat', openaiCompat: {
                chatBaseUrl: 'https://legacy-chat.example/v1', chatModel: 'chat-model', commitModel: 'commit-model', chatApiKey: chatValue,
            } },
        } } };
        const account = await openAccount('plain', { raw: { voice } });
        const source = readSavedSecretTransferSourceV1(account.raw);
        const elevenReceipt = source.legacyVoiceCredentials?.[0];
        const chatReceipt = source.legacyChatCredential;
        expect(elevenReceipt?.source).toEqual({ kind: 'existing-resource-reference', resourceRef });
        if (chatReceipt?.source.kind !== 'personal-saved-secret') throw new Error('Expected the genuine inline Chat source');
        account.materialRow(resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Existing ElevenLabs key', kind: 'apiKey', value: elevenValue.value } }), 4);
        let chatResourceRef: string | undefined;
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected only the original Chat resource transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected unchanged original Plain source');
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            chatResourceRef = `happier:shared-secret:v1:${input.resourceId}`;
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            const acknowledgedVersion = account.settingsVersion;
            if (observation === 'resource-use-withdrawal') {
                // The canonical Home material projection omits a revoked resource.
                account.resources.delete(resourceId);
            }
            if (observation === 'source-drift') {
                // A separate writer advances the source after our commit, not our frontier.
                account.raw = { ...account.raw, unrelatedRevision: 'changed after resource commit' };
                account.settingsVersion += 1;
            }
            return Response.json({ resourceId: input.resourceId, settingsVersion: acknowledgedVersion });
        });
        await refreshSavedSecretCatalog(account.scope);
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        expect(account.resources.size).toBe(observation === 'resource-use-withdrawal' ? 1 : 2);
        expect(account.raw.voice).toEqual(voice);
        expect(account.settingsVersion).toBe(observation === 'source-drift' ? 9 : 8);
        expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toMatchObject(observation !== 'stable'
            ? { status: 'pending', reason: observation === 'source-drift' ? 'outcome_unknown' : 'source-unavailable' }
            : { status: 'complete', verifiedReferences: expect.arrayContaining([
                { source: elevenReceipt?.source, resourceRef, revision: 4 },
                { source: chatReceipt.source, resourceRef: chatResourceRef, revision: 1 },
            ]) });
    });
    it('catalog importer recovers legacy Voice Chat material from its actual inline origin without fabricating raw secrets', async () => {
        const chatApiKey = { _isSecretValue: true as const, value: 'legacy-chat-value' };
        const voice = { providerId: 'local_conversation', adapters: { local_conversation: {
            agent: { backend: 'openai_compat', openaiCompat: {
                chatBaseUrl: 'https://legacy-chat.example/v1', chatModel: 'chat-model', commitModel: 'commit-model', chatApiKey,
            } },
        } } };
        const account = await openAccount('plain', { raw: { voice } });
        // This is an existing read-only predecessor projection, not persisted
        // personal material the test or the Provider consumer may invent.
        expect(settingsParse(account.raw).secrets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'voice:openai_compat:chat_api_key', encryptedValue: chatApiKey }),
        ]));
        expect(account.raw).not.toHaveProperty('secrets');
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected the canonical source transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected the captured Plain source');
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        await refreshSavedSecretCatalog(account.scope);
        const snapshot = getSavedSecretCatalogSnapshot(account.scope);
        expect(snapshot?.materializedSecrets).toEqual(expect.arrayContaining([
            expect.objectContaining({ encryptedValue: chatApiKey }),
        ]));
        // The Provider import still owns the original Chat source. Resource
        // ingress cannot remove it ahead of that row-and-cleanup receipt.
        expect(account.raw.voice).toEqual(voice);
        expect(account.raw).not.toHaveProperty('secrets');
        expect(account.writes.some(write => write.path === '/v2/account/settings')).toBe(false);
    });
    it.each([{ outcome: 'same-origin', boundShared: false }, { outcome: 'conflicting-resource', boundShared: false },
        { outcome: 'changed-origin', boundShared: false }, { outcome: 'same-origin', boundShared: true },
        { outcome: 'conflicting-resource', boundShared: true }] as const)(
        'catalog importer verifies a retained Voice Chat origin against its existing resource ($outcome, Shared binding: $boundShared)', async ({ outcome, boundShared }) => {
            const boundResourceId = 'already-bound-chat-resource';
            const voice = { providerId: 'local_conversation', ...(boundShared ? { credentialBindings: [
                LegacyVoiceCredentialBindingV1Schema.parse({ providerId: 'openai_compat', credentialBindings: {
                    account: { chat_api_key: `happier:shared-secret:v1:${boundResourceId}` },
                } }),
            ] } : {}), adapters: { local_conversation: {
                agent: { backend: 'openai_compat', openaiCompat: {
                    chatBaseUrl: 'https://legacy-chat.example/v1', chatModel: 'chat-model', commitModel: 'commit-model',
                    chatApiKey: { _isSecretValue: true as const, value: 'original-chat-value' },
                } },
            } } };
            const account = await openAccount('plain', { raw: { voice }, captureSourceTrace: true });
            const receipt = readSavedSecretTransferSourceV1(account.raw).legacyChatCredential;
            if (!receipt) throw new Error('Expected the canonical retained inline origin');
            expect(receipt.source.kind).toBe(boundShared ? 'existing-resource-reference' : 'personal-saved-secret');
            const resourceId = receipt.source.kind === 'personal-saved-secret'
                ? deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId, source: receipt.source }) : boundResourceId;
            account.materialRow(resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                content: { v: 1, name: 'Imported Chat credential', kind: 'apiKey',
                    value: outcome === 'conflicting-resource' ? 'other-resource-value' : 'original-chat-value' },
            }), 1);
            if (outcome === 'changed-origin') account.setBeforeMaterialRead(() => {
                account.raw = { ...account.raw, voice: { ...voice, adapters: { local_conversation: {
                    agent: { ...voice.adapters.local_conversation.agent, openaiCompat: {
                        ...voice.adapters.local_conversation.agent.openaiCompat,
                        chatApiKey: { _isSecretValue: true, value: 'changed-chat-value' },
                    } },
                } } } };
                account.settingsVersion += 1;
                account.setBeforeMaterialRead(undefined);
            });
            await refreshSavedSecretCatalog(account.scope);
            const imported = getSavedSecretCatalogSnapshot(account.scope)?.legacyImport;
            expect(account.writes.filter(write => write.path === '/v2/account/settings'), JSON.stringify({
                sourceReads: account.sourceReads, settingsWriteStacks: account.settingsWriteStacks,
            })).toEqual([]);
            expect(imported).toMatchObject({ status: outcome === 'same-origin' ? 'complete' : 'pending' });
            if (outcome === 'same-origin') expect(imported).toMatchObject({ verifiedReferences: [
                { source: receipt.source, resourceRef: `happier:shared-secret:v1:${resourceId}`, revision: 1 },
            ] });
            else expect(imported).not.toHaveProperty('verifiedReferences');
            expect(account.resources.size).toBe(1);
            expect(account.writes).toEqual([]);
            expect(account.raw).not.toHaveProperty('secrets');
            if (outcome !== 'changed-origin') expect(account.raw.voice).toEqual(voice);
        },
    );
    it.each(['matching', 'different-material', 'source-drift'] as const)(
        'selected retained Chat verification does not import unrelated personal credentials (%s)', async observation => {
        const resourceId = 'selected-chat-resource';
        const ref = `happier:shared-secret:v1:${resourceId}`;
        const voice = { providerId: 'local_conversation', credentialBindings: [LegacyVoiceCredentialBindingV1Schema.parse({
            providerId: 'openai_compat', credentialBindings: { account: { chat_api_key: ref } },
        })], adapters: { local_conversation: { agent: { backend: 'openai_compat', openaiCompat: {
            chatBaseUrl: 'https://legacy-chat.example/v1', chatModel: 'chat-model', commitModel: 'commit-model',
            chatApiKey: { _isSecretValue: true as const, value: 'original-chat-value' },
        } } } } };
        const account = await openAccount('plain', { raw: { voice, secrets: [{ id: 'unrelated-personal', name: 'Unrelated', kind: 'token',
            encryptedValue: { _isSecretValue: true, value: 'unrelated-token' }, createdAt: 1, updatedAt: 1 }] } });
        const credential = readSavedSecretTransferSourceV1(account.raw).legacyChatCredential;
        if (!credential || credential.source.kind !== 'existing-resource-reference') throw new Error('Expected actual Shared Chat origin');
        account.setProfileReadStatus(503);
        account.materialRow(resourceId, 'plain', sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Chat', kind: 'apiKey', value: observation === 'different-material' ? 'different-value' : 'original-chat-value' } }), 3);
        if (observation === 'source-drift') account.setBeforeMaterialRead(() => {
            account.settingsVersion += 1;
            account.setBeforeMaterialRead(undefined);
        });
        const { verifyRetainedLegacySavedSecretReferenceInContext } = await import('./savedSecretResourceOperations');
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            expect(await verifyRetainedLegacySavedSecretReferenceInContext(context, account.scope, credential)).toEqual(
                observation === 'matching' ? { ok: true, reference: { source: credential.source, resourceRef: ref, revision: 3 } }
                    : { ok: false, reason: observation === 'source-drift' ? 'changed' : 'source-unavailable' });
            expect(context.accountLifetime.isCurrent()).toBe(true);
            expect(account.writes).toEqual([]);
            expect(account.raw.secrets).toHaveLength(1);
            expect(account.raw.voice).toEqual(voice);
        } finally { context.dispose(); }
    });
    it.each(['stable', 'source-drift', 'resource-use-withdrawal'] as const)('catalog importer retains the actual bound personal Chat identity through promotion and Shared reload (history observation: %s)', async observation => {
        const encryptedValue = { _isSecretValue: true as const, value: 'bound-chat-value' };
        const source = { id: 'my-existing-chat-key', name: 'Existing Chat key', kind: 'apiKey' as const,
            encryptedValue, createdAt: 1, updatedAt: 2 };
        const voice = { credentialBindings: [LegacyVoiceCredentialBindingV1Schema.parse({ providerId: 'openai_compat',
            credentialBindings: { account: { chat_api_key: source.id } } })],
            adapters: { local_conversation: { agent: { backend: 'openai_compat', openaiCompat: {
                chatBaseUrl: 'https://legacy-chat.example/v1', chatModel: 'chat-model', commitModel: 'commit-model', chatApiKey: encryptedValue,
            } } } } };
        const account = await openAccount('plain', { raw: { secrets: [source], voice } });
        expect(readSavedSecretTransferSourceV1(account.raw)).toMatchObject({ secrets: [source], complete: true });
        expect(readSavedSecretTransferSourceV1(account.raw).legacyChatCredential).toBeUndefined();
        const captured = await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode));
        expect(captured.ok).toBe(true);
        if (!captured.ok) throw new Error('Expected complete original source capture');
        const expectedResourceId = deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: source.id } });
        const prepared = promotePersonalSavedSecretReference(captured.baseline.source.raw, {
            secretId: source.id, expectedUpdatedAt: source.updatedAt,
            sharedSecretRef: `happier:shared-secret:v1:${expectedResourceId}`,
        }, captured.catalogs);
        const stored = normalizeVoiceSettingsServerDelta(prepared.settings, captured.baseline.source.raw);
        expect(readSavedSecretTransferSourceV1(stored).legacyChatCredential).toMatchObject({
            source: { kind: 'existing-resource-reference', resourceRef: `happier:shared-secret:v1:${expectedResourceId}` },
            encryptedValue,
        });
        let resourceId: string | undefined;
        let historyObserved = false;
        account.setEffect((path, body) => {
            if (path !== SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) throw new Error('Expected one canonical personal source transaction');
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected the captured Plain source');
            resourceId = input.resourceId;
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            account.setBeforeHistoryRead(() => {
                historyObserved = true;
                account.setBeforeHistoryRead(undefined);
                if (observation === 'source-drift') {
                    account.raw = { ...account.raw, unrelatedRevision: 'changed during history' };
                    account.settingsVersion += 1;
                }
                if (observation === 'resource-use-withdrawal') {
                    // Revocation is an absent material row, not ready content with use=false.
                    account.resources.delete(input.resourceId);
                }
            });
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        await refreshSavedSecretCatalog(account.scope);
        expect(resourceId, JSON.stringify({ legacyImport: getSavedSecretCatalogSnapshot(account.scope)?.legacyImport,
            writes: account.writes.map(write => write.path) })).toBe(deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: source.id } }));
        const retained = readSavedSecretTransferSourceV1(account.raw).legacyChatCredential;
        expect(retained).toMatchObject({ source: { kind: 'existing-resource-reference',
            resourceRef: `happier:shared-secret:v1:${resourceId}` }, encryptedValue });
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        expect(historyObserved).toBe(true);
        if (observation !== 'stable') {
            expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toEqual({ status: 'pending',
                reason: observation === 'source-drift' ? 'changed' : 'source-unavailable' });
            expect(account.resources.size).toBe(observation === 'resource-use-withdrawal' ? 0 : 1);
            return;
        }
        expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toMatchObject({ status: 'complete', verifiedReferences: [
            { source: retained?.source, resourceRef: `happier:shared-secret:v1:${resourceId}`, revision: 1 },
        ] });
        await refreshSavedSecretCatalog(account.scope);
        expect(getSavedSecretCatalogSnapshot(account.scope)?.legacyImport).toMatchObject({ status: 'complete', verifiedReferences: [
            { source: retained?.source, resourceRef: `happier:shared-secret:v1:${resourceId}`, revision: 1 },
        ] });
        expect(account.writes.map(write => write.path)).toEqual([SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']]);
        expect(account.resources.size).toBe(1);
        expect(account.raw).not.toHaveProperty('secrets.0');
    });
    it.each([false, true])('catalog importer preserves an existing resource while transferring a colliding legacy personal id (active MCP: %s)', async activeMcp => {
        const legacy = { id: 'happier:shared-secret:v1:existing-resource', name: 'Legacy key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'legacy-value' }, createdAt: 1, updatedAt: 2 };
        const account = await openAccount('plain', { raw: { secrets: [legacy] } });
        account.materialRow('existing-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'existing-resource', mode: 'plain', content: { v: 1, name: 'Existing key', kind: 'token', value: 'resource-value' },
        }), 5);
        const mcp = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'active-server', name: 'active-server',
            transport: 'stdio', stdio: { command: 'server', args: [] }, env: {
                API_KEY: { t: 'savedSecret', secretId: legacy.id },
            }, createdAt: 1, updatedAt: 1 }], bindings: [] });
        if (activeMcp) account.catalogRows.set('/v1/account/entity-rows/mcp', { status: 'present', revision: 7,
            content: sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog: mcp, randomBytes: tweetnacl.randomBytes }) });
        expect(readSavedSecretTransferSourceV1(account.raw).secrets).toEqual([legacy]);
        expect(await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode))).toMatchObject({ ok: true });
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected Plain importer content');
            account.raw = input.nextSettings.v;
            account.settingsVersion += 1;
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            if (input.catalogMutations?.mcp) account.catalogRows.set('/v1/account/entity-rows/mcp', {
                status: 'present', revision: 8, content: McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations.mcp).content,
            });
            return Response.json({ resourceId: input.resourceId, settingsVersion: account.settingsVersion });
        });
        await refreshSavedSecretCatalog(account.scope);
        const importedId = deriveSavedSecretImportResourceIdV1({ accountId: account.scope.accountId,
            source: { kind: 'personal-saved-secret', secretId: legacy.id } });
        const snapshot = getSavedSecretCatalogSnapshot(account.scope);
        // Resource presence is not the source-transfer receipt: preserve the
        // actual pending reason if admission or immutable ACK verification fails.
        expect(account.writes).toHaveLength(1);
        expect(account.raw.secrets).toEqual([]);
        expect(snapshot?.legacyImport).toEqual({ status: 'complete' });
        expect(snapshot?.materializedSecrets).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'happier:shared-secret:v1:existing-resource', encryptedValue: { _isSecretValue: true, value: 'resource-value' } }),
            expect.objectContaining({ id: `happier:shared-secret:v1:${importedId}`, encryptedValue: { _isSecretValue: true, value: 'legacy-value' } }),
        ]));
        expect(account.raw.secrets).toEqual([]);
        expect(account.writes.every(write => write.path !== '/v2/account/settings')).toBe(true);
        if (activeMcp) {
            expect(account.catalogRows.get('/v1/account/entity-rows/mcp')).toMatchObject({ content: { t: 'plain', v: mcp } });
            expect(account.writes[0]?.body).toMatchObject({ referenceCensus: { catalogs: { mcp: 7 } } });
        }
    });
    it.each(['voice', 'plugin'] as const)('catalog importer refuses ambiguous current %s bindings for a colliding retained personal identity', async owner => {
        const ref = 'happier:shared-secret:v1:ambiguous-existing-resource';
        const legacy = { id: ref, name: 'Retained key', kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'legacy-value' }, createdAt: 1, updatedAt: 2 };
        const binding = owner === 'voice'
            ? normalizeVoiceSettingsServerDelta({ voiceSettingsV1: { providers: {}, credentialBindings: [{
                contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' }, credentialSlotId: 'api_key',
                credentialSource: { kind: 'savedSecret' }, credentialBindings: { account: { api_key: ref } },
            }] } })
            : { pluginSecretBindingsV1: {
                [qualifyPluginAccountSecretBindingKey({ pluginId: 'acme.notifications', localId: 'webhook-token' })]: {
                    pluginId: 'acme.notifications', custody: 'account', localId: 'webhook-token',
                    savedSecretId: ref, createdForBinding: false,
                },
            } };
        const account = await openAccount('plain', { raw: { secrets: [legacy], ...binding } });
        account.materialRow('ambiguous-existing-resource', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'ambiguous-existing-resource', mode: 'plain',
            content: { v: 1, name: 'Current resource', kind: 'token', value: 'resource-value' },
        }), 5);
        const before = account.raw;
        await refreshSavedSecretCatalog(account.scope);
        expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({ legacyImport: { status: 'pending' },
            materializedSecrets: [expect.objectContaining({ id: ref, encryptedValue: { _isSecretValue: true, value: 'resource-value' } })] });
        expect(account.raw).toEqual(before);
        expect(account.resources.size).toBe(1);
        expect(account.writes).toEqual([]);
    });
    it('picker retains resource provenance but refuses stale material after a Home read failure', async () => {
        const account = await openAccount();
        account.materialRow('retained-key', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'retained-key', mode: 'plain', content: { v: 1, name: 'Retained key', kind: 'token', value: 'private-value' },
        }), 4);
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await hook.getCurrent().reload();
        expect(hook.getCurrent().entries).toEqual([expect.objectContaining({
            ref: 'happier:shared-secret:v1:retained-key', relationship: 'owner', ownerAccountId: account.scope.accountId,
        })]);
        account.setMaterialReadStatus(503);
        await act(async () => { await hook.getCurrent().reload().catch(() => undefined); });
        expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({ status: 'error', stale: true, materializedSecrets: [] });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', stale: true, usableSecrets: [], materializedSecrets: [] });
        expect(hook.getCurrent().entries).toEqual([expect.objectContaining({ ref: 'happier:shared-secret:v1:retained-key' })]);
        expect(hook.getCurrent().resolveReference('happier:shared-secret:v1:retained-key')).toMatchObject({
            status: 'temporarily_unavailable', secret: null,
        });
        await hook.unmount();
    });
    it('picker keeps corrupt rows unselectable and deletes owned corruption by its opaque retained identity', async () => {
        const account = await openAccount();
        await vi.waitFor(() => expect(storage.getState().settingsVersion).toBe(7));
        const ownerCorruption = { materialStatus: 'resource_corrupt' as const, relationship: 'owner' as const,
            repair: { kind: 'delete_resource' as const, resourceId: 'opaque-row-id', expectedRevision: -3 } };
        const recipientCorruption = { materialStatus: 'resource_corrupt' as const, relationship: 'recipient' as const, repair: null };
        account.resources.set('opaque-row-id', { entry: ownerCorruption });
        account.resources.set('corrupt-recipient', { entry: recipientCorruption });
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await hook.getCurrent().reload();
        expect(hook.getCurrent()).toMatchObject({ entries: [], usableSecrets: [],
            corruptEntries: [ownerCorruption, recipientCorruption] });
        account.setEffect(() => {
            account.resources.delete('opaque-row-id');
            return Response.json({ resourceId: 'opaque-row-id' });
        });
        await act(async () => {
            expect(await hook.getCurrent().deleteCorruptResource(ownerCorruption)).toEqual({ ok: true });
        });
        expect(getSavedSecretCatalogSnapshot(account.scope)?.corruptEntries).toEqual([recipientCorruption]);
        expect(account.writes).toEqual([expect.objectContaining({ body: expect.objectContaining({
            resourceId: 'opaque-row-id', expectedRevision: -3, expectedSettingsVersion: 7,
        }) })]);
        expect(hook.getCurrent().corruptEntries).toEqual([recipientCorruption]);
        await hook.unmount();
    });
    it('successful private deletion replaces a catalog read captured before the delete without remounting', async () => {
        const account = await openAccount();
        await vi.waitFor(() => expect(storage.getState().settingsVersion).toBe(7));
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Temporary key', kind: 'token' as const, value: 'dummy' } };
        account.materialRow('deleted-key', 'plain', content);
        account.materialRow('retained-key', 'plain', content);
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().usableSecrets).toHaveLength(2);
        let deliverRead!: () => void;
        let readCaptured!: () => void;
        const captured = new Promise<void>(resolve => { readCaptured = resolve; });
        const delivery = new Promise<void>(resolve => { deliverRead = resolve; });
        account.setBeforeMaterialRead(async () => {
            account.setBeforeMaterialRead(undefined);
            readCaptured();
            await delivery;
        });
        let beforeDelete!: Promise<void>;
        await act(async () => { beforeDelete = hook.getCurrent().reload(); await captured; });
        let acknowledgeDelete!: () => void;
        const acknowledged = new Promise<void>(resolve => { acknowledgeDelete = resolve; });
        account.setEffect(() => {
            account.resources.delete('deleted-key');
            acknowledgeDelete();
            return Response.json({ resourceId: 'deleted-key' });
        });
        let deletion!: Promise<Awaited<ReturnType<typeof deleteSavedSecretResource>>>;
        try {
            await act(async () => {
                deletion = deleteSavedSecretResource({ scope: account.scope, resourceId: 'deleted-key',
                    expectedRevision: 3, expectedSettingsVersion: 7, confirmedByPresentUser: true });
                await acknowledged;
            });
            // Receipt reconciliation must publish without waiting for a held
            // pre-delete read. The same mounted consumer observes the change.
            await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(account.scope)?.data?.map(entry => entry.ref))
                .toEqual(['happier:shared-secret:v1:retained-key']));
            expect(hook.getCurrent().entries.map(entry => entry.ref)).toEqual(['happier:shared-secret:v1:retained-key']);
            deliverRead();
            await act(async () => {
                expect(await deletion).toEqual({ ok: true });
                await beforeDelete;
            });
            expect(hook.getCurrent().entries.map(entry => entry.ref)).toEqual(['happier:shared-secret:v1:retained-key']);
            expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual(['happier:shared-secret:v1:retained-key']);
            expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({ status: 'ready', stale: false });
        } finally {
            deliverRead();
            await deletion;
            await hook.unmount();
        }
    });
    it('publishes an acknowledged deletion to the catalog even when its read-back is unavailable', async () => {
        const account = await openAccount();
        account.materialRow('deleted-key', 'plain', { t: 'plain', v: { v: 1, name: 'Temporary key', kind: 'token', value: 'dummy' } });
        const release = observeSavedSecretCatalog(account.scope);
        await refreshSavedSecretCatalog(account.scope);
        expect(getSavedSecretCatalogSnapshot(account.scope)?.data).toHaveLength(1);
        account.setEffect(() => {
            account.resources.delete('deleted-key');
            account.setMaterialReadStatus(503);
            return Response.json({ resourceId: 'deleted-key' });
        });
        try {
            expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'deleted-key',
                expectedRevision: 3, expectedSettingsVersion: 7, confirmedByPresentUser: true })).toEqual({ ok: true });
            expect(getSavedSecretCatalogSnapshot(account.scope)?.data).toEqual([]);
            expect(getSavedSecretCatalogSnapshot(account.scope)?.materializedSecrets).toEqual([]);
        } finally { release(); }
    });
    it.each([true, false])('current picker creates private resource material without recreating Settings secrets (Teams: %s)', async teams => {
        const account = await openAccount('plain', { teams });
        await vi.waitFor(() => expect(storage.getState().settingsVersion).toBe(7));
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretCreateInputV1Schema.parse(body);
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        });
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        const reference = await hook.getCurrent().personalMutations.create({ name: '  Private key  ', value: '  exact bytes\n' });
        expect(reference).toMatch(/^happier:shared-secret:v1:/);
        const created = SharedSavedSecretCreateInputV1Schema.parse(account.writes[0]?.body);
        expect(openSavedSecretResourceStoredContentV1({ resourceId: created.resourceId, mode: 'plain', storedContent: created.storedContent }))
            .toMatchObject({ name: 'Private key', value: '  exact bytes\n' });
        expect(account.raw.secrets ?? []).toEqual([]);
        expect(account.writes).toEqual([expect.objectContaining({
            path: SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'],
        })]);
        await hook.unmount();
    });
    it('private resource credentials remain selectable when Teams is disabled', async () => {
        const account = await openAccount('plain', { teams: false });
        account.materialRow('private-key', 'plain', sealSavedSecretResourceStoredContentV1({
            resourceId: 'private-key', mode: 'plain', content: { v: 1, name: 'Private key', kind: 'token', value: 'private-value' },
        }), 1);
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: account.scope }));
        await hook.getCurrent().reload();
        expect(hook.getCurrent().usableSecrets).toEqual([expect.objectContaining({
            id: 'happier:shared-secret:v1:private-key', encryptedValue: { _isSecretValue: true, value: 'private-value' },
        })]);
        expect(hook.getCurrent().resolveReference('happier:shared-secret:v1:private-key')).toMatchObject({
            status: 'ready', revision: 1,
        });
        expect(account.writes).toEqual([]);
        await hook.unmount();
    });
    it.each([
        { label: 'exact proof map', proofs: [{ resourceId: 'new-resource', expectedRevision: 1 }] },
        { label: 'multiple domain proof map', proofs: [{ resourceId: 'new-resource', expectedRevision: 1 }, { resourceId: 'other-domain-resource', expectedRevision: 7 }] },
    ])('current connected configuration preserves supplied revisions for a resource created in its transaction ($label)', async ({ proofs }) => {
        const account = await openAccount();
        const mutation = await withProfileAccount(account.scope, undefined, context =>
            prepareConnectedAccountCatalogMutationInContext(context, {
                expectedRevision: 9,
                record: { key: 'configurations', value: { v: 1, entries: [{
                    service: { pluginId: 'happier.provider.openai', localId: 'openai' }, modeId: 'api-key',
                    revision: '1', values: {}, secretRefs: { apiKey: 'happier:shared-secret:v1:new-resource' },
                }] } },
                savedSecretRevisions: proofs,
            }));
        expect(mutation).toMatchObject({ referencedSavedSecretIds: ['happier:shared-secret:v1:new-resource'],
            savedSecretRevisions: [{ resourceId: 'new-resource', expectedRevision: 1 }] });
        expect(account.writes).toEqual([]);
    });
    it('current connected configuration refuses an omitted reference declaration', async () => {
        const account = await openAccount();
        await expect(withProfileAccount(account.scope, undefined, context =>
            prepareConnectedAccountCatalogMutationInContext(context, {
                expectedRevision: 9,
                record: { key: 'configurations', value: { v: 1, entries: [{
                    service: { pluginId: 'happier.provider.openai', localId: 'openai' }, modeId: 'api-key',
                    revision: '1', values: {}, secretRefs: { apiKey: 'happier:shared-secret:v1:new-resource' },
                }] } },
                referencedSavedSecretIds: [], savedSecretRevisions: [],
            }))).rejects.toThrow('saved-secret-unavailable');
        expect(account.writes).toEqual([]);
    });
    it('refuses deletion when a current connected configuration references the resource', async () => {
        const account = await openAccount();
        account.catalogRows.set('/v1/account/entity-rows/connected-accounts/configurations', {
            status: 'present', revision: 9, content: { t: 'plain', v: {
                key: 'configurations', value: { v: 1, entries: [{
                    service: { pluginId: 'happier.provider.openai', localId: 'openai' }, modeId: 'api-key',
                    revision: '1', values: {}, secretRefs: { apiKey: 'happier:shared-secret:v1:referenced-resource' },
                }] },
            } },
        });
        account.setEffect(() => Response.json({ resourceId: 'referenced-resource' }));
        account.catalogReadPaths.length = 0;
        const result = await deleteSavedSecretResource({ scope: account.scope, resourceId: 'referenced-resource',
            expectedRevision: 3, expectedSettingsVersion: account.settingsVersion });
        expect([...new Set(account.catalogReadPaths)].sort()).toEqual([
            '/v1/account/entity-rows/acp',
            '/v1/account/entity-rows/connected-accounts/configurations',
            '/v1/account/entity-rows/connected-accounts/purposes',
            '/v1/account/entity-rows/mcp',
            '/v1/account/entity-rows/provider-connections',
            NOTIFICATION_CHANNELS_ROUTE_V1,
        ].sort());
        expect(result).toMatchObject({ ok: false, reason: 'in_use', references: [
            { owner: 'connectedAccountConfiguration' },
        ] });
        expect(account.writes).toEqual([]);
    });
    it.each([{ status: 'present', mode: 'plain' }, { status: 'present', mode: 'e2ee' },
        { status: 'absent', mode: 'plain' }, { status: 'deleted', mode: 'plain' }] as const)(
        'full reference capture retains the actual notification channel authority ($status, $mode)', async ({ status, mode }) => {
        const account = await openAccount(mode);
        const ref = 'happier:shared-secret:v1:notification-signing-resource';
        const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
            v: 1, id: 'notification-webhook', kind: 'webhook', url: 'https://notifications.example.test/hook',
            topics: {}, signingSecretRef: ref,
        }] });
        const content = await withProfileAccount(account.scope, undefined, (_context, accountMode, material) =>
            sealNotificationChannelCatalogContentV1({ record, mode: accountMode, material }));
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, status === 'present'
            ? { status, revision: 12, content }
            : status === 'deleted' ? { status, revision: 12 } : { status });
        if (status === 'present') {
            account.setEffect(() => Response.json({ resourceId: 'notification-signing-resource' }));
            expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'notification-signing-resource',
                expectedRevision: 4, expectedSettingsVersion: 7 })).toMatchObject({ ok: false, reason: 'in_use',
                references: [{ owner: 'notificationChannel', path: 'notificationChannelsCatalog.channels[0].signingSecretRef' }] });
        }
        const captured = await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode));
        expect(captured).toMatchObject({ ok: true });
        if (!captured.ok) throw new Error('Expected complete captured notification authority');
        expect(captured.catalogs.notificationChannels).toEqual(status === 'present' ? record : status === 'deleted' ? null : undefined);
        expect(captured.referenceCensus.notificationChannels).toEqual({ revision: status === 'absent' ? 'absent' : 12,
            resourceRefs: status === 'present' ? [ref] : [] });
        expect(account.writes).toEqual([]);
    });
    it('full reference capture refuses an incomplete notification channel before deletion dispatch', async () => {
        const account = await openAccount('plain');
        const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{
            v: 1, id: 'notification-webhook', kind: 'webhook', url: 'https://notifications.example.test/hook',
            topics: {}, signingSecretRef: null,
        }] });
        account.catalogRows.set(NOTIFICATION_CHANNELS_ROUTE_V1, { status: 'present', revision: 12,
            content: { t: 'plain', v: { ...record, channels: [{ ...record.channels[0],
                futureReference: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:notification-signing-resource' },
            }] } } });
        account.setEffect(() => Response.json({ resourceId: 'notification-signing-resource' }));
        expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'notification-signing-resource',
            expectedRevision: 4, expectedSettingsVersion: 7 })).toEqual({ ok: false, reason: 'unavailable' });
        expect(await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode))).toEqual({ ok: false, reason: 'unavailable' });
        expect(account.writes).toEqual([]);
    });
    it.each([{ status: 'present', mode: 'plain' }, { status: 'present', mode: 'e2ee' },
        { status: 'absent', mode: 'plain' }, { status: 'deleted', mode: 'plain' }] as const)(
        'full reference capture retains the actual RemoteHost authority ($status, $mode)', async ({ status, mode }) => {
        const account = await openAccount(mode);
        const ref = 'happier:shared-secret:v1:remote-host-password';
        const record = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{
            id: 'captured-host', name: 'Captured host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
            ssh: { target: 'user@host.example.test', authMode: 'password', passwordSecretRef: ref },
        }] });
        const content = await withProfileAccount(account.scope, undefined, (_context, accountMode, material) =>
            sealRemoteHostCatalogContentV1({ record, mode: accountMode, material }));
        account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, status === 'present'
            ? { status, revision: 14, content }
            : status === 'deleted' ? { status, revision: 14 } : { status });
        if (status === 'present') {
            account.setEffect(() => Response.json({ resourceId: 'remote-host-password' }));
            expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'remote-host-password',
                expectedRevision: 4, expectedSettingsVersion: 7 })).toMatchObject({ ok: false, reason: 'in_use',
                references: [{ owner: 'remoteHost' }] });
        }
        const captured = await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode));
        expect(captured).toMatchObject({ ok: true });
        if (!captured.ok) throw new Error('Expected complete captured RemoteHost authority');
        expect(captured.catalogs.remoteHostRecords).toEqual(status === 'present' ? record.hosts : status === 'deleted' ? null : undefined);
        expect(captured.referenceCensus.remoteHosts).toEqual({ revision: status === 'absent' ? 'absent' : 14,
            resourceRefs: status === 'present' ? [ref] : [] });
        expect(account.writes).toEqual([]);
    });
    it('full reference capture refuses a partial RemoteHost before deletion dispatch', async () => {
        const account = await openAccount();
        const record = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{
            id: 'captured-host', name: 'Captured host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
            ssh: { target: 'user@host.example.test', authMode: 'agent' },
        }] });
        account.catalogRows.set(REMOTE_HOST_ROWS_ROUTE_V1, { status: 'present', revision: 14,
            content: { t: 'plain', v: { ...record, hosts: [{ ...record.hosts[0],
                futureReference: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:remote-host-password' },
            }] } } });
        account.setEffect(() => Response.json({ resourceId: 'remote-host-password' }));
        expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'remote-host-password',
            expectedRevision: 4, expectedSettingsVersion: 7 })).toEqual({ ok: false, reason: 'unavailable' });
        expect(await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode))).toEqual({ ok: false, reason: 'unavailable' });
        expect(account.writes).toEqual([]);
    });
    it('refuses a full reference capture when a reached Profile Artifact cannot be opened', async () => {
        const account = await openAccount();
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'artifact-profile', enabled: true, promptStack: [],
            definition: { kind: 'artifact', artifactId: 'missing-profile-artifact' }, secretBindings: {} });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        // The real Artifact transport receives the fixture's HTTP 404; internal readers stay real.
        const capture = await withProfileAccount(account.scope, undefined, (context, mode) =>
            captureSavedSecretReferenceStateInContext(context, mode));
        expect(capture).toMatchObject({ ok: false, reason: 'unavailable' });
        expect(account.writes).toEqual([]);
    });
    it('refuses deletion before dispatch when a reference catalog cannot be opened', async () => {
        const account = await openAccount();
        account.catalogRows.set('/v1/account/entity-rows/connected-accounts/configurations', {
            status: 'present', revision: 9, content: { t: 'plain', v: {
                key: 'configurations', value: { v: 9, entries: [] },
            } },
        });
        account.setEffect(() => Response.json({ resourceId: 'resource-a' }));
        expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'resource-a',
            expectedRevision: 3, expectedSettingsVersion: account.settingsVersion })).toMatchObject({ ok: false });
        expect(account.writes).toEqual([]);
    });
    it('Settings Secrets offers recovery while its materials read never settles', async () => {
        const account = await openAccount();
        let releaseResponse!: () => void;
        const responsePending = new Promise<void>(resolve => { releaseResponse = resolve; });
        let materialPending = false;
        account.setBeforeMaterialRead(async () => { materialPending = true; await responsePending; });
        const { SecretsSettingsScreen } = await import('@/components/settings/secrets/SecretsSettingsScreen');
        const screen = await renderScreen(React.createElement(SecretsSettingsScreen));
        try {
            await vi.waitFor(() => expect(materialPending).toBe(true));
            expect(screen.findByTestId('saved-secret-catalog-loading')).not.toBeNull();
            expect(screen.findByTestId('saved-secret-catalog-retry-button')).not.toBeNull();
            expect(screen.findByTestId('saved-secret:empty')).toBeNull();
        } finally {
            account.setBeforeMaterialRead(undefined);
            releaseResponse();
            await act(async () => { await refreshSavedSecretCatalog(account.scope).catch(() => undefined); });
        }
        expect(screen.findByTestId('saved-secret-catalog-loading')).toBeNull();
        expect(screen.findByTestId('saved-secret:empty')).not.toBeNull();
    });

    it('Settings Secrets retries a failed initial materials read without presenting an empty catalog', async () => {
        const account = await openAccount();
        account.setMaterialReadStatus(503);
        const { SecretsSettingsScreen } = await import('@/components/settings/secrets/SecretsSettingsScreen');
        const screen = await renderScreen(React.createElement(SecretsSettingsScreen));
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(account.scope)?.status).toBe('error'));
        expect(screen.findByTestId('saved-secret:empty')).toBeNull();
        expect(screen.findByTestId('saved-secret-catalog-retry-button')).not.toBeNull();
        account.setMaterialReadStatus(200);
        await screen.pressByTestIdAsync('saved-secret-catalog-retry-button');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret:empty')).not.toBeNull());
        expect(getSavedSecretCatalogSnapshot(account.scope)?.status).toBe('ready');
    });

    it.each(['plain', 'e2ee'] as const)('Settings Secrets adopts a created %s row while legacy history never settles', async mode => {
        const account = await openAccount(mode);
        let releaseHistory!: () => void;
        const pendingHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
        let historyStarted = false;
        account.setBeforeHistoryRead(async () => { historyStarted = true; await pendingHistory; });
        account.setEffect(async (path, body) => {
            if (path.endsWith('/envelope-census')) return Response.json({ resourceId: [...account.resources.keys()][0],
                revision: 1, recipients: [], nextCursor: null });
            const input = SharedSavedSecretCreateInputV1Schema.parse(body);
            const key = mode === 'e2ee'
                ? await getSyncSingleton().encryption!.decryptEncryptionKey(input.keyEnvelopes![0]!.encryptedDataKey, account.scope)
                : null;
            account.materialRow(input.resourceId, mode, input.storedContent, 1, key ?? undefined);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        });
        const { SecretsSettingsScreen } = await import('@/components/settings/secrets/SecretsSettingsScreen');
        const screen = await renderScreen(React.createElement(SecretsSettingsScreen));
        let submission: Promise<void> | undefined;
        try {
            await vi.waitFor(() => expect(historyStarted).toBe(true));
            await screen.pressByTestIdAsync('saved-secret-add');
            await act(async () => {
                screen.changeTextByTestId('saved-secret-create-name', 'Created while history is pending');
                screen.changeTextByTestId('saved-secret-create-value', 'unused-fixture-value');
            });
            await screen.pressByTestIdAsync('saved-secret-create-storage:shared');
            // Observe adoption before awaiting the handler's catalog reload.
            submission = screen.pressByTestIdAsync('saved-secret-create-submit');
            await vi.waitFor(() => expect(account.resources.size).toBe(1));
            const resource = [...account.resources.values()][0]!;
            await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${resource.entry.ref}:header`)).not.toBeNull());
            expect(screen.findByTestId('saved-secret:empty')).toBeNull();
            expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({ status: 'ready', stale: false,
                data: [expect.objectContaining({ ref: resource.entry.ref, materialStatus: 'ready' })] });
        } finally {
            account.setBeforeHistoryRead(undefined);
            releaseHistory();
            await act(async () => {
                await submission;
                await refreshSavedSecretCatalog(account.scope).catch(() => undefined);
            });
        }
    });

    it.each(['plain', 'e2ee'] as const)('adopts a created %s secret when reload overlaps a pre-create catalog read', async mode => {
        const account = await openAccount(mode);
        let releaseResponse!: () => void;
        const responsePending = new Promise<void>(resolve => { releaseResponse = resolve; });
        let reads = 0;
        let oldCatalogPending = false;
        account.setBeforeMaterialRead(async () => {
            reads += 1;
            // The first read belongs to legacy-source admission; the second
            // is the engine's publication read, captured while the catalog is empty.
            if (reads === 2) {
                oldCatalogPending = true;
                await responsePending;
            }
        });
        account.setEffect(async (path, body) => {
            if (path.endsWith('/envelope-census')) return Response.json({ resourceId: [...account.resources.keys()][0],
                revision: 1, recipients: [], nextCursor: null });
            const input = SharedSavedSecretCreateInputV1Schema.parse(body);
            const key = mode === 'e2ee'
                ? await getSyncSingleton().encryption!.decryptEncryptionKey(input.keyEnvelopes![0]!.encryptedDataKey, account.scope)
                : null;
            account.materialRow(input.resourceId, mode, input.storedContent, 1, key ?? undefined);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        });
        const initialRead = refreshSavedSecretCatalog(account.scope);
        try {
            await vi.waitFor(() => expect(oldCatalogPending).toBe(true));
            const created = await createSavedSecretResource({ scope: account.scope, name: 'New key', kind: 'token', value: 'private-value',
                accountGrants: [], teamGrants: [], groupGrants: [] });
            expect(created).toMatchObject({ ok: true, revision: 1 });
            if (!created.ok) throw new Error('Expected the real create owner to accept the resource');
            const reload = refreshSavedSecretCatalog(account.scope);
            releaseResponse();
            await Promise.all([initialRead, reload]);
            expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({
                status: 'ready', stale: false,
                data: [expect.objectContaining({ ref: created.resourceRef, materialStatus: 'ready' })],
                materializedSecrets: [expect.objectContaining({ id: created.resourceRef, name: 'New key',
                    encryptedValue: { _isSecretValue: true, value: 'private-value' } })],
            });
        } finally {
            releaseResponse();
            await initialRead;
        }
    });

    it.each(['plain', 'e2ee'] as const)('creates %s material with exact initial grants and a usable owner envelope', async mode => {
        const account = await openAccount(mode);
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretCreateInputV1Schema.parse(body);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        });
        const result = await createSavedSecretResource({ scope: account.scope, name: 'Key', kind: 'token', value: 'private-value',
            accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'] });
        expect(result).toMatchObject({ ok: true, revision: 1 });
        expect(account.writes.filter(write => write.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'])).toHaveLength(1);
        const input = SharedSavedSecretCreateInputV1Schema.parse(account.writes[0]!.body);
        expect(input).toMatchObject({ encryptionMode: mode, accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'] });
        const key = mode === 'e2ee' ? await getSyncSingleton().encryption!.decryptEncryptionKey(input.keyEnvelopes![0]!.encryptedDataKey, account.scope) : null;
        const opened = mode === 'plain'
            ? openSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode, storedContent: input.storedContent })
            : key ? openSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode, storedContent: input.storedContent, resourceDataKey: key }) : null;
        expect(opened).toMatchObject({ value: 'private-value' });
        if (mode === 'plain') expect(input.keyEnvelopes).toBeUndefined();
        else { expect(input.keyEnvelopes![0]!.recipientAccountId).toBe(account.scope.accountId); expect(JSON.stringify(input)).not.toContain('private-value'); }
    });

    it.each([false, true])('proves a lost create response only from its ready owned material identity (visible: %s)', async visible => {
        const account = await openAccount();
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretCreateInputV1Schema.parse(body);
            if (visible) account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            throw new TypeError('Network connection lost after commit');
        });
        expect(await createSavedSecretResource({ scope: account.scope, name: 'Key', kind: 'token', value: 'private-value',
            accountGrants: [], teamGrants: [], groupGrants: [] })).toMatchObject(visible
                ? { ok: true, revision: 1 } : { ok: false, reason: 'outcome_unknown' });
        expect(account.writes).toHaveLength(1);
    });

    it('promotes through one Settings/resource/Profile composite and keeps unrelated source bytes', async () => {
        const secret = { id: 'personal-a', name: 'Key', kind: 'token' as const, createdAt: 1, updatedAt: 4,
            encryptedValue: { _isSecretValue: true as const, value: 'private-value' } };
        const account = await openAccount('plain', { raw: { secrets: [secret], futureSibling: { preserve: true },
            mcpServersSettingsV1: { v: 1, strictMode: false, servers: [{ id: 'server-a', env: { TOKEN: { t: 'savedSecret', secretId: secret.id } } }], bindings: [] } } });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'profile-a', enabled: true, promptStack: [],
            definition: { kind: 'legacy', profile: { id: 'profile-a', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
            secretBindings: { TOKEN: 'personal-a' } });
        account.rows.push({ id: record.id, revision: 2, content: { t: 'plain', v: record } });
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretPromoteInputV1Schema.parse(body);
            if (input.nextSettings?.t !== 'plain') throw new Error('Expected Plain composite');
            account.raw = input.nextSettings.v;
            account.settingsVersion = 8;
            account.materialRow(input.resourceId, 'plain', input.storedContent, 1);
            for (const mutation of input.profileMutations) {
                if (mutation.operation !== 'update') throw new Error('Expected an existing Profile update');
                const row = account.rows.find(candidate => candidate.id === mutation.id);
                if (!row) throw new Error('Expected the source Profile');
                Object.assign(row, { content: mutation.content, revision: mutation.expectedRevision + 1 });
            }
            account.referenceGuardRevision += 1;
            return Response.json({ resourceId: input.resourceId, settingsVersion: 8 });
        });
        const result = await promotePersonalSavedSecretResource({ scope: account.scope, expectedSettingsVersion: 7, secret,
            accountGrants: ['recipient-a'], teamGrants: [], groupGrants: [] });
        expect(result).toMatchObject({ ok: true });
        const input = SharedSavedSecretPromoteInputV1Schema.parse(account.writes[0]!.body);
        expect(input.referenceCensus).toMatchObject({ catalogs: {
            mcp: 'absent', acp: 'absent', providerConnections: 'absent',
            connectedConfigurations: 'absent', connectedPurposes: 'absent',
        } });
        expect(input.nextSettings).toMatchObject({ t: 'plain', v: { secrets: [], futureSibling: { preserve: true } } });
        if (!result.ok) throw new Error('Expected acknowledged promotion');
        expect(input.nextSettings).toMatchObject({ v: { mcpServersSettingsV1: { servers: [{ env: { TOKEN: { secretId: result.resourceRef } } }] } } });
        expect(input.profileMutations).toEqual([expect.objectContaining({ operation: 'update', id: record.id, expectedRevision: 2,
            content: expect.objectContaining({ v: expect.objectContaining({ secretBindings: { TOKEN: result.resourceRef } }) }) })]);
        const promotionWrites = account.writes.filter(write => write.path.endsWith('/promote'));
        expect(promotionWrites).toHaveLength(1);
        expect(promotionWrites[0]?.body).toHaveProperty('personalSecretPromotions', [{ personalSecretId: secret.id, resourceId: input.resourceId }]);
        expect(account.writes.some(write => write.path === '/v2/account/settings')).toBe(false);
    });

    it.each(['rename', 'to-plain', 'to-e2ee'] as const)('reopens and reseals resource content for %s without retaining the opened key', async transition => {
        const account = await openAccount('e2ee');
        const resourceMode = transition === 'to-e2ee' ? 'plain' : 'e2ee';
        const openedKey = new Uint8Array(32).fill(9);
        const content = { v: 1 as const, name: 'Key', kind: 'token' as const, value: 'private-value' };
        const storedContent = resourceMode === 'plain'
            ? sealSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode: resourceMode, content })
            : sealSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode: resourceMode, content, resourceDataKey: openedKey, randomBytes: tweetnacl.randomBytes });
        account.materialRow('resource-a', resourceMode, storedContent, 3,
            resourceMode === 'e2ee' ? openedKey : undefined);
        account.setEffect((_path, body) => {
            const input = SharedSavedSecretUpdateInputV1Schema.parse(body);
            return Response.json({ resourceId: input.resourceId, revision: 4 });
        });
        expect(await updateSavedSecretResource({ scope: account.scope, resourceId: 'resource-a', expectedRevision: 3,
            nextName: 'Renamed', ...(transition === 'rename' ? {} : { toMode: transition === 'to-plain' ? 'plain' : 'e2ee' }),
            decryptDataKeyEnvelope: async () => openedKey })).toEqual({ ok: true });
        const input = SharedSavedSecretUpdateInputV1Schema.parse(account.writes[0]!.body);
        const mode = transition === 'to-plain' ? 'plain' : 'e2ee';
        const sealingKey = transition === 'to-e2ee'
            ? await getSyncSingleton().encryption!.decryptEncryptionKey(input.keyEnvelopes![0]!.encryptedDataKey, account.scope)
            : new Uint8Array(32).fill(9);
        const opened = mode === 'plain'
            ? openSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode, storedContent: input.storedContent })
            : sealingKey ? openSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode, storedContent: input.storedContent, resourceDataKey: sealingKey }) : null;
        expect(opened).toMatchObject({ name: 'Renamed', value: 'private-value' });
        if (resourceMode === 'e2ee') expect(openedKey).toEqual(new Uint8Array(32));
        if (transition === 'to-e2ee') expect(input.keyEnvelopes![0]!.recipientAccountId).toBe(account.scope.accountId);
    });

    it.each([false, true])('deletes only after the real owner reference census (in use: %s)', async inUse => {
        const account = await openAccount('plain', { raw: inUse ? { mcpServersSettingsV1: { v: 1, strictMode: false,
            servers: [{ id: 'server-a', env: { TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:resource-a' } } }], bindings: [] } } : {} });
        account.setEffect(() => Response.json({ resourceId: 'resource-a' }));
        expect(await deleteSavedSecretResource({ scope: account.scope, resourceId: 'resource-a',
            expectedRevision: 3, expectedSettingsVersion: 7 })).toMatchObject(inUse ? { ok: false, reason: 'in_use' } : { ok: true });
        expect(account.writes.filter(write => write.path.endsWith('/delete'))).toHaveLength(inUse ? 0 : 1);
        if (!inUse) expect(account.writes[0]!.body).toMatchObject({ resourceId: 'resource-a', expectedRevision: 3,
            expectedSettingsVersion: 7, referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 3, rows: [] } } });
    });

    it('keeps uncertain audience replacement visible for read-back recovery', async () => {
        const account = await openAccount();
        account.setEffect(() => { throw new TypeError('Network connection lost after commit'); });
        expect(await setSavedSecretResourceGrants({ scope: account.scope, resourceId: 'resource-a', expectedRevision: 3,
            encryptionMode: 'plain', accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'],
            decryptDataKeyEnvelope: async () => null })).toEqual({ ok: false, reason: 'outcome_unknown' });
        expect(account.writes).toHaveLength(1);
        expect(SharedSavedSecretGrantsSetInputV1Schema.parse(account.writes[0]!.body)).toMatchObject({
            accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'] });
    });

    it.each(['grants', 'custody', 'already-prepared'] as const)('prepares only owed ready E2EE recipient envelopes (%s)', async phase => {
        const account = await openAccount('e2ee');
        const key = new Uint8Array(32).fill(9);
        const content = sealSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode: 'e2ee', resourceDataKey: key,
            content: { v: 1, name: 'Key', kind: 'token', value: 'private-value' }, randomBytes: tweetnacl.randomBytes });
        account.materialRow('resource-a', 'e2ee', content, phase === 'grants' ? 3 : 4, key);
        account.materialRow('received-a', 'e2ee', sealSavedSecretResourceStoredContentV1({ resourceId: 'received-a', mode: 'e2ee', resourceDataKey: key,
            content: { v: 1, name: 'Received', kind: 'token', value: 'received-private' }, randomBytes: tweetnacl.randomBytes }), 4, key, 'recipient');
        account.materialRow('plain-a', 'plain', { t: 'plain', v: { v: 1, name: 'Plain', kind: 'token', value: 'plain' } });
        const recipientSeed = new Uint8Array(32).fill(17);
        const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSeed).publicKey;
        const recipientFingerprint = computeContentPublicKeyFingerprint(recipientPublicKey);
        account.setEffect((path, body) => {
            if (path.endsWith('/envelope-census')) return Response.json({ resourceId: 'resource-a', revision: 4, nextCursor: null,
                recipients: [
                    { account: { kind: 'account', accountId: 'plain-recipient', firstName: null, lastName: null, username: null, avatarUrl: null }, readiness: { status: 'unavailable', reason: 'plain_account' }, envelopeStatus: 'missing' },
                    { account: { kind: 'account', accountId: 'ready-recipient', firstName: null, lastName: null, username: null, avatarUrl: null }, readiness: { status: 'available',
                        contentPublicKey: encodeBase64(recipientPublicKey, 'base64'), contentPublicKeyFingerprint: recipientFingerprint },
                        envelopeStatus: phase === 'already-prepared' ? 'prepared' : 'missing' },
                ] });
            if (path.endsWith('/grants')) {
                SharedSavedSecretGrantsSetInputV1Schema.parse(body);
                return Response.json({ resourceId: 'resource-a', revision: 4 });
            }
            const repair = SavedSecretResourceEnvelopeRepairInputV1Schema.parse(body);
            return Response.json({ resourceId: repair.resourceId, revision: 4 });
        });
        if (phase === 'grants') expect(await setSavedSecretResourceGrants({ scope: account.scope, resourceId: 'resource-a', expectedRevision: 3,
            encryptionMode: 'e2ee', accountGrants: ['plain-recipient', 'ready-recipient'], teamGrants: [], groupGrants: [],
            decryptDataKeyEnvelope: async () => key })).toEqual({ ok: true });
        else await repairCustodiedSavedSecretResourceEnvelopesBestEffort({ scope: account.scope, decryptDataKeyEnvelope: async () => key });
        expect(account.censusReads).toHaveLength(1);
        expect(new URL(account.censusReads[0]!).searchParams.get('resourceId')).toBe('resource-a');
        const repairs = account.writes.filter(write => write.path.endsWith('/envelopes/repair'));
        expect(repairs).toHaveLength(phase === 'already-prepared' ? 0 : 1);
        if (repairs.length) {
            const repair = SavedSecretResourceEnvelopeRepairInputV1Schema.parse(repairs[0]!.body);
            expect(repair).toMatchObject({ resourceId: 'resource-a', expectedRevision: 4,
                keyEnvelopes: [{ recipientAccountId: 'ready-recipient', recipientContentPublicKeyFingerprint: recipientFingerprint }] });
            expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(repair.keyEnvelopes[0]!.encryptedDataKey, 'base64'),
                recipientSecretKeyOrSeed: recipientSeed })).toEqual(new Uint8Array(32).fill(9));
        }
        expect(key).toEqual(new Uint8Array(32));
    });

    it.each(['create', 'update', 'delete', 'grants'] as const)('settles the exact approved %s result without redispatching the mutation', async operation => {
        const account = await openAccount('plain', { ask: true });
        account.materialRow('resource-a', 'plain', { t: 'plain', v: { v: 1, name: 'Key', kind: 'token', value: 'private-value' } });
        if (operation === 'delete') await refreshSavedSecretCatalog(account.scope);
        const succeeded = vi.fn();
        const failed = vi.fn();
        const common = { scope: account.scope, onApprovalSucceeded: succeeded, onApprovalFailed: failed };
        const execution = operation === 'create' ? createSavedSecretResource({ ...common, name: 'Key', kind: 'token', value: 'private-value', accountGrants: [], teamGrants: [], groupGrants: [] })
            : operation === 'update' ? updateSavedSecretResource({ ...common, resourceId: 'resource-a', expectedRevision: 3, nextName: 'New', decryptDataKeyEnvelope: async () => null })
            : operation === 'delete' ? deleteSavedSecretResource({ ...common, resourceId: 'resource-a', expectedRevision: 3, expectedSettingsVersion: 7 })
            : setSavedSecretResourceGrants({ ...common, resourceId: 'resource-a', expectedRevision: 3, encryptionMode: 'plain', accountGrants: ['account-b'], teamGrants: [], groupGrants: [], decryptDataKeyEnvelope: async () => null });
        const pending = await execution.catch((error: unknown) => error);
        expect(pending).toBeInstanceOf(TeamActionApprovalPendingError);
        if (!(pending instanceof TeamActionApprovalPendingError) || typeof pending.registration === 'string') throw new Error('Expected result-bearing approval');
        expect(account.artifacts).toHaveLength(1);
        const artifact = account.artifacts[0]!;
        const body = decodePlainArtifactStoredContent(artifact.body!);
        if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected Plain Artifact body');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(Reflect.get(body, 'body')));
        if (request.v !== 2) throw new Error('Expected canonical immutable approval origin');
        const resourceId = operation === 'create' && request.actionArgs && typeof request.actionArgs === 'object'
            ? Reflect.get(request.actionArgs, 'resourceId') : 'resource-a';
        const result = operation === 'delete' ? { resourceId } : { resourceId, revision: 4 };
        const settledAt = request.createdAtMs + 1;
        const settled: ApprovalRequestV2 = { ...request, status: 'executed', updatedAtMs: settledAt,
            decision: { kind: 'approve', decidedAtMs: settledAt }, execution: { ok: true, executedAtMs: settledAt, result } };
        const observation: DecryptedArtifact = { id: artifact.id, header: buildApprovalRequestArtifactHeaderV1(settled),
            body: JSON.stringify(settled), headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2, isDecrypted: true };
        if (operation === 'delete') {
            account.resources.delete('resource-a');
            account.setMaterialReadStatus(503);
        }
        expect(await pending.registration.onExecuted(observation)).toBe('consumed');
        if (operation === 'delete') expect(getSavedSecretCatalogSnapshot(account.scope)?.data).toEqual([]);
        expect(succeeded).toHaveBeenCalledWith(operation === 'create'
            ? { ok: true, resourceRef: `happier:shared-secret:v1:${String(resourceId)}`, revision: 4 } : result);
        expect(failed).not.toHaveBeenCalled();
        expect(account.writes).toEqual([]);
    });
});
