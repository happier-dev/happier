import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storageStore';
import { projectAiLaunchProfileForLegacyUi, readUiProfileCatalogSnapshot, readUiVisibleProfileCatalogSnapshot,
    readUiSelectedProfileCatalogProfile } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadAccountSettings, readAccountSettingsPersistenceMutationToken,
    subscribeAccountSettingsPersistenceMutations } from '@/sync/domains/state/accountSettingsPersistence';
import { loadAuthoringMemoryProjection } from '@/sync/domains/state/authoringMemoryPersistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { useProfileCatalog } from './useProfileCatalog';

/** Profile consumers subscribe only to the existing Artifact store's profile documents. */
export function useLaunchProfileArtifacts() {
    return getStorage()(useShallow((state) => Object.fromEntries(Object.entries(state.artifacts)
        .filter(([, artifact]) => artifact.header?.kind === 'launch-profile.v1'))));
}

export function useAiLaunchProfiles(_retainedSource?: unknown) {
    const scope = getStorage()(useShallow((state) => state.settingsScope));
    return useHomeAiLaunchProfiles(scope);
}

export function useAiLaunchProfilesForLegacyUi(_retainedSource?: unknown) {
    const profiles = useAiLaunchProfiles();
    return React.useMemo(() => profiles.map(projectAiLaunchProfileForLegacyUi), [profiles]);
}

/** Background-Home readers use the same captured mode-aware store, never the focused Account's rows. */
export function useHomeAiLaunchProfiles(scope: AccountSettingsScope | null) {
    return useHomeAiLaunchProfileCatalog(scope).profiles;
}

/** The same profile projection, with its owner's coverage retained for inherited Context readers. */
export function useHomeAiLaunchProfileCatalog(scope: AccountSettingsScope | null, selectedProfileId?: string | null): Readonly<{
    profiles: ReturnType<typeof readUiProfileCatalogSnapshot>['profiles'];
    selectedProfile: ReturnType<typeof readUiSelectedProfileCatalogProfile>;
    status: 'loading' | 'ready' | 'partial' | 'unavailable';
    /** Complete readable rows, including retained answers while their owner refreshes. */
    hasCompleteData: boolean;
}> {
    const snapshot = useProfileCatalog(scope);
    const rows = snapshot?.data;
    const artifactsById = snapshot?.artifactsById;
    const source = snapshot?.source;
    const legacyProfiles = snapshot?.legacyProfiles;
    // Management lists keep their raw-row subscription. Only an addressed selection needs preference evidence.
    const evidenceScope = selectedProfileId ? scope : null;
    const liveEvidence = getStorage()(useShallow(state => evidenceScope && areAccountSettingsScopesEqual(state.settingsScope, evidenceScope)
        ? [state.settings.favoriteProfiles, state.settings.profileEnabledById, state.authoringMemory.lastUsedProfile] as const : null));
    const subscribeEvidence = React.useCallback((listener: () => void) => evidenceScope
        ? subscribeAccountSettingsPersistenceMutations(changed => {
            if (areAccountSettingsScopesEqual(changed, evidenceScope)) listener();
        }) : () => {}, [evidenceScope?.serverId, evidenceScope?.accountId]);
    const readEvidence = React.useCallback(() => evidenceScope ? readAccountSettingsPersistenceMutationToken(evidenceScope) : null,
        [evidenceScope?.serverId, evidenceScope?.accountId]);
    const persistedEvidence = React.useSyncExternalStore(subscribeEvidence, readEvidence, readEvidence);
    const projection = React.useMemo(() => readUiProfileCatalogSnapshot({ catalog: { status: 'loading' },
        data: rows, artifactsById: artifactsById ?? new Map(), source, legacyProfiles }),
    [rows, artifactsById, source, legacyProfiles]);
    const profiles = projection.profiles;
    const status = !scope ? 'unavailable' as const : snapshot?.catalog.status ?? 'loading';
    const hasCompleteData = snapshot?.dataComplete === true && projection.unreadableCount === 0;
    const selectedProfile = React.useMemo(() => {
        if (!evidenceScope || !snapshot || !hasCompleteData) return null;
        const settings = liveEvidence ? { favoriteProfiles: liveEvidence[0], profileEnabledById: liveEvidence[1] }
            : accountSettingsParse(loadAccountSettings(evidenceScope).settings);
        const memory = { lastUsedProfile: liveEvidence ? liveEvidence[2] : loadAuthoringMemoryProjection(evidenceScope)?.lastUsedProfile ?? null };
        return readUiSelectedProfileCatalogProfile(readUiVisibleProfileCatalogSnapshot(snapshot, settings, memory), settings, selectedProfileId);
    }, [snapshot, evidenceScope?.serverId, evidenceScope?.accountId, liveEvidence, persistedEvidence, hasCompleteData, selectedProfileId]);
    return React.useMemo(() => ({ profiles, selectedProfile, status, hasCompleteData }), [profiles, selectedProfile, status, hasCompleteData]);
}
