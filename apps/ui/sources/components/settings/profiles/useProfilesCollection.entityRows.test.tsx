import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { applyProfileCatalogSnapshot, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { useApplyProfileSave, useApplyProfileSecretBindings, useDeleteAiLaunchProfile } from '@/sync/store/settingsWriters';
import { useSaveLaunchProfile } from '@/components/profiles/edit/useSaveLaunchProfile';
import { useLaunchProfileEditorDraft } from '@/components/profiles/edit/useLaunchProfileEditorDraft';
import { LaunchProfileEditForm } from '@/components/profiles/edit/LaunchProfileEditForm';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { migrateLegacyAiLaunchProfilesV1 } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { resetAcpCatalogSnapshotsForTests, getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { buildSlimProfileSave } from '@/components/profiles/edit/slimProfileDraft';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { useCurrentSecretBindingsByProfileIdMutable } from '@/sync/store/hooks';
import { useProfilePromptStack } from '@/sync/store/useProfilePromptStack';
import { isProfileEnabled, readProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readRetainedSecretBindingsByProfileId } from '@/sync/domains/settings/secretBindings';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
    ProfileRecordV1Schema, ProfileRowMutationV1Schema, type ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { PROFILE_TRANSFER_ROUTE_V1, type ProfileTransferRowReadResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { AuthoringMemoryMutationRequestV1Schema, type AuthoringMemoryRowV1 } from '@happier-dev/protocol/account/authoringMemory';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { refreshProfileCatalog, resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

installDisconnectedServerSocketBoundary();

const scope = { serverId: 'entity-profile-home', accountId: 'entity-profile-account' };
const profile = { v: 2 as const, id: 'entity', name: 'Entity', extraEnvironmentVariables: [],
    envVarRequirements: [{ name: 'TOKEN', kind: 'secret' as const, required: true }],
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
    createdAt: 1, updatedAt: 1 };
const builtinBindingRecord = ProfileRecordV1Schema.parse({ v: 1, id: 'anthropic', enabled: false,
    definition: { kind: 'legacy', profile: { id: 'anthropic', name: 'Anthropic', isBuiltIn: true,
        envVarRequirements: [{ name: 'TOKEN', kind: 'secret', required: true }],
        defaultEnabled: true, createdAt: 1, updatedAt: 1 } }, promptStack: [],
    secretBindings: { TOKEN: 'happier:shared-secret:v1:profile-token' } });

beforeEach(() => {
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    getStorage().setState({ settingsScope: scope });
    applyProfileCatalogSnapshot(scope, { status: 'ready', source: 'destination', authority: 'active', control: null,
        controlRevision: 1, referenceGuardRevision: 1, diagnostics: [], records: [{ revision: 7,
            record: { v: 1, id: profile.id, definition: { kind: 'inline', profile }, enabled: false,
                promptStack: [], secretBindings: {} } }] }, true);
});
afterEach(() => {
    standardCleanup();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
});

describe('Profile collection entity projection', () => {
    it('keeps routing duplication at its captured source migration and resumes with the actual converted Provider selection', async () => {
        const legacy = AIBackendProfileSchema.parse({ id: 'retained-azure', name: 'Retained Azure', isBuiltIn: true,
            environmentVariables: [{ name: 'AZURE_OPENAI_ENDPOINT', value: 'https://azure.example' }],
            defaultModelMode: 'deployment-a', compatibilityByTargetKey: { 'agent:codex': true }, createdAt: 1, updatedAt: 2 });
        const source = ProfileRecordV1Schema.parse({ v: 1, id: legacy.id, definition: { kind: 'legacy', profile: legacy },
            enabled: false, promptStack: [{ id: 'retained-stack', ref: { kind: 'doc', artifactId: 'retained-doc' },
                enabled: true, placement: 'system_append' }], secretBindings: { MASKED: null } });
        const snapshot = getProfileCatalogSnapshot(scope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected a ready Profile catalog');
        applyProfileCatalogSnapshot(scope, { ...snapshot.catalog, records: [{ record: source, revision: 7 }] }, true);
        const hook = await renderHook(() => useLaunchProfileEditorDraft({ enabled: true, cloneFrom: legacy.id }));
        expect(hook.getCurrent().draft).toMatchObject({ status: 'migration', profile: { id: legacy.id }, sourceRevision: 7 });
        const saveAs = await renderHook(() => useLaunchProfileEditorDraft({ enabled: true, cloneFrom: legacy.id, saveAsBuiltin: true }));
        expect(saveAs.getCurrent().draft).toMatchObject({ status: 'migration', profile: { id: legacy.id }, sourceRevision: 7 });
        const migrated = migrateLegacyAiLaunchProfilesV1({ profiles: [legacy] }, DEFAULT_PROVIDER_SETTINGS_V1, { migratedAt: 20,
            pendingCustomProfileIds: [], candidates: [{ kind: 'connection', sourceProfileId: legacy.id,
                connection: { v: 1, id: 'pc-azure', source: { kind: 'contribution', contributionKey: 'happier.provider.openai/openai' },
                    role: 'default', displayName: 'Azure', displayNameMode: 'automatic', revision: 0, createdAt: 20, updatedAt: 20 },
                removedEnvironmentVariableNames: ['AZURE_OPENAI_ENDPOINT'], selectedModel: { agentTargetKey: 'agent:codex', modelId: 'deployment-a' } }] },
            { lastUsedProfile: null }, { profileRecordIds: [legacy.id], records: [{ record: source, revision: 7 }] });
        if (!migrated.ok) throw new Error('Expected accepted Provider conversion');
        const converted = ProfileRecordV1Schema.parse({ ...source, definition: { kind: 'inline', profile:
            Array.isArray(migrated.settings.profiles) ? migrated.settings.profiles[0] : undefined } });
        applyProfileCatalogSnapshot(scope, { ...snapshot.catalog, records: [{ record: converted, revision: 8 }] }, true);
        await hook.rerender();
        await saveAs.rerender();
        const draft = hook.getCurrent().draft;
        expect(draft).toMatchObject({ status: 'ready', profile: { v: 2, enabled: source.enabled, promptStack: source.promptStack,
            extraEnvironmentVariables: [], preferredModelSelection: { ref: { providerConnectionId: 'pc-azure', modelId: 'deployment-a' } } },
            secretBindings: { MASKED: null } });
        if (draft.status !== 'ready') throw new Error('Expected converted duplicate draft');
        expect(draft.profile.id).not.toBe(legacy.id);
        expect(draft.profile).not.toHaveProperty('artifactId');
        expect(draft.profile).not.toHaveProperty('profileRecordRevision');
        expect(saveAs.getCurrent().draft).toMatchObject({ status: 'ready', profile: { v: 2,
            preferredModelSelection: { ref: { providerConnectionId: 'pc-azure', modelId: 'deployment-a' } } } });
        await hook.unmount();
        await saveAs.unmount();
    });
    it('uses the scoped entity inventory, not a retained Settings profile argument', async () => {
        const hook = await renderHook(() => useAiLaunchProfiles([{ ...profile, id: 'retained', name: 'Retained' }]));
        expect(hook.getCurrent()).toMatchObject([{ id: 'entity', enabled: false, profileRecordRevision: 7 }]);
        await hook.unmount();
    });

    it('reads entity secret bindings instead of a retained Settings binding for the same Profile', async () => {
        const bindings = { TOKEN: 'happier:shared-secret:v1:profile-token' };
        const snapshot = getProfileCatalogSnapshot(scope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected a ready Profile catalog');
        applyProfileCatalogSnapshot(scope, { ...snapshot.catalog, records: snapshot.catalog.records.map(row => ({
            ...row, record: { ...row.record, secretBindings: bindings },
        })) }, true);
        getStorage().setState({ settings: settingsParse({ profiles: [profile], secretBindingsByProfileId: {
            [profile.id]: { TOKEN: 'happier:shared-secret:v1:retained-token' },
        } }) });
        expect(readRetainedSecretBindingsByProfileId(getStorage().getState().settings)).toEqual({
            [profile.id]: { TOKEN: 'happier:shared-secret:v1:retained-token' },
        });
        const hook = await renderHook(useCurrentSecretBindingsByProfileIdMutable);
        expect(hook.getCurrent()[0]).toEqual({ [profile.id]: bindings });
        await hook.unmount();
    });

    it('uses historical builtin entity enablement instead of its stale ordinary preference', async () => {
        getStorage().setState({ settings: settingsParse({ profileEnabledById: { anthropic: true } }) });
        const snapshot = getProfileCatalogSnapshot(scope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected a ready Profile catalog');
        applyProfileCatalogSnapshot(scope, { ...snapshot.catalog,
            records: [{ record: builtinBindingRecord, revision: 7 }] }, true);
        const hook = await renderHook(useAiLaunchProfiles);
        const admitted = hook.getCurrent()[0];
        expect(admitted).toMatchObject({ id: 'anthropic', enabled: false,
            secretBindings: builtinBindingRecord.secretBindings });
        expect(isProfileEnabled(admitted, readProfileEnabledById(getStorage().getState().settings.profileEnabledById))).toBe(false);
        await hook.unmount();
    });
});

describe('Profile editor entity writer', () => {
    beforeAll(loadSyncSingletonForTests);
    const mutation = vi.fn<RuntimeFetch>();
    const settingsWrites = vi.fn<RuntimeFetch>();
    const artifactWrites = vi.fn<RuntimeFetch>();
    let homeScope: typeof scope;
    let record: ProfileRecordV1;
    let revision: number;
    let guardRevision: number;
    let rowDeleted: boolean;
    let rowAbsent: boolean;
    let accountSettings: Record<string, unknown>;
    let accountSettingsVersion: number;
    let credentials: AuthCredentials;
    let acpRead: () => Response | Promise<Response>;
    const artifacts = new Map<string, Artifact>();
    const memoryRows = new Map<string, AuthoringMemoryRowV1>();
    const secretMaterials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
        resourceId: 'profile-token', encryptionMode: 'plain',
        entry: { ref: 'happier:shared-secret:v1:profile-token', source: 'shared_resource', relationship: 'owner',
            name: 'Profile token', kind: 'token', revision: 5, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        storedContent: { t: 'plain', v: { v: 1, name: 'Profile token', kind: 'token', value: 'test-token' } },
        recipientEnvelope: null,
    }] });
    const transfer = { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 13,
            migratedLogicalRevision: 1, inventory: [{ kind: 'account_row', id: profile.id, revision: 7 }] } } } satisfies ProfileTransferRowReadResponseV1;

    beforeEach(async () => {
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        await disconnectActiveServerConnection();
        retireActiveServerAccountScopeLifetime();
        mutation.mockReset();
        settingsWrites.mockReset();
        artifactWrites.mockReset();
        artifacts.clear();
        memoryRows.clear();
        settingsWrites.mockResolvedValue(Response.json({ error: 'unexpected_settings_write' }, { status: 403 }));
        revision = 7;
        guardRevision = 3;
        rowDeleted = false;
        rowAbsent = false;
        accountSettings = {};
        accountSettingsVersion = 13;
        acpRead = () => Response.json({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, definitions: [] } } });
        record = { v: 1, id: profile.id, definition: { kind: 'inline', profile }, enabled: false,
            promptStack: [{ id: 'attached-prompt', ref: { kind: 'doc', artifactId: 'prompt-doc' },
                enabled: true, placement: 'system_append' }],
            secretBindings: { TOKEN: 'happier:shared-secret:v1:profile-token' } };
        // HTTP and disconnected sockets are genuine boundaries; Account capture, crypto,
        // mutation schemas, operation services and the mounted store remain real.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json({ ...createPlainAccountEncryptionCurrentnessFixture(), settingsVersion: accountSettingsVersion });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return acpRead();
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [...memoryRows.values()] });
            if (path.startsWith(`${AUTHORING_MEMORY_ROUTE_V1}/`)) {
                const key = decodeURIComponent(path.slice(AUTHORING_MEMORY_ROUTE_V1.length + 1));
                const current = memoryRows.get(key);
                if (init?.method === 'POST') {
                    const request = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
                    if (request.expectedRevision !== (current?.revision ?? 'absent')) {
                        return Response.json({ status: 'conflict', revision: current?.revision ?? -1 });
                    }
                    const nextRevision = (current?.revision ?? 0) + 1;
                    memoryRows.set(key, { key, revision: nextRevision, content: request.content });
                    return Response.json({ status: 'updated', revision: nextRevision, cursor: nextRevision });
                }
                return Response.json(!current ? { status: 'absent' } : current.content === null
                    ? { status: 'deleted', revision: current.revision }
                    : { status: 'present', revision: current.revision, content: current.content });
            }
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(secretMaterials);
            if (path === '/v2/account/settings' && init?.method !== 'POST') return Response.json({ content: { t: 'plain', v: accountSettings }, version: accountSettingsVersion });
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/artifacts' && init?.method !== 'POST') return Response.json([...artifacts.values()]);
            if (path.startsWith('/v1/artifacts/') && init?.method !== 'POST' && init?.method !== 'PUT') {
                const artifact = artifacts.get(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
                if (artifact) return Response.json(artifact);
            }
            if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed',
                rows: rowAbsent ? [] : [{ id: record.id, revision, content: rowDeleted ? null : { t: 'plain', v: record } }],
                nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: guardRevision, transferControl: transfer });
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: guardRevision });
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json(transfer);
            if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') return mutation(url, init);
            if (path.endsWith('/account/settings') && init?.method === 'POST') return settingsWrites(url, init);
            if (path.startsWith('/v1/artifacts/') && init?.method !== 'GET') return artifactWrites(url, init);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const home = await upsertAndActivateServer({ serverUrl: 'https://profile-writer-home.example.test', name: 'Profile writer' });
        credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'profile-writer-account' })).toString('base64url')}.signature` };
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await restoreConnectionToActiveServer(credentials);
        homeScope = { serverId: home.id, accountId: 'profile-writer-account' };
        getStorage().setState({ settingsScope: homeScope, profileScope: homeScope,
            settings: settingsParse(accountSettings), settingsVersion: accountSettingsVersion });
        applyProfileCatalogSnapshot(homeScope, { status: 'ready', source: 'destination', authority: 'active', control: {
            record: transfer.content.v, revision: transfer.revision }, controlRevision: 1,
            referenceGuardRevision: guardRevision, diagnostics: [], records: [{ record, revision }] }, true);
    });
    afterEach(async () => {
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        await disconnectActiveServerConnection();
        retireActiveServerAccountScopeLifetime();
        resetRuntimeFetch();
    });

    function admitBuiltinBindingRow(bindingRecord = builtinBindingRecord) {
        record = bindingRecord;
        accountSettings = { profileEnabledById: { [record.id]: true }, favoriteProfiles: [profile.id] };
        getStorage().setState({ settings: settingsParse(accountSettings), settingsVersion: accountSettingsVersion });
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [{ record, revision }] }, true);
    }

    it.each([true, false])('atomically captures and retires the builtin no-entity enablement preference on first attachment (key present: %s)', async hasPreference => {
        accountSettings = { profileEnabledById: { ...(hasPreference ? { 'azure-openai': false } : {}), 'gemini-api-key': false },
            favoriteProfiles: ['keep-favorite'], lastUsedAgent: 'codex', futurePreference: { retain: 'opaque' } };
        getStorage().setState({ settings: settingsParse(accountSettings), settingsVersion: accountSettingsVersion });
        rowDeleted = true;
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [] }, true);
        let captured: ReturnType<typeof ProfileRowMutationV1Schema.parse> | undefined;
        mutation.mockImplementation(async (_url, init) => {
            captured = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            if (captured.content?.t !== 'plain') throw new Error('Expected keyless Plain Profile attachment');
            record = captured.content.v;
            revision = 1;
            rowDeleted = false;
            guardRevision = 4;
            if (captured.settingsCleanup?.nextSettings?.t === 'plain') {
                accountSettings = captured.settingsCleanup.nextSettings.v;
                accountSettingsVersion++;
            }
            return Response.json({ status: 'updated', revision, cursor: 25, referenceGuardRevision: guardRevision });
        });
        const hook = await renderHook(useApplyProfileSecretBindings);
        await hook.getCurrent()({ profileId: 'azure-openai', expectedRevision: 'absent',
            secretBindings: { TOKEN: 'happier:shared-secret:v1:profile-token' } });
        expect(captured).toMatchObject({ operation: 'attach-builtin', expectedRevision: 'absent',
            content: { t: 'plain', v: { id: 'azure-openai', enabled: !hasPreference,
                secretBindings: { TOKEN: 'happier:shared-secret:v1:profile-token' } } },
            settingsCleanup: { expectedSettingsVersion: 13, nextSettings: { t: 'plain', v: {
                profileEnabledById: { 'gemini-api-key': false }, favoriteProfiles: ['keep-favorite'],
                lastUsedAgent: 'codex', futurePreference: { retain: 'opaque' } } } } });
        expect(accountSettingsVersion).toBe(14);
        expect(getStorage().getState().settingsVersion).toBe(14);
        expect(getStorage().getState().settings.profileEnabledById).toEqual({ 'gemini-api-key': false });
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(getProfileCatalogSnapshot(homeScope)?.data).toMatchObject([{ record: { id: 'azure-openai', enabled: !hasPreference }, revision: 1 }]);
        await hook.unmount();
    });

    it('treats a Provider-converted inline Profile with a historical preset id as a row entity', async () => {
        const { useProfilesCollection } = await import('./useProfilesCollection');
        const converted = { ...profile, id: 'deepseek', name: 'Converted DeepSeek' };
        record = { ...record, id: converted.id, definition: { kind: 'inline', profile: converted } };
        accountSettings = { profileEnabledById: { deepseek: true } };
        getStorage().setState({ settings: settingsParse(accountSettings) });
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [{ record, revision }] }, true);
        mutation.mockResolvedValue(Response.json({ status: 'updated', revision: 8, cursor: 24, referenceGuardRevision: 4 }));
        const hook = await renderHook(useProfilesCollection);
        const admitted = hook.getCurrent().profiles.find(entry => entry.id === converted.id);
        if (!admitted) throw new Error('Expected the converted inline Profile');
        expect(admitted.isBuiltIn).toBe(false);
        expect(hook.getCurrent().isEnabled(admitted)).toBe(false);
        await expect(hook.getCurrent().setEnabled(admitted, true)).resolves.toBeUndefined();
        expect(settingsWrites).not.toHaveBeenCalled();
        const [, init] = mutation.mock.calls[0];
        expect(ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)))).toMatchObject({
            operation: 'update', id: converted.id, expectedRevision: 7,
            content: { t: 'plain', v: { enabled: true, definition: { kind: 'inline', profile: converted },
                secretBindings: record.secretBindings, promptStack: record.promptStack } },
        });
        await hook.unmount();
    });

    it('awaits canonical builtin entity enablement row ACK without changing its definition or private bindings', async () => {
        const { useProfilesCollection } = await import('./useProfilesCollection');
        const definition = getBuiltInBackendProfile('gemini-api-key');
        if (!definition) throw new Error('Expected the canonical Gemini API-key builtin');
        admitBuiltinBindingRow(ProfileRecordV1Schema.parse({ v: 1, id: definition.id,
            definition: { kind: 'legacy', profile: definition }, enabled: false, promptStack: [],
            secretBindings: { GEMINI_API_KEY: 'happier:shared-secret:v1:profile-token' } }));
        const admittedRecord = record;
        let acknowledge!: (response: Response) => void;
        mutation.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
        const hook = await renderHook(useProfilesCollection);
        const builtin = hook.getCurrent().profiles.find(entry => entry.id === record.id);
        if (!builtin) throw new Error('Expected the canonical builtin binding row to project');
        expect(hook.getCurrent().isEnabled(builtin)).toBe(false);
        const pending = hook.getCurrent().setEnabled(builtin, true);
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.waitFor(() => expect(mutation).toHaveBeenCalled());
        await hook.rerender();
        expect(hook.getCurrent().isEnabled(builtin)).toBe(false);
        const [url, init] = mutation.mock.calls[0];
        expect(new URL(String(url)).origin).toBe('https://profile-writer-home.example.test');
        expect(new URL(String(url)).pathname).toBe(PROFILE_RECORDS_ROUTE_V1);
        const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
        expect(request).toMatchObject({ id: builtin.id, operation: 'update', expectedRevision: 7,
            content: { t: 'plain', v: { ...admittedRecord, enabled: true } } });
        if (request.content?.t !== 'plain') throw new Error('Expected keyless Plain Profile row write');
        record = request.content.v;
        revision = 8;
        guardRevision = 4;
        acknowledge(Response.json({ status: 'updated', revision, cursor: 22, referenceGuardRevision: guardRevision }));
        await expect(pending).resolves.toBeUndefined();
        await hook.rerender();
        const updatedBuiltin = hook.getCurrent().profiles.find(entry => entry.id === builtin.id);
        if (!updatedBuiltin) throw new Error('Expected acknowledged builtin entity');
        expect(hook.getCurrent().isEnabled(updatedBuiltin)).toBe(true);
        expect(getStorage().getState().settingsVersion).toBe(13);
        expect(getProfileCatalogSnapshot(homeScope)?.data).toEqual([{ record: { ...admittedRecord, enabled: true }, revision: 8 }]);
        expect(hook.getCurrent().secretBindingsByProfileId[builtin.id]).toEqual(admittedRecord.secretBindings);
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(artifactWrites).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('preserves builtin entity enablement and private bindings after a row CAS conflict', async () => {
        const { useProfilesCollection } = await import('./useProfilesCollection');
        admitBuiltinBindingRow();
        const admittedRecord = record;
        mutation.mockResolvedValue(Response.json({ status: 'conflict', revision: 9 }, { status: 409 }));
        const hook = await renderHook(useProfilesCollection);
        const builtin = hook.getCurrent().profiles.find(entry => entry.id === 'anthropic');
        if (!builtin) throw new Error('Expected the historical builtin binding row to project');
        await expect(hook.getCurrent().setEnabled(builtin, true)).rejects.toThrow('profile_revision_conflict');
        expect(mutation).toHaveBeenCalled();
        const [, init] = mutation.mock.calls[0];
        expect(ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body))).expectedRevision).toBe(7);
        await hook.rerender();
        expect(hook.getCurrent().isEnabled(builtin)).toBe(false);
        expect(getStorage().getState().settings.profileEnabledById).toEqual({ anthropic: true });
        expect(getProfileCatalogSnapshot(homeScope)?.data).toEqual([{ record: admittedRecord, revision: 7 }]);
        expect(hook.getCurrent().secretBindingsByProfileId.anthropic).toEqual(admittedRecord.secretBindings);
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(artifactWrites).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('awaits Profile prompt-stack row ACK without replacing definition, enablement or private bindings', async () => {
        let acknowledge!: (response: Response) => void;
        mutation.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
        const admittedRecord = record;
        const next = [{ ...record.promptStack[0], enabled: false }];
        const hook = await renderHook(() => useProfilePromptStack(profile.id));
        const pending = hook.getCurrent().setEntries(next);
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.waitFor(() => expect(mutation).toHaveBeenCalled());
        expect(hook.getCurrent().entries).toEqual(admittedRecord.promptStack);
        const [url, init] = mutation.mock.calls[0];
        expect(new URL(String(url)).origin).toBe('https://profile-writer-home.example.test');
        const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
        expect(request).toMatchObject({ id: profile.id, operation: 'update', expectedRevision: 7,
            content: { t: 'plain', v: { ...admittedRecord, promptStack: next } },
            referencedSavedSecretIds: ['happier:shared-secret:v1:profile-token'] });
        if (request.content?.t !== 'plain') throw new Error('Expected keyless Plain Account write');
        record = request.content.v;
        revision = 8;
        guardRevision = 4;
        acknowledge(Response.json({ status: 'updated', revision, cursor: 23, referenceGuardRevision: guardRevision }));
        await expect(pending).resolves.toBeUndefined();
        await hook.rerender();
        expect(hook.getCurrent().entries).toEqual(next);
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(getStorage().getState().settingsVersion).toBe(13);
        await hook.unmount();
    });

    it('retains the admitted Profile prompt stack when its row CAS conflicts', async () => {
        mutation.mockResolvedValue(Response.json({ status: 'conflict', revision: 9 }, { status: 409 }));
        const admittedRecord = record;
        const hook = await renderHook(() => useProfilePromptStack(profile.id));
        await expect(hook.getCurrent().setEntries([])).rejects.toBeInstanceOf(Error);
        await hook.rerender();
        expect(hook.getCurrent().entries).toEqual(admittedRecord.promptStack);
        expect(getProfileCatalogSnapshot(homeScope)?.data).toEqual([{ record: admittedRecord, revision: 7 }]);
        expect(settingsWrites).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('saves a detached MachineLogin draft with its captured source CAS through the mounted editor writer', async () => {
        const legacy = AIBackendProfileSchema.parse({ id: profile.id, name: 'Machine login', authMode: 'machineLogin',
            requiresMachineLoginTargetKey: 'agent:claude', requiresMachineLogin: 'claude',
            compatibility: { claude: true }, defaultPermissionModeByAgent: { claude: 'default' },
            environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'retained' }],
            createdAt: 1, updatedAt: 2 });
        record = { ...record, definition: { kind: 'legacy', profile: legacy }, secretBindings: { ...record.secretBindings, MASKED: null } };
        admitBuiltinBindingRow(record);
        const source = record;
        const draft = await renderHook(() => useLaunchProfileEditorDraft({ enabled: true, cloneFrom: legacy.id }));
        const captured = draft.getCurrent().draft;
        if (captured.status !== 'ready') throw new Error('Expected a source-admitted MachineLogin draft');
        let submitted: ReturnType<typeof ProfileRowMutationV1Schema.parse> | undefined;
        mutation.mockImplementation(async (_url, init) => {
            submitted = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            if (submitted.content?.t !== 'plain') throw new Error('Expected Plain detached copy');
            record = submitted.content.v; revision = 0; guardRevision = 4;
            return Response.json({ status: 'updated', revision, cursor: 25, referenceGuardRevision: guardRevision });
        });
        const editor = await renderHook(useSaveLaunchProfile);
        const saveRef: React.MutableRefObject<(() => boolean | Promise<boolean>) | null> = { current: null };
        const form = await renderScreen(React.createElement(LaunchProfileEditForm, {
            profile: captured.profile, machineId: null, sourcePreservingClone: true, saveRef, onCancel: () => {},
            onSave: async (next, bindings) => (await editor.getCurrent()(next, {
                ...Object.fromEntries(Object.entries(captured.secretBindings ?? {}).filter(([, binding]) => binding === null)),
                ...bindings,
            }, captured.legacyCloneSource)) !== null,
        }));
        await vi.waitFor(() => expect(saveRef.current).not.toBeNull());
        form.changeTextByTestId('profile-legacy-name', 'Named Machine login copy');
        let finishAcpRefresh!: (response: Response) => void;
        acpRead = () => new Promise(resolve => { finishAcpRefresh = resolve; });
        const refreshing = refreshAcpCatalog(homeScope);
        const readyAcpResponse = () => Response.json({ status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, definitions: [] } } });
        try {
            await vi.waitFor(() => expect(getAcpCatalogSnapshot(homeScope)?.catalog.status).toBe('loading'));
            await vi.waitFor(() => expect(form.findHostByTestId('profile-legacy-catalog-availability')).not.toBeNull());
            await expect(Promise.resolve(saveRef.current?.())).resolves.toBe(false);
            expect(mutation).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(finishAcpRefresh).toBeTypeOf('function'));
        } finally {
            // A later real reference-census read must not inherit a deferred IO boundary.
            acpRead = readyAcpResponse;
            finishAcpRefresh?.(readyAcpResponse());
        }
        await refreshing;
        await vi.waitFor(() => expect(getAcpCatalogSnapshot(homeScope)?.catalog.status).toBe('ready'));
        await vi.waitFor(() => expect(form.findHostByTestId('profile-legacy-name')?.props.value).toBe('Named Machine login copy'));
        await expect(saveRef.current?.()).resolves.toBe(true);
        expect(submitted).toMatchObject({ operation: 'clone-legacy', expectedRevision: 'absent',
            legacyCloneSource: { id: source.id, revision: 7 }, content: { t: 'plain', v: {
                definition: { kind: 'legacy', profile: { environmentVariables: legacy.environmentVariables,
                    authMode: 'machineLogin', requiresMachineLoginTargetKey: legacy.requiresMachineLoginTargetKey, requiresMachineLogin: legacy.requiresMachineLogin,
                    compatibility: legacy.compatibility, defaultPermissionModeByAgent: legacy.defaultPermissionModeByAgent,
                    name: 'Named Machine login copy' } },
                enabled: source.enabled, promptStack: source.promptStack, secretBindings: source.secretBindings } } });
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(artifactWrites).not.toHaveBeenCalled();
        await form.unmount();
        await editor.unmount();
        await draft.unmount();
    });

    it('refuses a stale captured MachineLogin source without replacing the editor draft or dispatching a write', async () => {
        const legacy = AIBackendProfileSchema.parse({ id: profile.id, name: 'Machine login', authMode: 'machineLogin',
            requiresMachineLoginTargetKey: 'agent:claude', environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'retained' }],
            createdAt: 1, updatedAt: 2 });
        record = { ...record, definition: { kind: 'legacy', profile: legacy }, secretBindings: { MASKED: null } };
        admitBuiltinBindingRow(record);
        const draft = await renderHook(() => useLaunchProfileEditorDraft({ enabled: true, cloneFrom: legacy.id }));
        const captured = draft.getCurrent().draft;
        if (captured.status !== 'ready') throw new Error('Expected a captured detached draft');
        revision = 8;
        record = { ...record, definition: { kind: 'legacy', profile: { ...legacy,
            environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'updated elsewhere' }] } } };
        admitBuiltinBindingRow(record);
        const editor = await renderHook(useSaveLaunchProfile);
        await expect(editor.getCurrent()(captured.profile, captured.secretBindings, captured.legacyCloneSource)).resolves.toBeNull();
        expect(mutation).not.toHaveBeenCalled();
        await draft.rerender();
        expect(draft.getCurrent().draft).toEqual(captured);
        await editor.unmount();
        await draft.unmount();
    });

    it('awaits the captured Account row ACK and preserves private attachments without writing Settings', async () => {
        let acknowledge!: (response: Response) => void;
        mutation.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
        const hook = await renderHook(useApplyProfileSave);
        const draft = { ...profile, name: 'Edited entity' };
        const pending = hook.getCurrent()({ profile: draft, expectedRevision: 7 });
        expect(pending).toBeInstanceOf(Promise);
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.waitFor(() => expect(mutation).toHaveBeenCalled());
        expect(settled).toBe(false);
        const [url, init] = mutation.mock.calls[0];
        expect(new URL(String(url)).origin).toBe('https://profile-writer-home.example.test');
        const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
        expect(request).toEqual({ id: profile.id, operation: 'update', expectedRevision: 7,
            content: { t: 'plain', v: { ...record, definition: { kind: 'inline', profile: draft } } },
            referencedSavedSecretIds: ['happier:shared-secret:v1:profile-token'],
            artifactRevision: null,
            savedSecretRevisions: [{ resourceId: 'profile-token', expectedRevision: 5 }] });
        if (request.content?.t !== 'plain') throw new Error('Expected keyless Plain Account write');
        record = request.content.v;
        revision = 8;
        guardRevision = 4;
        acknowledge(Response.json({ status: 'updated', revision, cursor: 22, referenceGuardRevision: guardRevision }));
        await expect(pending).resolves.toEqual({ status: 'updated', id: profile.id, revision: 8 });
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ revision: 8, record: { definition: { profile: { name: draft.name } } } }] });
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(getStorage().getState().settingsVersion).toBe(13);
        const reopened = await renderHook(() => useAiLaunchProfiles([]));
        expect(reopened.getCurrent()).toMatchObject([{ id: profile.id, name: draft.name, enabled: false, profileRecordRevision: 8 }]);
        await reopened.unmount();
        await hook.unmount();
    });

    it('returns stale-row conflict without losing the draft or replacing the admitted record', async () => {
        mutation.mockResolvedValue(Response.json({ status: 'conflict', revision: 9 }, { status: 409 }));
        const hook = await renderHook(useApplyProfileSave);
        const draft = { ...profile, name: 'Unsaved draft' };
        await expect(hook.getCurrent()({ profile: draft, expectedRevision: 7 })).resolves.toEqual({
            status: 'conflict', id: profile.id, revision: 9 });
        expect(draft.name).toBe('Unsaved draft');
        expect(record.definition).toEqual({ kind: 'inline', profile });
        expect(getProfileCatalogSnapshot(homeScope)?.data).toMatchObject([{ revision: 7,
            record: { definition: { kind: 'inline', profile: { name: profile.name } }, enabled: false,
                promptStack: record.promptStack, secretBindings: record.secretBindings } }]);
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(getStorage().getState().settingsVersion).toBe(13);
        await hook.unmount();
    });

    it('retires a late legacy remembered source after a mounted deletion so the real importer cannot resurrect it', async () => {
        const sync = getSyncSingleton();
        // Exercise the already-loaded owner: its initial empty source import
        // must not stand in for observing a retained source at deletion time.
        await sync.applyAuthoringMemoryDelta({}, { expectedSettingsScope: homeScope });
        accountSettings = { lastUsedProfile: profile.id, favoriteProfiles: [profile.id, 'neighbor'],
            opaquePreference: { retained: true } };
        accountSettingsVersion = 14;
        getStorage().setState({ settings: settingsParse(accountSettings), settingsVersion: accountSettingsVersion });
        settingsWrites.mockImplementation(async (_url, init) => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init?.body)));
            expect(request.expectedVersion).toBe(accountSettingsVersion);
            if (request.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account source retirement');
            accountSettings = request.content.v;
            accountSettingsVersion += 1;
            return Response.json({ success: true, version: accountSettingsVersion });
        });
        mutation.mockImplementation(async (_url, init) => {
            const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            expect(request).toMatchObject({ operation: 'remove', id: profile.id, expectedRevision: 7 });
            if (request.settingsCleanup) {
                expect(request.settingsCleanup.expectedSettingsVersion).toBe(accountSettingsVersion);
                if (request.settingsCleanup.nextSettings?.t !== 'plain') throw new Error('Expected atomic Plain Account preference cleanup');
                accountSettings = request.settingsCleanup.nextSettings.v;
                accountSettingsVersion += 1;
            }
            revision = 8;
            guardRevision = 4;
            rowDeleted = true;
            return Response.json({ status: 'updated', revision, cursor: 27, referenceGuardRevision: guardRevision });
        });
        const hook = await renderHook(useDeleteAiLaunchProfile);
        await expect(hook.getCurrent()(profile.id, 7)).resolves.toMatchObject({ status: 'updated', id: profile.id, revision: 8 });
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready',
            records: [], tombstones: [{ id: profile.id, revision: 8 }] });
        await hook.unmount();
        // Reconfiguring the real Account owner runs the actual absence-only
        // importer again, including its canonical HTTP retirement path.
        sync.reconfigureAuthoringMemoryForAccountMode(credentials, 'plain');
        await sync.applyAuthoringMemoryDelta({}, { expectedSettingsScope: homeScope });
        expect(getStorage().getState().authoringMemory.lastUsedProfile).toBeNull();
        expect(accountSettings).not.toHaveProperty('lastUsedProfile');
        expect(accountSettings).toMatchObject({ favoriteProfiles: ['neighbor'], opaquePreference: { retained: true } });
    });

    it('saves an unchanged granted Profile as a reference-only membership using ready catalog absence', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile, secretBindings: {} });
        const resource = { artifactId: 'granted-profile', header: buildLaunchProfileArtifactHeaderV1(content),
            body: JSON.stringify(content), access: 'view', ownerAccountId: 'other-account',
            revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
        artifacts.set(resource.artifactId, { id: resource.artifactId, ownerAccountId: resource.ownerAccountId, access: 'view',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(resource.header), body: encodePlainArtifactStoredContent({ body: resource.body }),
            headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1 });
        rowAbsent = true;
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [] }, true,
            new Map([[resource.artifactId, resource]]));
        mutation.mockImplementation(async (_url, init) => {
            const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.content?.t !== 'plain') throw new Error('Expected Plain private membership');
            record = request.content.v;
            revision = 1;
            guardRevision = 4;
            rowAbsent = false;
            return Response.json({ status: 'updated', revision, cursor: 25, referenceGuardRevision: guardRevision });
        });
        const source = await renderHook(useAiLaunchProfiles);
        const granted = source.getCurrent().find(entry => entry.id === profile.id);
        if (!granted) throw new Error('Expected the granted Profile in the actual catalog projection');
        expect(granted.profileRecordRevision).toBeUndefined();
        if (!isLaunchProfileV2(granted)) throw new Error('Expected the actual V2 Artifact fixture');
        const unchangedDraft = buildSlimProfileSave(granted, { name: granted.name, description: granted.description ?? '',
            extraEnvironmentVariables: granted.extraEnvironmentVariables }, () => 41);
        if (unchangedDraft.status !== 'success') throw new Error('Expected the canonical unchanged editor draft');
        const editor = await renderHook(useSaveLaunchProfile);
        await expect(editor.getCurrent()(unchangedDraft.profile)).resolves.toMatchObject({ created: false,
            profile: { id: profile.id, artifactId: resource.artifactId, profileRecordRevision: 1 } });
        const [, init] = mutation.mock.calls[0];
        expect(ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)))).toMatchObject({
            operation: 'create', id: profile.id, expectedRevision: 'absent',
            content: { t: 'plain', v: { definition: { kind: 'artifact', artifactId: resource.artifactId },
                secretBindings: {}, promptStack: [] } },
        });
        expect(artifactWrites).not.toHaveBeenCalled();
        expect(settingsWrites).not.toHaveBeenCalled();
        await editor.unmount();
        await source.unmount();
    });

    it('rejects literal environment values in an editable Artifact without disclosing or losing the draft', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile, secretBindings: {} });
        const resource = { artifactId: 'editable-profile', header: buildLaunchProfileArtifactHeaderV1(content),
            body: JSON.stringify(content), access: 'edit', ownerAccountId: homeScope.accountId,
            revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
        record = { ...record, definition: { kind: 'artifact', artifactId: resource.artifactId } };
        const admittedRecord = record;
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [{ record, revision }] }, true,
            new Map([[resource.artifactId, resource]]));
        const hook = await renderHook(useApplyProfileSave);
        // The canonical Artifact contract forbids every literal environment value,
        // even an explicit public-value override; the source body above is valid.
        const variables = [{ name: 'TOKEN', value: 'must-not-be-published', isSecret: false }];
        const draft = { ...profile, name: 'Unsaved value-bearing draft', extraEnvironmentVariables: variables,
            artifactId: resource.artifactId, revision: resource.revision, profileRecordRevision: 7 };
        await expect(hook.getCurrent()({ profile: draft, expectedRevision: 7 })).resolves.toEqual({
            status: 'invalid', reason: 'invalid-definition', id: profile.id });
        expect(draft.name).toBe('Unsaved value-bearing draft');
        expect(draft.extraEnvironmentVariables).toEqual(variables);
        expect(getProfileCatalogSnapshot(homeScope)?.data).toEqual([{ record: admittedRecord, revision: 7 }]);
        expect(getProfileCatalogSnapshot(homeScope)?.artifactsById.get(resource.artifactId)?.body).toBe(resource.body);
        expect(artifactWrites).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        expect(settingsWrites).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps an inherited Artifact binding absent after selecting None and receiving the private row ACK', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile,
            secretBindings: { TOKEN: 'happier:shared-secret:v1:profile-token' } });
        const artifact: Artifact = { id: 'inherited-binding-profile', ownerAccountId: 'resource-owner', access: 'view',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildLaunchProfileArtifactHeaderV1(content)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1 };
        artifacts.set(artifact.id, artifact);
        record = { ...record, definition: { kind: 'artifact', artifactId: artifact.id }, secretBindings: {} };
        await refreshProfileCatalog(homeScope);
        expect(getProfileCatalogSnapshot(homeScope)?.catalog).toMatchObject({ status: 'ready', source: 'destination' });
        mutation.mockImplementation(async (_url, init) => {
            const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
            if (request.content?.t !== 'plain') throw new Error('Expected a private Plain Account Profile write');
            record = request.content.v;
            revision = 8;
            guardRevision = 4;
            return Response.json({ status: 'updated', revision, cursor: 26, referenceGuardRevision: guardRevision });
        });
        const hook = await renderHook(useCurrentSecretBindingsByProfileIdMutable);
        expect(hook.getCurrent()[0]).toEqual({ [profile.id]: { TOKEN: content.secretBindings.TOKEN } });
        await hook.getCurrent()[1]({ [profile.id]: {} });
        const [, init] = mutation.mock.calls[0];
        const request = ProfileRowMutationV1Schema.parse(JSON.parse(String(init?.body)));
        expect(request, JSON.stringify({ operation: request.operation, expectedRevision: request.expectedRevision,
            secretBindings: request.content?.t === 'plain' ? request.content.v.secretBindings : null,
            referencedSavedSecretIds: request.referencedSavedSecretIds, artifactRevision: request.artifactRevision })).toMatchObject({
            operation: 'update', expectedRevision: 7,
            content: { t: 'plain', v: { secretBindings: { TOKEN: null } } }, referencedSavedSecretIds: [],
        });
        await hook.rerender();
        expect(hook.getCurrent()[0][profile.id]?.TOKEN).toBeUndefined();
        expect(getProfileCatalogSnapshot(homeScope)?.data).toMatchObject([{ revision: 8,
            record: { secretBindings: { TOKEN: null }, definition: { kind: 'artifact', artifactId: artifact.id } } }]);
        expect(artifactWrites).not.toHaveBeenCalled();
        expect(settingsWrites).not.toHaveBeenCalled();
        expect(artifacts.get(artifact.id)?.body).toBe(artifact.body);
        await hook.unmount();
    });

    it('preserves a published draft when its captured Artifact revision is stale', async () => {
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile, secretBindings: {} });
        const resource = { artifactId: 'published-profile', header: buildLaunchProfileArtifactHeaderV1(content),
            body: JSON.stringify(content), access: 'admin', ownerAccountId: homeScope.accountId,
            revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
        record = { ...record, definition: { kind: 'artifact', artifactId: resource.artifactId } };
        const snapshot = getProfileCatalogSnapshot(homeScope);
        if (snapshot?.catalog.status !== 'ready') throw new Error('Expected an admitted Profile catalog');
        applyProfileCatalogSnapshot(homeScope, { ...snapshot.catalog, records: [{ record, revision }] }, true,
            new Map([[resource.artifactId, resource]]));
        const hook = await renderHook(useApplyProfileSave);
        const draft = { ...profile, name: 'Unsaved published draft', artifactId: resource.artifactId,
            revision: { headerVersion: 1, bodyVersion: 2 }, profileRecordRevision: 7 };
        await expect(hook.getCurrent()({ profile: draft, expectedRevision: 7 })).resolves.toEqual({
            status: 'conflict', id: profile.id, revision: 7 });
        expect(draft.name).toBe('Unsaved published draft');
        expect(getProfileCatalogSnapshot(homeScope)?.artifactsById.get(resource.artifactId)?.body).toBe(resource.body);
        expect(artifactWrites).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        expect(settingsWrites).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
