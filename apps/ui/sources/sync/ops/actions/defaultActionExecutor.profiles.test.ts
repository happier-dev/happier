import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { encodeBase64 } from '@/encryption/base64';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getStorage, useCurrentSecretBindingsByProfileIdMutable } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, ProfileRowReadRequestV1Schema,
    ProfileRecordV1Schema, ProfileRowMutationV1Schema, type ProfileRecordV1, type ProfileRowMutationV1,
    type ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactReferenceV1Schema, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { settingsParse } from '@/sync/domains/settings/settings';
import { captureLazyActionAccountContext } from './actionAccountContext';
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
import { useApplyProfileSave, useDeleteAiLaunchProfile } from '@/sync/store/settingsWriters';
import { useProfilesCollection } from '@/components/settings/profiles/useProfilesCollection';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});

const navigationBoundary = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
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
const { router } = await import('expo-router');
const { ProfileDetailScreen } = await import('@/components/settings/profiles/ProfileDetailScreen');
const initialState = getStorage().getState();
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
    Object.values(navigationBoundary).forEach(method => method.mockClear());
    const navigation = navigationBoundary;
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
    let referenceGuardRevision: number | 'absent' = 'absent';
    const profileMutations: ProfileRowMutationV1[] = [];
    const artifacts = new Map<string, Artifact>();
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
                extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} } } });
    const http: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        expect(target.origin).toBe(home.serverUrl);
        requests.push(`${init?.method ?? 'GET'} ${target.pathname}`);
        if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
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
        if (target.pathname === '/v1/account/entity-rows/profiles') return Response.json({ status: 'listed', rows,
            nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision, transferControl: { status: 'absent' } });
        if (target.pathname.endsWith('/profiles/reference-guard')) return Response.json({ status: 'ready', revision: referenceGuardRevision });
        if (target.pathname.endsWith('/profiles/transfer')) return Response.json({ status: 'absent' });
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
            return Response.json({ status: 'updated', revision, cursor: revision, referenceGuardRevision });
        }
        if (target.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json(savedSecretResources);
        if (target.pathname === '/v1/artifacts') {
            if (init?.method === 'POST') {
                // The genuine HTTP boundary carries this incumbent typed Artifact create DTO.
                const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                const stored: Artifact = { ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: artifacts.size + 1, createdAt: 1, updatedAt: 1 };
                artifacts.set(stored.id, stored);
                return Response.json(stored);
            }
            // Artifact inventory is the released array response, not an object-wrapped collection.
            return Response.json([...artifacts.values()]);
        }
        if (target.pathname.startsWith('/v1/artifacts/')) {
            const artifact = artifacts.get(decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length)));
            if (artifact) return Response.json(artifact);
        }
        if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        return Response.json({ error: 'not_found' }, { status: 404 });
    };
    setRuntimeFetch(http);
    const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    return { executor: createDefaultActionExecutor(), context, requests, settingsMutations, profileMutations, navigation,
        artifacts: () => artifacts,
        profileRows: () => rows,
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
        conflictFavorite: () => { conflictFavorite = true; },
        async mountHome() {
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
    it.each(['save', 'delete', 'enabled.set', 'favorite.set', 'secrets.select'] as const)('mounted %s refuses a disabled Action before its writer', async operation => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { API_KEY: formatSharedSavedSecretRefV1('private-key') } });
        f.disableUiAction(`launch_profiles.${operation}`);
        await f.mountHome();
        const hook = await renderHook(() => ({ save: useApplyProfileSave(), remove: useDeleteAiLaunchProfile(), bindings: useCurrentSecretBindingsByProfileIdMutable()[1], collection: useProfilesCollection() }));
        const profile = hook.getCurrent().collection.resolveProfile('editable');
        if (!profile) throw new Error('Fixture Profile unavailable');
        const before = f.profileRows();
        const settingsBefore = structuredClone(f.settings());
        const invoke = () => operation === 'save' ? hook.getCurrent().save({ profile: { ...profile, name: 'Draft retained' }, expectedRevision: 4 })
            : operation === 'delete' ? hook.getCurrent().remove('editable', 4)
            : operation === 'favorite.set' ? hook.getCurrent().collection.setFavoriteProfileIds(['neighbor', 'editable'])
            : operation === 'secrets.select' ? hook.getCurrent().bindings({ editable: {} })
            : hook.getCurrent().collection.setEnabled(hook.getCurrent().collection.profiles.find(entry => entry.id === 'editable')!, false);
        await expect(Promise.resolve(invoke())).rejects.toThrow();
        expect(f.profileMutations).toEqual([]);
        expect(f.profileRows()).toEqual(before);
        expect(f.settings()).toEqual(settingsBefore);
    });

    it('acknowledges an atomic two-environment binding selection through one row CAS and preserves private None slots', async () => {
        const f = await fixture();
        f.setProfile({ enabled: true, promptStack: [], secretBindings: { KEEP: null } });
        const selected = { kind: 'resource', resourceId: 'private-key', expectedResourceRevision: 3 } as const;
        const result = await f.executor.execute('launch_profiles.secrets.select', { id: 'editable', expectedRevision: 4,
            selections: [{ envName: 'API_KEY', selection: selected }, { envName: 'SECOND_KEY', selection: selected }] }, f.context);
        expect(result).toEqual({ ok: true, result: { status: 'updated', id: 'editable', revision: 5 } });
        expect(f.profileMutations).toHaveLength(1);
        expect(f.profileMutations[0]?.savedSecretRevisions).toEqual([{ resourceId: 'private-key', expectedRevision: 3 }]);
        expect(f.profileRows()[0]).toMatchObject({ revision: 5, content: { t: 'plain', v: { secretBindings: {
            KEEP: null, API_KEY: formatSharedSavedSecretRefV1('private-key'), SECOND_KEY: formatSharedSavedSecretRefV1('private-key'),
        } } } });
        const acknowledged = structuredClone(f.profileRows());
        expect(await f.executor.execute('launch_profiles.secrets.select', { id: 'editable', expectedRevision: 4,
            selections: [{ envName: 'API_KEY', selection: { kind: 'none' } }] }, f.context))
            .toMatchObject({ ok: false, errorCode: 'profile_revision_conflict' });
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
                    selection: { ...selected, expectedResourceRevision: failure === 'stale_resource' ? 2 : 4 } }] }, f.context);
            expect(result.ok).toBe(false);
            expect(f.profileRows()).toEqual(before);
            expect(f.profileMutations).toEqual([]);
        },
    );

    it('does not resurrect a deleted remembered Profile when its raw Settings source is imported later', async () => {
        const f = await fixture();
        f.setProfile(undefined, 'private');
        f.seedLegacyRememberedProfile('private');
        const neighbor = f.neighboringMemory();
        const deleted = await f.executor.execute('launch_profiles.delete', { id: 'private', expectedRevision: 4 }, f.context);
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
        const result = await f.executor.execute('launch_profiles.delete', { id: 'private', expectedRevision: 4 }, f.context);
        expect(result).toEqual({ ok: true, result: { status: 'updated', id: 'private', revision: 5,
            authoringMemoryCleanup: { status: 'unavailable', reason: 'authoring_memory_cleanup_failed' } } });
        expect(f.profileRows()).toEqual([{ id: 'private', revision: 5, content: null }]);
        expect(f.requests).toContain('POST /v1/account/authoring-memory/lastUsedProfile');
        expect(f.memory()).toEqual({ t: 'plain', v: 'private' });
        expect(f.settings()).toMatchObject({ favoriteProfiles: ['neighbor'], futurePreference: { version: 'initial' },
            futureSecretCarrier: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'opaque-sibling-ciphertext' } } });
    });
    it('publishes the current Profile row into its Artifact definition while retaining private row metadata', async () => {
        const f = await fixture();
        const attachments = {
            enabled: false,
            promptStack: [{ id: 'private-entry', ref: { kind: 'doc' as const, artifactId: 'private-prompt' },
                enabled: true, placement: 'system_append' as const }],
            secretBindings: { API_KEY: formatSharedSavedSecretRefV1('private-key') },
        };
        f.setProfile(attachments);
        expect(f.settings()).not.toHaveProperty('profiles');
        const result = await f.executor.execute('launch_profiles.publish', { profileId: 'editable' }, f.context);
        expect(result).toMatchObject({ ok: true });
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
        expect(f.profileRows()).toEqual([{ id: 'editable', revision: 5, content: { t: 'plain', v: {
            v: 1, id: 'editable', definition: { kind: 'artifact', artifactId: reference.artifactId }, ...attachments,
        } } }]);
        expect(f.profileMutations).toMatchObject([{ id: 'editable', operation: 'update', expectedRevision: 4 }]);
        await expect(f.executor.execute('launch_profiles.publish', { profileId: 'editable' }, f.context))
            .resolves.toEqual({ ok: true, result: reference });
        expect(f.artifacts().size).toBe(1);
        expect(f.profileRows()[0]?.revision).toBe(5);
        expect(f.settingsMutations).toEqual([]);
        expect(f.settings()).not.toHaveProperty('profiles');
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
        f.conflictFavorite();
        await expect(f.executor.execute('launch_profiles.favorite.set', { id: '', favorite: true }, f.context))
            .resolves.toEqual({ ok: true, result: { status: 'updated', id: '', favorite: true } });
        expect(f.settings()).toMatchObject({ favoriteProfiles: ['', 'other-device'], futurePreference: { version: 'concurrent' } });
        expect(f.requests.some(path => path.includes('/entity-rows/profiles') || path.includes('/authoring-memory'))).toBe(false);
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
