import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { encodeBase64 } from '@/encryption/base64';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, useCurrentSecretBindingsByProfileIdMutable } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { beginProfileCatalogLoad, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, ProfileRowReadRequestV1Schema,
    ProfileRecordV1Schema, ProfileRowMutationV1Schema, type ProfileRecordV1, type ProfileRowMutationV1,
    type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactReferenceV1Schema, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { settingsParse } from '@/sync/domains/settings/settings';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { readProfileCatalogInContext } from '@/sync/api/account/apiProfileCatalog';
import { createApiAuthoringMemoryTransport } from '@/sync/api/account/apiAuthoringMemory';
import { createAuthoringMemorySync } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { retireLegacyAuthoringMemoryKey } from '@/sync/engine/settings/syncSettings';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { AuthoringMemoryMutationRequestV1Schema, buildProjectLastOpenedMemoryKeyV1,
    type AuthoringMemoryRowV1 } from '@happier-dev/protocol/account/authoringMemory';
import { importLegacyAuthoringMemorySetting } from '@happier-dev/protocol/account/authoringMemoryImport';
import { LegacyLastUsedProfileSchema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { useApplyProfileSave, useDeleteAiLaunchProfile, useProfileFavoriteIdsMutable } from '@/sync/store/settingsWriters';
import { useProfilesCollection } from '@/components/settings/profiles/useProfilesCollection';
import { useSaveLaunchProfile } from '@/components/profiles/edit/useSaveLaunchProfile';
import { useLegacyProfileSecretRequirements } from '@/components/profiles/edit/legacy/useLegacyProfileSecretRequirements';
import { useProfilePromptStack } from '@/sync/store/useProfilePromptStack';
import { Modal } from '@/modal';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createArtifactListHttpResponse, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});

const navigationBoundary = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigationBoundary }).module);
// Only HTTP, credential persistence and native navigation boundaries are substituted.
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    router: async () => {
        const [{ createExpoRouterMock }, { createReactNavigationNativeMock }] = await Promise.all([
            import('@/dev/testkit/mocks/router'), import('@/dev/testkit/mocks/reactNavigation'),
        ]);
        return createExpoRouterMock({ router: navigationBoundary,
            navigation: createReactNavigationNativeMock().useNavigation() }).module;
    } });
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { useNewSessionProfileActions } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionProfileActions');
const { router } = await import('expo-router');
const { ProfileDetailScreen } = await import('@/components/settings/profiles/ProfileDetailScreen');
const initialState = getStorage().getState();
beforeAll(loadSyncSingletonForTests);
beforeEach(() => { vi.spyOn(Modal, 'confirm').mockResolvedValue(true); });
let disposeConnection: (() => Promise<void>) | undefined;
afterEach(async () => {
    standardCleanup();
    await disposeConnection?.();
    disposeConnection = undefined;
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialState, true);
    vi.restoreAllMocks();
});

