import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { saveAuthoringMemoryProjection } from '@/sync/domains/state/authoringMemoryPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionContextLayers } = await import('./useSessionContextLayers');

const ready: ProfileCatalogSnapshotV1 = {
    status: 'ready', authority: 'inactive', source: 'destination', control: null,
    controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 'absent',
};
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => {
    standardCleanup();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    fixture?.dispose();
    fixture = undefined;
});

describe('Work admitted Profile context', () => {
    it('admits legitimate rowless built-ins while refusing unknown, disabled and incomplete selections', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-admission.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'] }, 1);
        applyProfileCatalogSnapshot(scope, ready, true);
        const hook = await renderHook((profileId: string) => useSessionContextLayers({
            serverId: scope.serverId, sessionId: 'work', ownerMetadata: { profileId }, metadataVersion: 1,
        }), { initialProps: 'azure-openai' });
        expect(hook.getCurrent().profile).toMatchObject({ status: 'ready', name: 'Azure OpenAI', rows: [] });
        await hook.rerender('unknown-profile');
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await hook.rerender('azure-openai');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
                profileEnabledById: { 'azure-openai': false } }, 2);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, profileEnabledById: { 'azure-openai': true } }, 3);
        });
        expect(hook.getCurrent().profile.status).toBe('ready');
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(scope, { ...ready, status: 'partial', diagnostics: [{ id: 'opaque', revision: 1,
                reason: 'invalid-stored-content' }] }, true);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
    });

    it('uses the addressed Home evidence and lets a real disabled row shadow its retained builtin', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-addressed.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        const addressed = { serverId: 'profile-other-home', accountId: 'profile-other-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
            profileEnabledById: { 'gemini-api-key': false } }, 1);
        saveAccountSettings(addressed, { ...settingsDefaults, profileEnabledById: { 'gemini-api-key': true } }, 1);
        saveAuthoringMemoryProjection(addressed, { lastUsedProfile: 'azure-openai', recentMachinePaths: [], lastEngineSelectionsByScopeV1: {} });
        applyProfileCatalogSnapshot(addressed, ready, true);
        const hook = await renderHook(() => ({
            remembered: useHomeAiLaunchProfileCatalog(addressed, 'azure-openai'),
            enabled: useHomeAiLaunchProfileCatalog(addressed, 'gemini-api-key'),
        }));
        expect(hook.getCurrent().remembered.selectedProfile).toMatchObject({ id: 'azure-openai' });
        expect(hook.getCurrent().enabled.selectedProfile).toMatchObject({ id: 'gemini-api-key' });
        expect(hook.getCurrent().remembered.profiles).toEqual([]);
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(addressed, { ...ready, records: [{ revision: 1, record: {
                v: 1, id: 'azure-openai', definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) },
                enabled: false, promptStack: [], secretBindings: {},
            } }] }, true);
        });
        expect(hook.getCurrent().remembered.selectedProfile).toBeNull();
        expect(hook.getCurrent().remembered.profiles).toMatchObject([{ id: 'azure-openai', enabled: false }]);
    });
});
