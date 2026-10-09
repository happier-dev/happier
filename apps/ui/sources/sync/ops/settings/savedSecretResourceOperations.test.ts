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
import { SavedSecretResourceMaterialsResponseV1Schema, formatSavedSecretCatalogFingerprintV1, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
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
    captureSavedSecretReferenceStateInContext } from './savedSecretResourceOperations';
import { withProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { prepareConnectedAccountCatalogMutationInContext, readConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { ConnectedAccountCatalogRowMutationV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { deriveSavedSecretImportResourceIdV1, qualifyPluginAccountSecretBindingKey } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
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
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogRecordV1Schema,
    sealNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

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
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
beforeEach(() => { resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); resetServerFeaturesClientForTests(); });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { await standardCleanup(); await connection?.dispose(); connection = null; resetTeamActionClientForTests(); });

/** Only HTTP, credentials and Socket transport are substituted; Account/Action/Settings/crypto owners stay real. */
async function openAccount(mode: 'plain' | 'e2ee' = 'plain', options: { ask?: boolean; teams?: boolean; home?: string; raw?: Record<string, unknown> } = {}) {
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
    const resources = new Map<string, SavedSecretResourceMaterialV1>();
    const rows: ProfileRowV1[] = [];
    const catalogRows = new Map<string, unknown>();
    const writes: { path: string; body: unknown }[] = [];
    const censusReads: string[] = [];
    const catalogReadPaths: string[] = [];
    const artifacts: Artifact[] = [];
    let materialReadStatus = 200;
    let beforeMaterialRead: (() => void) | undefined;
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
                if (input.expectedVersion !== settingsVersion) return Response.json({ success: false,
                    error: 'version-mismatch', currentVersion: settingsVersion, currentContent: sourceContent() });
                if (input.content?.t !== 'plain') throw new Error('Fixture Settings mutation requires Plain content');
                raw = input.content.v;
                settingsVersion += 1;
                return Response.json({ success: true, version: settingsVersion });
            }
            if (path === '/v2/account/settings') return Response.json({ content: sourceContent(), version: settingsVersion });
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows, nextCursor: null,
                complete: true, referenceGuardRevision: 3, transferControl: { status: 'absent' }, diagnostics: [] });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 3 });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === REMOTE_HOST_ROWS_ROUTE_V1) return Response.json({ status: 'absent' });
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
                beforeMaterialRead?.();
                return materialReadStatus === 200
                    ? Response.json({ resources: [...resources.values()] })
                    : Response.json({ error: 'temporarily_unavailable' }, { status: materialReadStatus });
            }
            if (path === '/v1/account/saved-secrets/resources/envelope-census' && effect) {
                censusReads.push(String(rawUrl));
                return effect(path, undefined);
            }
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
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
    return { scope, writes, censusReads, catalogReadPaths, artifacts, rows, catalogRows, resources, materialRow,
        get raw() { return raw; }, set raw(value: Record<string, unknown>) { raw = value; },
        get settingsVersion() { return settingsVersion; }, set settingsVersion(value: number) { settingsVersion = value; },
        setMaterialReadStatus(value: number) { materialReadStatus = value; },
        setBeforeMaterialRead(value: (() => void) | undefined) { beforeMaterialRead = value; },
        rotateServerContentKey() { serverCredentials = { ...serverCredentials, secret: encodeBase64(new Uint8Array(32).fill(25), 'base64url') }; },
        setPersistedMode(value: 'plain' | 'e2ee') { persistedMode = value; },
        setEffect(value: typeof effect) { effect = value; } };
}

describe('Saved Secret operations through their real Account and Action owners', () => {
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
    it.each([{ conflict: false, previousShared: false, throughVoice: false }, { conflict: true, previousShared: false, throughVoice: false },
        { conflict: false, previousShared: true, throughVoice: false },
        { conflict: false, previousShared: true, throughVoice: true }])('full reference credential save commits Voice, purpose and Profile bindings atomically (conflict: $conflict, previous shared: $previousShared, Voice entry: $throughVoice)', async ({ conflict, previousShared, throughVoice }) => {
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
            expect(account.resources.size).toBe(throughVoice ? 1 : 2);
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
    it('full reference credential save refuses an unprepared notification catalog change before creating its resource', async () => {
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
                catalogs: { ...catalogs, notificationChannels: NotificationChannelCatalogRecordV1Schema.parse({ ...record,
                    channels: record.channels.map(channel => channel.kind === 'webhook'
                        ? { ...channel, signingSecretRef: resourceRefs.get(draft.id)! } : channel) }) },
            }),
        });
        expect(result).toEqual({ ok: false, reason: 'unavailable' });
        expect(account.resources.size).toBe(0);
        expect(account.catalogRows.get(NOTIFICATION_CHANNELS_ROUTE_V1)).toEqual({ status: 'present', revision: 12, content });
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
        ['plain', 'matching'], ['plain', 'changed-row'], ['plain', 'changed-resource'], ['plain', 'incomplete-audience'], ['plain', 'retired-scope'],
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
        expect(await pending.registration.onExecuted(observation)).toBe('consumed');
        expect(succeeded).toHaveBeenCalledWith(operation === 'create'
            ? { ok: true, resourceRef: `happier:shared-secret:v1:${String(resourceId)}`, revision: 4 } : result);
        expect(failed).not.toHaveBeenCalled();
        expect(account.writes).toEqual([]);
    });
});