async function fixture() {
    // Static imports can initialize the shared approval router before its optional
    // factory is installed. Observe the actual native boundary consumed by Actions.
    const navigation = {
        push: vi.spyOn(router, 'push').mockClear(),
        replace: vi.spyOn(router, 'replace').mockClear(),
        back: vi.spyOn(router, 'back').mockClear(),
    };
    const home = await upsertAndActivateServer({ serverUrl: 'https://profile-action-home.test', scope: 'tab' });
    await upsertAndActivateServer({ serverUrl: 'https://focused-profile-action-home.test', scope: 'tab' });
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    let memoryRevision: number | 'absent' = 2;
    let memory: unknown = { t: 'plain', v: 'previous' };
    let failMemoryWrites = false;
    let neighboringMemory: AuthoringMemoryRowV1 = {
        key: buildProjectLastOpenedMemoryKeyV1({ serverId: home.id, projectKey: 'neighbor-project' }),
        revision: 7, content: { t: 'plain', v: 123 },
    };
    let pendingAcknowledgement: (() => void) | undefined;
    const settingsMutations: unknown[] = [];
    const requests: string[] = [];
    let holdAcknowledgement = false;
    let settingsVersion = 1;
    let settings: Record<string, unknown> = { favoriteProfiles: ['existing'], futurePreference: { version: 'initial' } };
    let conflictFavorite = false;
    let rows: ProfileRowV1[] = [];
    const catalogAfterWrite = { pending: false, readStarted: false, release: undefined as (() => void) | undefined };
    const settingsAfterWrite = { pending: false, readStarted: false, readsAfterWrite: 0, release: undefined as (() => void) | undefined };
    const delayedProfileReceipt = { pending: false, committed: false, release: undefined as (() => void) | undefined };
    const historyCleanup = { active: false, pending: false, release: undefined as (() => void) | undefined };
    const transferControl = () => historyCleanup.active ? { status: 'present', revision: 1, content: { t: 'plain', v: {
        v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [],
    } } } : { status: 'absent' };
    let referenceGuardRevision: number | 'absent' = 'absent';
    const profileMutations: ProfileRowMutationV1[] = [];
    const artifacts = new Map<string, Artifact>();
    const approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
    let approvalEnabled = false;
    let ownedArtifactEnabled = false;
    let artifactWriteAcknowledged = false;
    const savedSecretResources = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId: 'private-key', encryptionMode: 'plain',
        entry: { ref: formatSharedSavedSecretRefV1('private-key'), source: 'shared_resource', relationship: 'owner',
            name: 'Private key', kind: 'apiKey', revision: 3, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: { t: 'plain', v: { v: 1, name: 'Private key', kind: 'apiKey', value: 'private-material-not-for-publication' } },
        recipientEnvelope: null,
    }] });
    const editableRecord = (id: string, attachments?: Pick<ProfileRecordV1, 'enabled' | 'promptStack' | 'secretBindings'>) =>
        ProfileRecordV1Schema.parse({ v: 1, id, enabled: true, promptStack: [], secretBindings: {}, ...attachments,
            definition: { kind: 'inline', profile: { v: 2, id, name: 'Editable', createdAt: 1, updatedAt: 1,
                extraEnvironmentVariables: [], envVarRequirements: [{ name: 'API_KEY', kind: 'secret', required: true }],
                defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} } } });
    const http: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        expect(target.origin).toBe(home.serverUrl);
        requests.push(`${init?.method ?? 'GET'} ${target.pathname}`);
        if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture(
            historyCleanup.active ? { settingsVersion } : {}));
        if (target.pathname === '/v2/account/settings') {
            if (init?.method === 'POST') {
                const input = JSON.parse(String(init.body)) as { expectedVersion: number; content: { t: 'plain'; v: Record<string, unknown> } };
                settingsMutations.push(input);
                expect(input.expectedVersion).toBe(settingsVersion);
                if (conflictFavorite) {
                    conflictFavorite = false;
                    settings = { favoriteProfiles: ['other-device'], futurePreference: { version: 'concurrent' } };
                    settingsVersion += 1;
                    return Response.json({ success: false, error: 'version-mismatch', currentVersion: settingsVersion,
                        currentContent: { t: 'plain', v: settings } });
                }
                settings = input.content.v;
                settingsVersion += 1;
                return Response.json({ success: true, version: settingsVersion });
            }
            // Hold the refresh read, not the separate authoritative remembered-selection cleanup read.
            // The cleanup read is the Action's own awaited step and reaches the Home first; the refresh
            // read follows its Account currentness check.
            if (settingsAfterWrite.pending && !settingsAfterWrite.readStarted && profileMutations.some(mutation => mutation.settingsCleanup)
                && ++settingsAfterWrite.readsAfterWrite === 2) {
                settingsAfterWrite.readStarted = true;
                await new Promise<void>(resolve => { settingsAfterWrite.release = resolve; });
            }
            return Response.json({ content: { t: 'plain', v: settings }, version: settingsVersion });
        }
        if (target.pathname === '/v1/account/authoring-memory') return Response.json({ rows: [
            ...(memoryRevision === 'absent' ? [] : [{ key: 'lastUsedProfile', revision: memoryRevision, content: memory }]),
            neighboringMemory,
        ] });
        if (target.pathname === '/v1/account/authoring-memory/lastUsedProfile') {
            if (init?.method === 'POST') {
                if (failMemoryWrites) return Response.json({ error: 'authoring_memory_storage_unavailable' }, { status: 503 });
                const input = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
                if (input.expectedRevision !== memoryRevision) {
                    return Response.json({ status: 'conflict', revision: memoryRevision === 'absent' ? -1 : memoryRevision });
                }
                if (holdAcknowledgement) await new Promise<void>(resolve => { pendingAcknowledgement = resolve; });
                memory = input.content;
                memoryRevision = memoryRevision === 'absent' ? 1 : memoryRevision + 1;
                return Response.json({ status: 'updated', revision: memoryRevision, cursor: 3 });
            }
            return Response.json(memoryRevision === 'absent' ? { status: 'absent' } : memory === null
                ? { status: 'deleted', revision: memoryRevision } : { status: 'present', revision: memoryRevision, content: memory });
        }
        if (target.pathname === `/v1/account/authoring-memory/${encodeURIComponent(neighboringMemory.key)}`) {
            if (init?.method === 'POST') {
                const input = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
                if (input.expectedRevision !== neighboringMemory.revision) {
                    return Response.json({ status: 'conflict', revision: neighboringMemory.revision });
                }
                neighboringMemory = { ...neighboringMemory, revision: neighboringMemory.revision + 1, content: input.content };
                return Response.json({ status: 'updated', revision: neighboringMemory.revision, cursor: neighboringMemory.revision });
            }
            return Response.json(neighboringMemory.content === null ? { status: 'deleted', revision: neighboringMemory.revision }
                : { status: 'present', revision: neighboringMemory.revision, content: neighboringMemory.content });
        }
        if (target.pathname === '/v1/account/entity-rows/profiles') {
            if (catalogAfterWrite.pending && (profileMutations.length > 0 || artifactWriteAcknowledged)) {
                catalogAfterWrite.readStarted = true;
                await new Promise<void>(resolve => { catalogAfterWrite.release = resolve; });
            }
            return Response.json({ status: 'listed', rows,
                nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision, transferControl: transferControl() });
        }
        if (target.pathname.endsWith('/profiles/reference-guard')) return Response.json({ status: 'ready', revision: referenceGuardRevision });
        if (target.pathname.endsWith('/profiles/transfer')) return Response.json(transferControl());
        if (target.pathname === PROFILE_RECORD_READ_ROUTE_V1 && init?.method === 'POST') {
            const { id } = ProfileRowReadRequestV1Schema.parse(JSON.parse(String(init.body)));
            const current = rows.find(row => row.id === id);
            return Response.json(current ? current.content
                ? { status: 'present', revision: current.revision, content: current.content }
                : { status: 'deleted', revision: current.revision } : { status: 'absent' });
        }
        if (target.pathname === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
            const mutation = ProfileRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            const id = mutation.id;
            const current = rows.find(row => row.id === id);
            profileMutations.push(mutation);
            if (mutation.expectedRevision !== (current?.revision ?? 'absent')) {
                return Response.json({ status: 'conflict', revision: current?.revision ?? -1 });
            }
            if (mutation.settingsCleanup) {
                if (mutation.settingsCleanup.expectedSettingsVersion !== settingsVersion) {
                    return Response.json({ status: 'settings-conflict', revision: settingsVersion });
                }
                expect(mutation.settingsCleanup.nextSettings?.t).toBe('plain');
                if (mutation.settingsCleanup.nextSettings?.t !== 'plain') throw new Error('Fixture Account is Plain');
                settings = mutation.settingsCleanup.nextSettings.v;
                settingsVersion += 1;
            }
            if (holdAcknowledgement) await new Promise<void>(resolve => { pendingAcknowledgement = resolve; });
            const revision = (current?.revision ?? 0) + 1;
            referenceGuardRevision = referenceGuardRevision === 'absent' ? 1 : referenceGuardRevision + 1;
            rows = [...rows.filter(row => row.id !== id), { id, revision, content: mutation.content }];
            if (delayedProfileReceipt.pending) {
                delayedProfileReceipt.pending = false;
                delayedProfileReceipt.committed = true;
                await new Promise<void>(resolve => { delayedProfileReceipt.release = resolve; });
            }
            return Response.json({ status: 'updated', revision, cursor: revision, referenceGuardRevision });
        }
        if (target.pathname === '/v1/account/saved-secrets/resources')
            return Response.json({ resources: savedSecretResources.resources.map(resource => resource.entry) });
        if (target.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json(savedSecretResources);
        if (approvalEnabled || ownedArtifactEnabled) {
            const response = approvalArtifacts.handle(`${target.pathname}${target.search}`, init);
            if (response) {
                const result = await response;
                if (ownedArtifactEnabled && target.pathname === '/v1/artifacts/owned-definition' && init?.method === 'POST' && result.ok)
                    artifactWriteAcknowledged = true;
                return result;
            }
        }
        if (target.pathname === '/v1/artifacts') {
            if (init?.method === 'POST') {
                // The genuine HTTP boundary carries this incumbent typed Artifact create DTO.
                const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                const stored: Artifact = { ...input, ...projectArtifactStoredKind(input.kind), ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: artifacts.size + 1, createdAt: 1, updatedAt: 1 };
                artifacts.set(stored.id, stored);
                return Response.json(stored);
            }
            // The shared Home list framing owns kind, kinds, unclassified and coverage selection.
            return createArtifactListHttpResponse(target, [...artifacts.values()]);
        }
        if (target.pathname.startsWith('/v1/artifacts/')) {
            const artifact = artifacts.get(decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length)));
            if (artifact) return Response.json(artifact);
        }
        if (target.pathname === '/v2/account/settings/history') {
            if (historyCleanup.active) {
                historyCleanup.pending = true;
                await new Promise<void>(resolve => { historyCleanup.release = resolve; });
            }
            return Response.json({ snapshots: [] });
        }
        // This Home publishes no Machines: each exact id the batch read asks for is absent.
        if (target.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
            const demand = MachineReadBatchRequestV1Schema.parse(JSON.parse(String(init.body)));
            return Response.json(MachineReadBatchResponseV1Schema.parse({
                results: demand.machineIds.map(machineId => ({ machineId, status: 'not_found' })) }));
        }
        return Response.json({ error: 'not_found' }, { status: 404 });
    };
    setRuntimeFetch(http);
    const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    return { executor: createDefaultActionExecutor(), context, requests, settingsMutations, profileMutations, navigation, approvalArtifacts,
        artifacts: () => artifacts,
        async seedOwnedArtifactProfile() {
            const inline = editableRecord('editable');
            if (inline.definition.kind !== 'inline') throw new Error('Expected an inline source');
            const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile: inline.definition.profile, secretBindings: {} });
            const response = await approvalArtifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                id: 'owned-definition', header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(content)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            }) });
            if (!response?.ok) throw new Error('Could not seed an owned Artifact');
            ownedArtifactEnabled = true;
            rows = [{ id: 'editable', revision: 4, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
                ...inline, definition: { kind: 'artifact', artifactId: 'owned-definition' },
            }) } }];
            return inline.definition.profile;
        },
        profileRows: () => rows,
        catalogAfterWrite,
        settingsAfterWrite,
        delayedProfileReceipt,
        historyCleanup,
        activateHistoryCleanup() { settings = {}; historyCleanup.active = true; },
        neighboringMemory: () => neighboringMemory,
        memory: () => memory,
        setMemoryEnvelope: (content: unknown) => { memory = content; },
        seedLegacyRememberedProfile(id: string, destination: 'absent' | 'present' = 'absent') {
            settings = { ...settings, lastUsedProfile: id, favoriteProfiles: [id, 'neighbor'],
                futureSecretCarrier: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'opaque-sibling-ciphertext' } } };
            memoryRevision = destination === 'absent' ? 'absent' : 2;
            memory = destination === 'absent' ? undefined : { t: 'plain', v: id };
        },
        failMemoryWrites: () => { failMemoryWrites = true; },
        async importLegacyRememberedProfile() {
            const account = await captureLazyActionAccountContext(home.id);
            try {
                const { accountMode, encryption } = await account.resolveAccountEncryption();
                if (accountMode !== 'plain') throw new Error('Fixture Account is Plain');
                let observed: string | null | undefined;
                const owner = createAuthoringMemorySync({
                    transport: createApiAuthoringMemoryTransport({ request: account.request }),
                    cipher: createAuthoringMemoryCipher({ mode: accountMode, material: null, randomBytes: getRandomBytes }),
                    isCurrent: account.accountLifetime.isCurrent,
                    apply: delta => { if (delta.lastUsedProfile !== undefined) observed = delta.lastUsedProfile; },
                });
                await importLegacyAuthoringMemorySetting({
                    key: 'lastUsedProfile', assertCurrent: account.assertCurrent,
                    read: () => readAccountSettingsBaseline({ credentials: account.credentials, encryption, accountMode, request: account.request }),
                    transfer: async value => { await owner.importAbsent('lastUsedProfile', LegacyLastUsedProfileSchema.parse(value)); },
                    remove: async (key, expectedSettingsVersion) => {
                        const result = await retireLegacyAuthoringMemoryKey({ credentials: account.credentials, encryption, accountMode,
                            settingsScope: account.accountLifetime.scope, requestContext: { scope: account.accountLifetime.scope,
                                endpointUrl: account.endpointUrl, request: account.request }, key, expectedSettingsVersion });
                        return result.status;
                    },
                });
                await owner.bootstrap();
                return observed;
            } finally { account.dispose(); }
        },
        settings: () => settings,
        disableUiAction(actionId: string) {
            settings = { ...settings, actionsSettingsV1: { v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } } } };
        },
        requireUiApproval(actionId: string) {
            approvalEnabled = true;
            settings = { ...settings, actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
        },
        enableApprovalTransport: () => { approvalEnabled = true; },
        advanceProfileRevision() { rows = rows.map(row => ({ ...row, revision: row.revision + 1 })); },
        conflictFavorite: () => { conflictFavorite = true; },
        async mountHome() {
            await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
            const connected = await restoreServerAccountForTest({ serverUrl: home.serverUrl, credentials: { token }, request: http });
            disposeConnection = connected.dispose;
            const scope = { serverId: connected.home.id, accountId: 'owner' };
            getStorage().setState({ profileScope: scope, settingsScope: scope, settingsVersion, settings: settingsParse(settings) });
            await refreshProfileCatalog(scope);
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ catalog: { status: 'ready', source: 'destination',
                records: rows.flatMap(row => row.content?.t === 'plain' ? [{ revision: row.revision, record: { id: row.id } }] : []) } });
        },
        setProfile(attachments?: Pick<ProfileRecordV1, 'enabled' | 'promptStack' | 'secretBindings'>, id = 'editable') {
            const record = editableRecord(id, attachments);
            rows = [{ id: record.id, revision: 4, content: { t: 'plain', v: record } }];
        },
        seedUnrelatedUnavailableBundleProfile() {
            const record = editableRecord('neighbor', { enabled: true, secretBindings: {}, promptStack: [{
                id: 'neighbor-entry', ref: { kind: 'bundle', artifactId: 'unavailable-neighbor-bundle' },
                enabled: true, placement: 'system_append',
            }] });
            const row: ProfileRowV1 = { id: record.id, revision: 2, content: { t: 'plain', v: record } };
            rows.push(row);
            return row;
        },
        seedVisibleBuiltin() {
            settings = { ...settings, favoriteProfiles: ['azure-openai'] };
            memory = { t: 'plain', v: 'azure-openai' };
        },
        seedGrantedProfile(access: 'view' | 'edit', privateMembership = false) {
            const inline = editableRecord('granted');
            if (inline.definition.kind !== 'inline') throw new Error('Fixture requires an inline source');
            const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile: inline.definition.profile, secretBindings: {} });
            const artifact: Artifact = { id: 'granted-source', ownerAccountId: 'source-owner', access, encryptionMode: 'plain',
                header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(content)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 3, bodyVersion: 5,
                seq: 1, createdAt: 1, updatedAt: 1 };
            artifacts.set(artifact.id, artifact);
            rows = privateMembership ? [{ id: 'granted', revision: 4, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
                ...inline, definition: { kind: 'artifact', artifactId: artifact.id },
                promptStack: [{ id: 'private-entry', ref: { kind: 'doc', artifactId: 'private-prompt' },
                    enabled: true, placement: 'system_append' }],
                secretBindings: { API_KEY: formatSharedSavedSecretRefV1('private-key') },
            }) } }] : [];
        },
        holdAcknowledgement: () => { holdAcknowledgement = true; },
        release: () => pendingAcknowledgement?.() };
}

describe('UI Profile Action front door', () => {
    it('lists launch profiles from the captured Account catalog rather than legacy settings', async () => {
        const f = await fixture();
        f.setProfile();
        const result = await f.executor.execute('sessions.spawn.profiles.list', {}, f.context);
        expect(result).toMatchObject({ ok: true, result: {
            coverage: 'complete', totalCount: 1, items: [{ id: 'editable' }],
        } });
    });

    it('settles a referenced Profile deletion while the post-ACK Settings refresh is pending', async () => {
        const f = await fixture();
        f.setProfile(undefined, 'existing');
        await f.mountHome();
        f.settingsAfterWrite.pending = true;
        let settled: Awaited<ReturnType<typeof f.executor.execute>> | undefined;
        const running = f.executor.execute('launch_profiles.delete', { id: 'existing', expectedRevision: 4 }, {
            ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
        })
            .then(result => { settled = result; });
        try {
            await vi.waitFor(() => expect(f.settingsAfterWrite.readStarted).toBe(true));
            await vi.waitFor(() => expect(settled).toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } }));
            expect(f.profileMutations[0]?.settingsCleanup).toBeDefined();
            expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: null });
            expect(getStorage().getState().settingsVersion).toBe(1);
        } finally {
            f.settingsAfterWrite.pending = false;
            f.settingsAfterWrite.release?.();
            await running;
        }
        await vi.waitFor(() => expect(getStorage().getState().settingsVersion).toBe(2));
    });
    it('does not resurrect a deleted Profile when an older committed save receipt arrives late', async () => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        const content = f.profileRows()[0]?.content;
        const definition = ProfileRecordV1Schema.parse(content?.t === 'plain' ? content.v : undefined).definition;
        if (definition.kind !== 'inline') throw new Error('Expected an inline fixture');
        f.delayedProfileReceipt.pending = true;
        const saving = f.executor.execute('launch_profiles.save', { id: 'editable', expectedRevision: 4,
            profile: { ...definition.profile, name: 'Earlier save' } }, f.context);
        try {
            await vi.waitFor(() => expect(f.delayedProfileReceipt.committed).toBe(true));
            const deleted = await f.executor.execute('launch_profiles.delete', { id: 'editable', expectedRevision: 5 }, {
                ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
            });
            expect(deleted).toMatchObject({ ok: true, result: { status: 'updated', revision: 6 } });
            // Hold only the reread following the delayed receipt. The deletion is already committed and acknowledged.
            f.catalogAfterWrite.pending = true;
            f.delayedProfileReceipt.release?.();
            expect(await saving).toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } });
            expect(getProfileCatalogSnapshot({ serverId: f.context.serverId, accountId: 'owner' })?.data).toEqual([]);
        } finally {
            f.catalogAfterWrite.pending = false;
            f.catalogAfterWrite.release?.();
            f.delayedProfileReceipt.release?.();
            await saving;
        }
    });
    it('publishes an acknowledged Artifact body edit while its catalog refresh is still pending', async () => {
        const f = await fixture();
        const profile = await f.seedOwnedArtifactProfile();
        await f.mountHome();
        f.catalogAfterWrite.pending = true;
        let settled: Awaited<ReturnType<typeof f.executor.execute>> | undefined;
        const running = f.executor.execute('launch_profiles.save', { id: 'editable', expectedRevision: 4,
            profile: { ...profile, name: 'Saved Artifact draft', artifactId: 'owned-definition' },
            expectedArtifactRevision: { headerVersion: 1, bodyVersion: 1 } }, f.context).then(result => { settled = result; });
        try {
            await vi.waitFor(() => expect(f.catalogAfterWrite.readStarted).toBe(true));
            await vi.waitFor(() => expect(settled).toMatchObject({ ok: true, result: { status: 'updated' } }));
            const artifact = getProfileCatalogSnapshot({ serverId: f.context.serverId, accountId: 'owner' })?.artifactsById.get('owned-definition');
            expect(artifact?.revision).toEqual({ headerVersion: 2, bodyVersion: 2 });
            expect(artifact?.body).toContain('Saved Artifact draft');
        } finally {
            f.catalogAfterWrite.pending = false;
            f.catalogAfterWrite.release?.();
            await running;
        }
    });
    it('admits a Profile save from active destination rows without waiting for unrelated history maintenance', async () => {
        const f = await fixture();
        f.setProfile();
        f.activateHistoryCleanup();
        const content = f.profileRows()[0]?.content;
        const definition = ProfileRecordV1Schema.parse(content?.t === 'plain' ? content.v : undefined).definition;
        if (definition.kind !== 'inline') throw new Error('Expected an inline fixture');
        let settled: Awaited<ReturnType<typeof f.executor.execute>> | undefined;
        const running = f.executor.execute('launch_profiles.save', { id: 'editable', expectedRevision: 4,
            profile: { ...definition.profile, name: 'Saved while cleaning' } }, f.context).then(result => { settled = result; });
        try {
            await vi.waitFor(() => expect(f.historyCleanup.pending).toBe(true));
            await vi.waitFor(() => expect(settled).toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } }));
        } finally {
            f.historyCleanup.active = false;
            f.historyCleanup.release?.();
            await running;
        }
    });
    it.each(['save', 'create', 'delete'] as const)('settles an acknowledged %s while its catalog refresh is still pending', async operation => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        f.catalogAfterWrite.pending = true;
        let settled: Awaited<ReturnType<typeof f.executor.execute>> | undefined;
        const content = f.profileRows()[0]?.content;
        const profile = ProfileRecordV1Schema.parse(content?.t === 'plain' ? content.v : undefined).definition;
        if (profile.kind !== 'inline') throw new Error('Expected an inline fixture');
        const id = operation === 'create' ? 'created' : 'editable';
        const revision = operation === 'create' ? 1 : 5;
        const running = f.executor.execute(operation === 'delete' ? 'launch_profiles.delete' : 'launch_profiles.save', operation !== 'delete'
            ? { id, profile: { ...profile.profile, id, name: 'Saved draft' }, expectedRevision: operation === 'create' ? 'absent' : 4 }
            : { id: 'editable', expectedRevision: 4 }, { ...f.context,
                ...(operation === 'delete' ? { presentUserConfirmation: { actionId: 'launch_profiles.delete' as const } } : {}),
            }).then(result => { settled = result; });
        try {
            await vi.waitFor(() => expect(f.catalogAfterWrite.readStarted).toBe(true));
            await vi.waitFor(() => expect(settled).toMatchObject({ ok: true, result: { status: 'updated', revision } }));
            const snapshot = getProfileCatalogSnapshot({ serverId: f.context.serverId, accountId: 'owner' });
            const visible = snapshot?.data?.find(row => row.record.id === id);
            if (operation !== 'delete') expect(visible).toMatchObject({ revision, record: { definition: { profile: { name: 'Saved draft' } } } });
            else expect(visible).toBeUndefined();
        } finally {
            f.catalogAfterWrite.pending = false;
            f.catalogAfterWrite.release?.();
            await running;
        }
    });
    it('settles mounted Profile prompt-stack approval before acknowledging the captured row edit', async () => {
        const f = await fixture();
        const originalEntry = { id: 'reviewed-entry', ref: { kind: 'doc' as const, artifactId: 'reviewed-prompt' },
            enabled: true, placement: 'system_append' as const };
        f.setProfile({ enabled: true, promptStack: [originalEntry], secretBindings: { KEEP: null } });
        f.requireUiApproval('launch_profiles.prompt_stack.update');
        await f.mountHome();
        const hook = await renderHook(() => useProfilePromptStack('editable'));
        let settled = false;
        let failure: unknown;
        let editing: Promise<void> | undefined;
        act(() => { editing = hook.getCurrent().update({ kind: 'set_enabled', entryId: originalEntry.id, enabled: false })
            .then(() => { settled = true; }, error => { settled = true; failure = error; }); });
        await vi.waitFor(() => expect(f.approvalArtifacts.list()).toHaveLength(1));
        const approval = f.approvalArtifacts.list()[0]!;
        expect(JSON.parse(f.approvalArtifacts.readPlainBody(approval.id)!)).toMatchObject({
            actionId: 'launch_profiles.prompt_stack.update', actionArgs: { id: 'editable', expectedRevision: 4,
                intent: { kind: 'set_enabled', entryId: originalEntry.id, enabled: false } },
        });
        expect(settled).toBe(false);
        expect(f.profileMutations).toEqual([]);
        await decideApprovalAsInbox(f.context.serverId, approval.id, 'approve');
        await act(async () => { await editing; });
        expect(failure).toBeUndefined();
        expect(settled).toBe(true);
        expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: { t: 'plain', v: {
            enabled: true, secretBindings: { KEEP: null }, promptStack: [{ ...originalEntry, enabled: false }],
        } } });
        await hook.unmount();
    });

    it.each([false, true])('settles mounted save approval with its original revision (concurrent edit: %s)', async concurrentEdit => {
        const f = await fixture();
        f.setProfile();
        f.requireUiApproval('launch_profiles.save');
        await f.mountHome();
        const onApprovalPending = vi.fn();
        const hook = await renderHook(() => ({ save: useApplyProfileSave({ onApprovalPending }), collection: useProfilesCollection() }));
        const profile = hook.getCurrent().collection.resolveProfile('editable');
        if (!profile) throw new Error('Fixture Profile unavailable');
        let settled = false;
        let saving: Promise<unknown> | undefined;
        act(() => { saving = hook.getCurrent().save({ profile: { ...profile, name: 'Reviewed draft' }, expectedRevision: 4 })
            .then(result => { settled = true; return result; }, error => { settled = true; throw error; }); });
        // The operation remains pending through durable approval creation, with no row write.
        await vi.waitFor(() => expect(f.approvalArtifacts.list()).toHaveLength(1));
        const approval = f.approvalArtifacts.list()[0]!;
        expect(JSON.parse(f.approvalArtifacts.readPlainBody(approval.id)!)).toMatchObject({ actionId: 'launch_profiles.save',
            actionArgs: { expectedRevision: 4, profile: { name: 'Reviewed draft' } } });
        expect(settled).toBe(false);
        expect(f.profileMutations).toEqual([]);
        const pendingNotification = onApprovalPending.mock.calls[0]?.[0];
        if (concurrentEdit) f.advanceProfileRevision();
        const outcome = concurrentEdit ? expect(saving).resolves.toMatchObject({ status: 'conflict', revision: 5 })
            : expect(saving).resolves.toMatchObject({ status: 'updated', revision: 5 });
        await decideApprovalAsInbox(f.context.serverId, approval.id, 'approve');
        await act(async () => { await outcome; });
        expect(settled).toBe(true);
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { definition: { profile: {
            name: concurrentEdit ? 'Editable' : 'Reviewed draft',
        } } } });
        expect(f.profileMutations).toHaveLength(concurrentEdit ? 0 : 1);
        expect(pendingNotification).toMatchObject({ artifactId: approval.id,
            scope: { serverId: f.context.serverId, accountId: 'owner' } });
        await hook.unmount();
    });

    it.each([false, true])('submits the captured Profile draft during display refresh and presents canonical conflict=%s', async concurrentEdit => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { MASKED: null } });
        await f.mountHome();
        const hook = await renderHook(() => ({ save: useSaveLaunchProfile(), collection: useProfilesCollection() }));
        const profile = hook.getCurrent().collection.resolveProfile('editable');
        if (!profile) throw new Error('Fixture Profile unavailable');
        const requirements = await renderHook(() => useLegacyProfileSecretRequirements({ profile, profileName: profile.name,
            environmentVariables: [] }));
        if (concurrentEdit) f.advanceProfileRevision();
        await act(async () => { beginProfileCatalogLoad(getStorage().getState().settingsScope!); });
        const bindings = requirements.getCurrent().readPrivateSecretBindingsForSave();
        expect(bindings).toEqual({ MASKED: null });
        if (bindings === null) throw new Error('Display refresh blocked the captured draft');
        vi.mocked(Modal.alert).mockClear();
        let saved: Awaited<ReturnType<ReturnType<typeof useSaveLaunchProfile>>> = null;
        await act(async () => { saved = await hook.getCurrent().save({ ...profile, name: 'Saved during refresh' }, bindings); });
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { secretBindings: { MASKED: null },
            definition: { profile: { name: concurrentEdit ? 'Editable' : 'Saved during refresh' } } } });
        if (concurrentEdit) {
            expect(saved).toBeNull();
            expect(Modal.alert).toHaveBeenCalledWith('common.error', 'profile_revision_conflict');
        } else {
            expect(saved).not.toBeNull();
            expect(Modal.alert).not.toHaveBeenCalled();
        }
        await requirements.unmount();
        await hook.unmount();
    });

    it('saves the Skills a Profile adds through the mounted editor save, keeps them when the library later lacks one, and removes them', async () => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'lint', bundleSchemaId: 'skills.skill_md_v1' });
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
            contentBase64: encodeBase64(new TextEncoder().encode('---\nname: lint\n---\nRun the linter.')) }] });
        f.artifacts().set('lint-skill', { id: 'lint-skill', header: encodePlainArtifactStoredContent(header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', kind: 'skill', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } as Artifact);
        const hook = await renderHook(() => ({ save: useSaveLaunchProfile(), collection: useProfilesCollection() }));
        const profile = hook.getCurrent().collection.resolveProfile('editable');
        if (!profile) throw new Error('Fixture Profile unavailable');
        let saved: Awaited<ReturnType<ReturnType<typeof useSaveLaunchProfile>>> = null;
        await act(async () => { saved = await hook.getCurrent().save({ ...profile, skillSeeds: ['lint-skill'] }); });
        expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: { t: 'plain', v: { skillSeeds: ['lint-skill'] } } });
        // An unrelated edit does not send the seeds, so a skill that has since left the library cannot block it.
        f.artifacts().delete('lint-skill');
        const renamed = { ...hook.getCurrent().collection.resolveProfile('editable')!, name: 'Renamed' };
        expect(renamed.skillSeeds).toEqual(['lint-skill']);
        await act(async () => { saved = await hook.getCurrent().save(renamed); });
        expect(saved).not.toBeNull();
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { skillSeeds: ['lint-skill'], definition: { profile: { name: 'Renamed' } } } });
        await act(async () => { saved = await hook.getCurrent().save({ ...hook.getCurrent().collection.resolveProfile('editable')!, skillSeeds: [] }); });
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { skillSeeds: [] } });
        await hook.unmount();
    });

    it('returns a direct Profile tombstone receipt after the present-user confirm while Agent delete still asks', async () => {
        const f = await fixture();
        f.setProfile();
        f.enableApprovalTransport();
        await f.mountHome();
        const controller = new AbortController();
        const agent = f.executor.execute('launch_profiles.delete', { id: 'editable', expectedRevision: 4 }, {
            ...f.context, surface: 'agent', authority: 'account_automation',
            defaultSessionId: 'agent-session', defaultSessionMachineId: 'agent-machine', actionRequestId: 'agent-delete-profile',
            presentUserConfirmation: { actionId: 'launch_profiles.delete' }, signal: controller.signal,
        });
        try {
            await vi.waitFor(() => expect(f.approvalArtifacts.list()).toHaveLength(1));
            const artifact = f.approvalArtifacts.list()[0]!;
            expect(StoredApprovalRequestSchema.parse(JSON.parse(f.approvalArtifacts.readPlainBody(artifact.id)!)))
                .toMatchObject({ status: 'open', actionId: 'launch_profiles.delete', requestedSurface: 'agent' });
            expect(f.profileMutations).toEqual([]);
        } finally { controller.abort(); await agent; }
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const hook = await renderHook(useDeleteAiLaunchProfile);
        let deleting: Promise<unknown> | undefined;
        try {
            act(() => { deleting = hook.getCurrent()('editable', 4).catch(error => error); });
            await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => expect(f.profileMutations).toMatchObject([{ operation: 'remove', id: 'editable' }]));
            let receipt: unknown;
            await act(async () => { receipt = await deleting; });
            expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.delete'].parse(receipt)).toMatchObject({ status: 'updated' });
            expect(f.approvalArtifacts.list()).toHaveLength(1);
            expect(f.navigation.push).not.toHaveBeenCalled();
        } finally { await hook.unmount(); await deleting; confirm.mockRestore(); }
    });

    it.each([true, false])('New Session profile Delete delegates the reviewed revision and one policy decision (accepted=%s)', async accepted => {
        const f = await fixture();
        f.setProfile();
        f.enableApprovalTransport();
        await f.mountHome();
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(accepted);
        // A person accepts the incumbent caller alert too, so the regression
        // reaches the real Profile owner and exposes its missing revision.
        const alert = vi.spyOn(Modal, 'alert').mockImplementation((_title, _message, buttons) => {
            const destructive = buttons?.find(button => button.style === 'destructive');
            if (destructive) void destructive.onPress?.();
        });
        const hook = await renderHook(() => {
            const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>('editable');
            const remove = useDeleteAiLaunchProfile();
            const collection = useProfilesCollection();
            const actions = useNewSessionProfileActions({ selectedProfileId, setSelectedProfileId, deleteProfile: remove });
            return { ...actions, selectedProfileId, profile: collection.profiles.find(profile => profile.id === 'editable') };
        });
        try {
            const profile = hook.getCurrent().profile;
            if (!profile) throw new Error('Expected the reviewed Profile');
            await act(async () => { await hook.getCurrent().handleDeleteProfile(profile); });
            await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
            if (accepted) {
                await vi.waitFor(() => expect(f.profileMutations).toMatchObject([{ operation: 'remove', id: 'editable' }]));
                await vi.waitFor(() => expect(hook.getCurrent().selectedProfileId).toBeNull());
            } else {
                expect(f.profileMutations).toEqual([]);
                expect(hook.getCurrent().selectedProfileId).toBe('editable');
            }
            expect(alert).not.toHaveBeenCalled();
        } finally { await hook.unmount(); confirm.mockRestore(); alert.mockRestore(); }
    });

    it('cancels the present-user Profile confirmation without an error, approval or tombstone', async () => {
        const f = await fixture();
        f.setProfile();
        f.enableApprovalTransport();
        await f.mountHome();
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        const hook = await renderHook(useProfilesCollection);
        try {
            let removed = true;
            await act(async () => { removed = await hook.getCurrent().requestDelete({ id: 'editable', name: 'Editable' }); });
            expect(removed).toBe(false);
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(f.profileMutations).toEqual([]);
            expect(f.approvalArtifacts.list()).toHaveLength(0);
            expect(alert).not.toHaveBeenCalled();
        } finally { await hook.unmount(); confirm.mockRestore(); alert.mockRestore(); }
    });

    it('rejects mounted delete approval without deleting the reviewed Profile', async () => {
        const f = await fixture();
        f.setProfile();
        f.requireUiApproval('launch_profiles.delete');
        await f.mountHome();
        const hook = await renderHook(useDeleteAiLaunchProfile);
        let removing: Promise<unknown> | undefined;
        act(() => { removing = hook.getCurrent()('editable', 4); });
        await vi.waitFor(() => expect(f.approvalArtifacts.list()).toHaveLength(1));
        expect(f.navigation.push).toHaveBeenCalledWith(expect.stringContaining('/inbox/approvals/'));
        const rejected = expect(removing).rejects.toThrow('approval_rejected');
        await decideApprovalAsInbox(f.context.serverId, f.approvalArtifacts.list()[0]!.id, 'reject');
        await act(async () => { await rejected; });
        expect(f.profileRows()[0]?.revision).toBe(4);
        expect(f.profileMutations).toEqual([]);
        await hook.unmount();
    });

    it.each(['save', 'delete', 'enabled.set', 'favorite.set', 'secrets.select'] as const)('mounted %s refuses a disabled Action before its writer', async operation => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { API_KEY: formatSharedSavedSecretRefV1('private-key') } });
        f.disableUiAction(`launch_profiles.${operation}`);
        await f.mountHome();
        const hook = await renderHook(() => ({ save: useApplyProfileSave(), remove: useDeleteAiLaunchProfile(),
            bindings: useCurrentSecretBindingsByProfileIdMutable()[1], collection: useProfilesCollection() }));
        const profile = hook.getCurrent().collection.resolveProfile('editable');
        if (!profile) throw new Error('Fixture Profile unavailable');
        const before = f.profileRows();
        const settingsBefore = structuredClone(f.settings());
        const invoke = () => operation === 'save' ? hook.getCurrent().save({ profile: { ...profile, name: 'Draft retained' }, expectedRevision: 4 })
            : operation === 'delete' ? hook.getCurrent().remove('editable', 4)
            : operation === 'favorite.set' ? hook.getCurrent().collection.setFavoriteProfileIds(['neighbor', 'editable'])
            : operation === 'secrets.select' ? hook.getCurrent().bindings({ editable: {} })
            : hook.getCurrent().collection.setEnabled(hook.getCurrent().collection.profiles.find(entry => entry.id === 'editable')!, false);
        await expect(Promise.resolve().then(async () => { await invoke(); })).rejects.toMatchObject({ message: 'action_disabled' });
        expect(f.profileMutations).toEqual([]);
        expect(f.profileRows()).toEqual(before);
        expect(f.settings()).toEqual(settingsBefore);
    });

    it('acknowledges the mounted machine-environment favorite without replacing concurrent Account preferences', async () => {
        const f = await fixture();
        await f.mountHome();
        const hook = await renderHook(useProfileFavoriteIdsMutable);
        f.conflictFavorite();
        await act(async () => { await hook.getCurrent()[1]([...hook.getCurrent()[0], '']); });
        expect(f.settings()).toMatchObject({ favoriteProfiles: expect.arrayContaining(['other-device', '']),
            futurePreference: { version: 'concurrent' } });
        expect(f.settings().favoriteProfiles).toHaveLength(2);
        expect(f.profileMutations).toEqual([]);
        await hook.unmount();
    });

    it('acknowledges mounted binding changes in one row CAS while retaining private None slots', async () => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { KEEP: null } });
        await f.mountHome();
        const hook = await renderHook(useCurrentSecretBindingsByProfileIdMutable);
        await act(async () => { await hook.getCurrent()[1]({ editable: {
            API_KEY: formatSharedSavedSecretRefV1('private-key'), SECOND_KEY: formatSharedSavedSecretRefV1('private-key'),
        } }); });
        expect(f.profileMutations).toHaveLength(1);
        expect(f.profileMutations[0]?.savedSecretRevisions).toEqual([{ resourceId: 'private-key', expectedRevision: 3 }]);
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { secretBindings: {
            KEEP: null, API_KEY: formatSharedSavedSecretRefV1('private-key'), SECOND_KEY: formatSharedSavedSecretRefV1('private-key'),
        } } });
        await hook.unmount();
    });

    it('acknowledges an atomic two-environment binding selection through one row CAS and preserves private None slots', async () => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { KEEP: null } });
        const selected = { kind: 'resource', resourceId: 'private-key', expectedResourceRevision: 3 } as const;
        const bindingContext = { ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.secrets.select' as const } };
        const result = await f.executor.execute('launch_profiles.secrets.select', { id: 'editable', expectedRevision: 4,
            selections: [{ envName: 'API_KEY', selection: selected }, { envName: 'SECOND_KEY', selection: selected }] }, bindingContext);
        expect(result).toEqual({ ok: true, result: { status: 'updated', id: 'editable', revision: 5 } });
        expect(f.profileMutations).toHaveLength(1);
        expect(f.profileMutations[0]?.savedSecretRevisions).toEqual([{ resourceId: 'private-key', expectedRevision: 3 }]);
        expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: { t: 'plain', v: { secretBindings: {
            KEEP: null, API_KEY: formatSharedSavedSecretRefV1('private-key'), SECOND_KEY: formatSharedSavedSecretRefV1('private-key'),
        } } } });
        const acknowledged = structuredClone(f.profileRows());
        expect(await f.executor.execute('launch_profiles.secrets.select', { id: 'editable', expectedRevision: 4,
            selections: [{ envName: 'API_KEY', selection: { kind: 'none' } }] }, bindingContext))
            .toMatchObject({ ok: true, result: { status: 'conflict', id: 'editable', revision: 5 } });
        expect(f.profileRows()).toEqual(acknowledged);
        expect(f.profileMutations).toHaveLength(1);
    });

    it.each(['invalid_environment', 'stale_resource', 'conflicting_resource_proofs'] as const)(
        'refuses an entire binding batch with %s without partially replacing its private map', async failure => {
            const f = await fixture();
            f.setProfile({ enabled: true, promptStack: [], secretBindings: { KEEP: null } });
            const before = structuredClone(f.profileRows());
            const selected = { kind: 'resource', resourceId: 'private-key', expectedResourceRevision: failure === 'stale_resource' ? 2 : 3 } as const;
            const result = await f.executor.execute('launch_profiles.secrets.select', { id: 'editable', expectedRevision: 4,
                selections: [{ envName: 'API_KEY', selection: selected }, { envName: failure === 'invalid_environment' ? 'bad-name' : 'SECOND_KEY',
                    selection: { ...selected, expectedResourceRevision: failure === 'stale_resource' ? 2 : 4 } }] }, {
                ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.secrets.select' },
            });
            if (failure === 'conflicting_resource_proofs') expect(result).toMatchObject({ ok: true, result: { status: 'invalid' } });
            else expect(result.ok).toBe(false);
            expect(f.profileRows()).toEqual(before);
            expect(f.profileMutations).toEqual([]);
        },
    );

    it('does not resurrect a deleted remembered Profile when its raw Settings source is imported later', async () => {
        const f = await fixture();
        f.setProfile(undefined, 'private');
        f.seedLegacyRememberedProfile('private');
        const neighbor = f.neighboringMemory();
        const deleted = await f.executor.execute('launch_profiles.delete', { id: 'private', expectedRevision: 4 }, {
            ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
        });
        expect(deleted).toEqual({ ok: true, result: { status: 'updated', id: 'private', revision: 5 } });
        expect(f.profileRows()).toEqual([{ id: 'private', revision: 5, content: null }]);
        // This is the real destination-first importer, invoked after the actual Action ACK.
        await expect(f.importLegacyRememberedProfile()).resolves.toBe(null);
        expect(f.memory()).not.toEqual({ t: 'plain', v: 'private' });
        expect(f.settings()).not.toHaveProperty('lastUsedProfile');
        expect(f.settings()).toMatchObject({ favoriteProfiles: ['neighbor'], futurePreference: { version: 'initial' },
            futureSecretCarrier: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'opaque-sibling-ciphertext' } } });
        expect(f.neighboringMemory()).toEqual(neighbor);
    });
    it('keeps the acknowledged Profile tombstone when secondary remembered-selection cleanup fails', async () => {
        const f = await fixture();
        f.setProfile(undefined, 'private');
        f.seedLegacyRememberedProfile('private', 'present');
        f.failMemoryWrites();
        const result = await f.executor.execute('launch_profiles.delete', { id: 'private', expectedRevision: 4 }, {
            ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
        });
        expect(result).toEqual({ ok: true, result: { status: 'updated', id: 'private', revision: 5,
            authoringMemoryCleanup: { status: 'unavailable', reason: 'authoring_memory_cleanup_failed' } } });
        expect(f.profileRows()).toEqual([{ id: 'private', revision: 5, content: null }]);
        expect(f.requests).toContain('POST /v1/account/authoring-memory/lastUsedProfile');
        expect(f.memory()).toEqual({ t: 'plain', v: 'private' });
        expect(f.settings()).toMatchObject({ favoriteProfiles: ['neighbor'], futurePreference: { version: 'initial' },
            futureSecretCarrier: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'opaque-sibling-ciphertext' } } });
    });
    it.each([false, true])('publishes the current Profile row with private metadata (unavailable neighboring bundle: %s)', async neighboringBundle => {
        const f = await fixture();
        const attachments = {
            enabled: false,
            promptStack: [{ id: 'private-entry', ref: { kind: 'doc' as const, artifactId: 'private-prompt' },
                enabled: true, placement: 'system_append' as const }],
            secretBindings: { API_KEY: formatSharedSavedSecretRefV1('private-key') },
        };
        f.setProfile(attachments);
        const neighbor = neighboringBundle ? f.seedUnrelatedUnavailableBundleProfile() : null;
        expect(f.settings()).not.toHaveProperty('profiles');
        const account = await captureLazyActionAccountContext(f.context.serverId);
        try {
            expect(await readProfileCatalogInContext(account, undefined, { readSourceBaseline: true }))
                .toMatchObject({ status: 'ready', source: 'destination', diagnostics: [] });
        } finally { account.dispose(); }
        const publicationContext = { ...f.context, presentUserConfirmation: { actionId: 'launch_profiles.publish' as const } };
        const result = await f.executor.execute('launch_profiles.publish', { profileId: 'editable' }, publicationContext);
        expect(result.ok ? null : result).toBeNull();
        if (!result.ok) throw new Error('Current Profile row was not published');
        const reference = LaunchProfileArtifactReferenceV1Schema.parse(result.result);
        const artifact = f.artifacts().get(reference.artifactId);
        expect(artifact).toBeDefined();
        expect(artifact?.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
        const envelope = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(artifact!.body!));
        expect(typeof envelope.body).toBe('string');
        const published = LaunchProfileArtifactV1Schema.parse(JSON.parse(String(envelope.body)));
        expect(published.profile).toMatchObject({ id: 'editable', name: 'Editable' });
        expect(published.secretBindings).toEqual({});
        expect(published.profile).not.toHaveProperty('promptStack');
        expect(String(envelope.body)).not.toContain('private-prompt');
        expect(String(envelope.body)).not.toContain(formatSharedSavedSecretRefV1('private-key'));
        expect(String(envelope.body)).not.toContain('private-material-not-for-publication');
        expect(f.profileRows().filter(row => row.id === 'editable')).toEqual([{ id: 'editable', revision: 5, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
            v: 1, id: 'editable', definition: { kind: 'artifact', artifactId: reference.artifactId }, ...attachments,
        }) } }]);
        expect(f.profileMutations).toMatchObject([{ id: 'editable', operation: 'update', expectedRevision: 4 }]);
        await expect(f.executor.execute('launch_profiles.publish', { profileId: 'editable' }, publicationContext))
            .resolves.toEqual({ ok: true, result: reference });
        expect(f.artifacts().size).toBe(1);
        expect(f.profileRows().find(row => row.id === 'editable')?.revision).toBe(5);
        expect(f.settingsMutations).toEqual([]);
        expect(f.settings()).not.toHaveProperty('profiles');
        if (neighbor) expect(f.profileRows().find(row => row.id === neighbor.id)).toEqual(neighbor);
    });
    it('selects the machine environment through acknowledged captured-Home authoring memory, without a Settings write', async () => {
        const f = await fixture();
        f.holdAcknowledgement();
        let finished = false;
        const pending = f.executor.execute('launch_profiles.select', { id: null }, f.context).then(result => { finished = true; return result; });
        await vi.waitFor(() => expect(f.requests).toContain('POST /v1/account/authoring-memory/lastUsedProfile'));
        expect(finished).toBe(false);
        f.release();
        await expect(pending).resolves.toEqual({ ok: true, result: { status: 'selected', id: null } });
        expect(f.memory()).toEqual({ t: 'plain', v: null });
        expect(f.settingsMutations).toEqual([]);
        expect(f.requests.some(path => path.includes('/entity-rows/profiles'))).toBe(false);
    });
    it('does not pretend that an unmounted editor draft was discarded', async () => {
        const f = await fixture();
        const result = await f.executor.execute('launch_profiles.draft.discard', { draftId: 'missing-draft' }, f.context);
        expect(result).toEqual({ ok: true, result: { status: 'unavailable', reason: 'profile_editor_not_mounted' } });
        expect(f.navigation.push).not.toHaveBeenCalled();
        expect(f.navigation.replace).not.toHaveBeenCalled();
        expect(f.navigation.back).not.toHaveBeenCalled();
        expect(f.settingsMutations).toEqual([]);
    });
    it('does not overwrite an encrypted memory row when the authoritative captured Account is Plain', async () => {
        const f = await fixture();
        const retained = { t: 'encrypted', c: 'unopened-account-content' };
        f.setMemoryEnvelope(retained);
        const result = await f.executor.execute('launch_profiles.select', { id: null }, f.context);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errorCode).not.toBe('unsupported_action');
        expect(f.memory()).toEqual(retained);
        expect(f.requests).not.toContain('POST /v1/account/authoring-memory/lastUsedProfile');
        expect(f.settingsMutations).toEqual([]);
    });
    it('favorites the default environment against the latest captured-Home Settings winner without erasing sibling preferences', async () => {
        const f = await fixture();
        await f.mountHome();
        const hook = await renderHook(useProfilesCollection);
        f.conflictFavorite();
        await hook.getCurrent().setFavoriteProfileIds(['existing', '']);
        await expect.poll(() => f.settings()).toMatchObject({ favoriteProfiles: ['', 'other-device'], futurePreference: { version: 'concurrent' } });
        expect(f.profileMutations).toEqual([]);
    });
    it('opens an exact revision and returns an address without pretending the editor is mounted', async () => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        const stale = await f.executor.execute('launch_profiles.edit', { id: 'editable', expectedRevision: 3 }, f.context);
        expect(stale).toEqual({ ok: true, result: { status: 'conflict', id: 'editable', revision: 4 } });
        expect(f.navigation.push).not.toHaveBeenCalled();
        const result = await f.executor.execute('launch_profiles.edit', { id: 'editable', expectedRevision: 4 }, f.context);
        expect(result).toMatchObject({ ok: true, result: { status: 'opened', id: 'editable' } });
        if (!result.ok) throw new Error('Profile editor did not open');
        const opened = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].parse(result.result);
        if (opened.status !== 'opened') throw new Error('Profile editor did not open');
        expect(f.navigation.push).toHaveBeenCalledWith(`/settings/profiles/editable?draftId=${encodeURIComponent(opened.draftId)}`);
        await expect(f.executor.execute('launch_profiles.draft.discard', { draftId: opened.draftId }, f.context))
            .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });
    it('opens an actually visible current builtin without inventing private Profile membership', async () => {
        const f = await fixture();
        f.seedVisibleBuiltin();
        await f.mountHome();
        expect(f.profileRows()).toEqual([]);
        const result = await f.executor.execute('launch_profiles.edit', { id: 'azure-openai', expectedRevision: 'absent' }, f.context);
        expect(result).toMatchObject({ ok: true, result: { status: 'opened', id: 'azure-openai' } });
        if (!result.ok) throw new Error('Visible builtin editor did not open');
        const opened = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].parse(result.result);
        if (opened.status !== 'opened') throw new Error('Visible builtin editor did not open');
        expect(f.navigation.push).toHaveBeenCalledWith(`/settings/profiles/azure-openai?draftId=${encodeURIComponent(opened.draftId)}`);
        expect(f.profileRows()).toEqual([]);
        expect(f.profileMutations).toEqual([]);
        expect(f.settingsMutations).toEqual([]);
    });
    it('opens an editable granted Artifact at its exact composite revision without inventing private membership', async () => {
        const f = await fixture();
        f.seedGrantedProfile('edit');
        await f.mountHome();
        expect(f.profileRows()).toEqual([]);
        const result = await f.executor.execute('launch_profiles.edit', { id: 'granted', expectedRevision: 'absent',
            expectedArtifactRevision: { headerVersion: 3, bodyVersion: 5 } }, f.context);
        expect(result).toMatchObject({ ok: true, result: { status: 'opened', id: 'granted' } });
        if (!result.ok) throw new Error('Granted source editor did not open');
        const opened = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].parse(result.result);
        if (opened.status !== 'opened') throw new Error('Granted source editor did not open');
        expect(f.navigation.push).toHaveBeenCalledWith(`/settings/profiles/granted?draftId=${encodeURIComponent(opened.draftId)}`);
        expect(f.profileRows()).toEqual([]);
        expect(f.profileMutations).toEqual([]);
        expect(f.settingsMutations).toEqual([]);
    });
    it('does not open a granted body editor with a missing or stale Artifact revision pin', async () => {
        const f = await fixture();
        f.seedGrantedProfile('edit');
        await f.mountHome();
        const missing = await f.executor.execute('launch_profiles.edit', { id: 'granted', expectedRevision: 'absent' }, f.context);
        expect(missing).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        const stale = await f.executor.execute('launch_profiles.edit', { id: 'granted', expectedRevision: 'absent',
            expectedArtifactRevision: { headerVersion: 3, bodyVersion: 4 } }, f.context);
        expect(stale).toMatchObject({ ok: true });
        if (!stale.ok) throw new Error('Stale Artifact pin was not a typed editor refusal');
        const refused = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].parse(stale.result);
        expect(['conflict', 'unavailable']).toContain(refused.status);
        expect(f.navigation.push).not.toHaveBeenCalled();
        expect(f.profileRows()).toEqual([]);
        expect(f.profileMutations).toEqual([]);
        expect(f.settingsMutations).toEqual([]);
    });
    it('does not turn private binding and stack membership into a view-only Artifact body edit grant', async () => {
        const f = await fixture();
        f.seedGrantedProfile('view', true);
        await f.mountHome();
        const before = f.profileRows();
        const result = await f.executor.execute('launch_profiles.edit', { id: 'granted', expectedRevision: 4,
            expectedArtifactRevision: { headerVersion: 3, bodyVersion: 5 } }, f.context);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('View-only body grant was not a typed editor refusal');
        const refused = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].parse(result.result);
        if (refused.status === 'invalid') expect(refused.reason).toBe('read-only');
        else expect(refused.status).toBe('unavailable');
        expect(f.navigation.push).not.toHaveBeenCalled();
        expect(f.profileRows()).toEqual(before);
        expect(f.profileMutations).toEqual([]);
        expect(f.settingsMutations).toEqual([]);
    });
    it('requires a body revision pin even when an editable Artifact already has private Profile membership', async () => {
        const f = await fixture();
        f.seedGrantedProfile('edit', true);
        await f.mountHome();
        const before = f.profileRows();
        const result = await f.executor.execute('launch_profiles.edit', { id: 'granted', expectedRevision: 4 }, f.context);
        expect(result).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(f.navigation.push).not.toHaveBeenCalled();
        expect(f.profileRows()).toEqual(before);
        expect(f.profileMutations).toEqual([]);
        expect(f.settingsMutations).toEqual([]);
    });
    it('discards only real mounted editor state and retires its address on unmount', async () => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        const draftId = 'mounted-editor-draft';
        router.setParams({ draftId });
        const screen = await renderScreen(React.createElement(ProfileDetailScreen, { target: { kind: 'profile', profileId: 'editable' } }));
        const nameField = () => screen.root.findAll(node => node.props.testID === 'profile-slim-name'
            && typeof node.props.onChangeText === 'function')[0];
        expect(nameField()).toBeDefined();
        await act(async () => { nameField()!.props.onChangeText('Unsaved'); });
        expect(nameField()?.props.value).toBe('Unsaved');
        await act(async () => {
            await expect(f.executor.execute('launch_profiles.draft.discard', { draftId }, f.context))
                .resolves.toEqual({ ok: true, result: { status: 'discarded', draftId } });
        });
        expect(nameField()?.props.value).toBe('Editable');
        await act(async () => { screen.unmount(); });
        await expect(f.executor.execute('launch_profiles.draft.discard', { draftId }, f.context))
            .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(f.settingsMutations).toEqual([]);
    });
    it('saves and reopens a zero-Machine Profile environment with an existing Saved Secret reference', async () => {
        const f = await fixture();
        const reference = formatSharedSavedSecretRefV1('private-key');
        f.setProfile();
        await f.mountHome();
        expect(getStorage().getState().machines).toEqual({});
        const alert = vi.spyOn(Modal, 'alert');
        const screen = await renderScreen(React.createElement(ProfileDetailScreen, { target: { kind: 'profile', profileId: 'editable' } }));
        const environment = () => screen.root.findByType(EnvironmentVariablesList);
        expect(environment().props.machineId).toBeNull();
        const variables = [{ name: 'API_KEY', value: '', isSecret: true }, { name: 'TEAM_FLAG', value: '1' }];
        // Connection and collection readiness have their own reads. Measure the
        // reference edit/save itself after that mounted surface has settled.
        await vi.waitFor(() => expect(environment().props.getDefaultSecretNameForSourceVar('API_KEY', reference)).not.toBeNull());
        const beforeSave = f.requests.length;
        await act(async () => {
            environment().props.onAddVariable({ variable: variables[0],
                requirement: { name: 'API_KEY', required: true, useSecretVault: true, secretId: reference } });
            environment().props.onAddVariable({ variable: variables[1], requirement: null });
        });
        await act(async () => {
            const save = screen.root.findAll(node => node.props.testID === 'settings.profiles.detail.save'
                && typeof node.props.onPress === 'function')[0];
            if (!save) throw new Error('profile_editor_save_missing');
            await save.props.onPress();
        });
        expect(alert).not.toHaveBeenCalled();
        expect(f.profileMutations).toHaveLength(1);
        expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: { t: 'plain', v: {
            secretBindings: { API_KEY: reference }, definition: { profile: { extraEnvironmentVariables: variables } },
        } } });
        expect(f.requests.slice(beforeSave).filter(request => /\/machines(?:\/|$)|\/rpc|\/declarations|\/materials/.test(request))).toEqual([]);
        await act(async () => { screen.unmount(); });
        await refreshProfileCatalog({ serverId: f.context.serverId, accountId: 'owner' });
        const reopened = await renderScreen(React.createElement(ProfileDetailScreen, { target: { kind: 'profile', profileId: 'editable' } }));
        const reopenedEnvironment = reopened.root.findByType(EnvironmentVariablesList);
        expect(reopenedEnvironment.props.environmentVariables).toEqual(variables);
        expect(reopenedEnvironment.props.sourceRequirementsByName.API_KEY).toMatchObject({ required: true, useSecretVault: true });
        expect(reopenedEnvironment.props.getDefaultSecretNameForSourceVar('API_KEY', reference)).not.toBeNull();
        expect(f.settingsMutations).toEqual([]);
        await act(async () => { reopened.unmount(); });
    });
    it('saves and reopens a zero-Machine Profile reference through the headless Account Action', async () => {
        const f = await fixture();
        f.setProfile();
        const stored = f.profileRows()[0]?.content;
        const row = ProfileRecordV1Schema.parse(stored?.t === 'plain' ? stored.v : null);
        if (row.definition.kind !== 'inline') throw new Error('Expected inline Profile');
        const reference = formatSharedSavedSecretRefV1('private-key');
        const profile = { ...row.definition.profile, extraEnvironmentVariables: [{ name: 'API_KEY', value: '', isSecret: true }] };
        expect(await f.executor.execute('launch_profiles.save', { id: row.id, profile, expectedRevision: 4,
            secretBindings: { API_KEY: reference } }, { ...f.context, surface: 'mcp' }))
            .toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } });
        const context = await captureLazyActionAccountContext(f.context.serverId);
        try {
            const catalog = await readProfileCatalogInContext(context);
            expect(catalog).toMatchObject({ status: 'ready', records: [{ revision: 5, record: {
                secretBindings: { API_KEY: reference }, definition: { profile: { extraEnvironmentVariables: profile.extraEnvironmentVariables } },
            } }] });
        } finally { context.dispose(); }
        expect(f.requests.filter(request => /\/machines(?:\/|$)|\/rpc|\/declarations|\/materials/.test(request))).toEqual([]);
        expect(f.profileMutations).toHaveLength(1);
    });
    it('keeps the mounted Profile editor dirty until its row save is acknowledged', async () => {
        const f = await fixture();
        f.setProfile();
        await f.mountHome();
        const screen = await renderScreen(React.createElement(ProfileDetailScreen, { target: { kind: 'profile', profileId: 'editable' } }));
        const nameField = () => screen.root.findAll(node => node.props.testID === 'profile-slim-name'
            && typeof node.props.onChangeText === 'function')[0];
        await act(async () => { nameField()!.props.onChangeText('Awaiting ACK'); });
        f.holdAcknowledgement();
        let settled = false;
        let saving: Promise<unknown> | undefined;
        await act(async () => {
            const save = screen.root.findAll(node => node.props.testID === 'settings.profiles.detail.save'
                && typeof node.props.onPress === 'function')[0];
            if (!save) throw new Error('profile_editor_save_missing');
            saving = Promise.resolve(save.props.onPress()).then(result => { settled = true; return result; });
        });
        await vi.waitFor(() => expect(f.profileMutations).toHaveLength(1));
        expect(settled).toBe(false);
        expect(nameField()?.props.value).toBe('Awaiting ACK');
        const save = screen.root.findAll(node => node.props.testID === 'settings.profiles.detail.save'
            && typeof node.props.onPress === 'function')[0];
        expect(save?.props.disabled).toBe(false);
        await act(async () => { f.release(); await saving; });
        expect(settled).toBe(true);
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { definition: { profile: { name: 'Awaiting ACK' } } } });
        expect(nameField()?.props.value).toBe('Awaiting ACK');
        await act(async () => { screen.unmount(); });
    });
    it('shows the shared approval row on a mounted save and keeps the draft until the approval settles', async () => {
        const f = await fixture();
        f.setProfile();
        f.requireUiApproval('launch_profiles.save');
        await f.mountHome();
        const screen = await renderScreen(React.createElement(ProfileDetailScreen, { target: { kind: 'profile', profileId: 'editable' } }));
        const nameField = () => screen.root.findAll(node => node.props.testID === 'profile-slim-name'
            && typeof node.props.onChangeText === 'function')[0];
        const notice = () => screen.root.findAll(node => node.props.testID === 'settings.profiles.detail.approval'
            && typeof node.props.onOpenApproval === 'function')[0];
        await act(async () => { nameField()!.props.onChangeText('Reviewed draft'); });
        let saving: Promise<unknown> | undefined;
        await act(async () => {
            const save = screen.root.findAll(node => node.props.testID === 'settings.profiles.detail.save'
                && typeof node.props.onPress === 'function')[0];
            saving = Promise.resolve(save!.props.onPress());
        });
        await vi.waitFor(() => expect(f.approvalArtifacts.list()).toHaveLength(1));
        const approval = f.approvalArtifacts.list()[0]!;
        await vi.waitFor(() => expect(notice()).toBeDefined());
        expect(nameField()?.props.value).toBe('Reviewed draft');
        expect(f.profileMutations).toEqual([]);
        await act(async () => { notice()!.props.onOpenApproval(); });
        expect([...f.navigation.push.mock.calls].flat().map(String).some(href => href.includes(`/inbox/approvals/${approval.id}`))).toBe(true);
        await decideApprovalAsInbox(f.context.serverId, approval.id, 'approve');
        await act(async () => { await saving; });
        expect(notice()).toBeUndefined();
        expect(f.profileRows()[0]?.content).toMatchObject({ t: 'plain', v: { definition: { profile: { name: 'Reviewed draft' } } } });
        await act(async () => { screen.unmount(); });
    });
    it('routes legacy preview through the captured-Account Machine transport and reports its typed unavailable outcome', async () => {
        const f = await fixture();
        // Same reviewed mapping as the real CLI migration boundary fixture; the strict Action schema remains the ingress owner.
        const reviewedMapping = { connection: { v: 1, id: 'pc-company', source: { kind: 'custom', template: {
            v: 1, name: 'Company', endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://company.example/v1',
                capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
            catalog: { source: 'manual', manualModelPolicy: 'allowed' } } }, role: 'named', displayName: 'Company', displayNameMode: 'custom',
            deployment: { kind: 'external' }, revision: 0, createdAt: 1, updatedAt: 1 },
            credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [] };
        const result = await f.executor.execute('launch_profiles.legacy.preview', {
            machineId: 'missing-machine', sourceProfileId: 'company', reviewedMapping,
        }, f.context);
        expect(result).toMatchObject({ ok: true, result: { status: 'error' } });
        if (!result.ok) throw new Error('Legacy preview did not enter its typed port');
        const preview = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.legacy.preview'].parse(result.result);
        if (preview.status !== 'error') throw new Error('Missing Machine unexpectedly accepted preview');
        expect(ProviderErrorV1Schema.parse(preview.error)).toMatchObject({ code: 'machine_offline', machineId: 'missing-machine', sourceProfileId: 'company' });
        expect(f.requests.some(path => path.includes('/machines'))).toBe(true);
        expect(f.requests.some(path => path.includes('/entity-rows/profiles'))).toBe(false);
        expect(f.settingsMutations).toEqual([]);
    });
});
