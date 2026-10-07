import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import * as React from 'react';
import { readProviderSettingsFromAccountSettingsV1 } from '@happier-dev/protocol/providers/settings/readFromAccountSettingsV1';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { readProfileEnabledById, type ProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { resolveVisibleBuiltInLaunchProfiles } from '@/sync/domains/profiles/visibleBuiltInLaunchProfiles';
import { useSetting } from '@/sync/domains/state/storage';

import { buildProfilesListGroups, getDefaultProfileListStrings, getProfileSubtitle } from './profileListModel';

/**
 * The profiles a list shows, grouped (favorites, your profiles, built-in), with what each row says
 * about the agents it runs on. One owner for every profile list: pickers, the Settings › Profiles
 * page and its collection rail.
 */
export function useProfilesListModel(params: Readonly<{
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    profileEnabledById?: ProfileEnabledById | null;
    includeDisabledProfiles?: boolean;
    machineId: string | null;
    serverId?: string | null;
}>) {
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const settingsProfileEnabledByIdRaw = useSetting('profileEnabledById');
    const settingsProfileEnabledById = React.useMemo(
        () => readProfileEnabledById(settingsProfileEnabledByIdRaw),
        [settingsProfileEnabledByIdRaw],
    );
    const lastUsedProfile = useAuthoringMemoryField('lastUsedProfile');
    const secretBindingsByProfileId = useSetting('currentSecretBindingsByProfileId');
    const providerSettingsV1 = useSetting('providerSettingsV1');
    const providerMigration = React.useMemo(() => (
        readProviderSettingsFromAccountSettingsV1({ providerSettingsV1 }).settings.migration
    ), [providerSettingsV1]);
    const profileEnabledById = params.profileEnabledById ?? settingsProfileEnabledById;

    const enabledAgentIds = React.useMemo(() => {
        return getEnabledAgentIds({ backendEnabledByTargetKey });
    }, [backendEnabledByTargetKey]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: params.machineId,
        serverId: params.serverId,
        enabled: Boolean(params.machineId),
        staleMs: 60_000,
    });
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1,
            backendEnabledByTargetKey,
            discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
        });
    }, [
        acpCatalogSettingsV1,
        backendEnabledByTargetKey,
        daemonMergedProjection.inputs?.discoveredBackendIds,
        daemonMergedProjection.inputs?.mergedBackendProjectionById,
        daemonMergedProjection.inputs?.mergedProviderProjectionById,
        enabledAgentIds,
    ]);
    const strings = React.useMemo(() => getDefaultProfileListStrings(enabledAgentIds), [enabledAgentIds]);

    const groups = React.useMemo(() => {
        const builtInProfiles = resolveVisibleBuiltInLaunchProfiles({
            lastUsedProfile,
            favoriteProfileIds: params.favoriteProfileIds,
            profileEnabledById: profileEnabledById ?? {},
            secretBindingsByProfileId: secretBindingsByProfileId ?? {},
            migration: providerMigration,
        });
        return buildProfilesListGroups({
            customProfiles: params.customProfiles,
            builtInProfiles,
            favoriteProfileIds: params.favoriteProfileIds,
            enabledAgentIds,
            profileEnabledById,
            includeDisabledProfiles: params.includeDisabledProfiles,
        });
    }, [enabledAgentIds, lastUsedProfile, profileEnabledById, params.customProfiles, params.favoriteProfileIds, params.includeDisabledProfiles, providerMigration, secretBindingsByProfileId]);

    const describeProfile = React.useCallback((profile: AIBackendProfile) => getProfileSubtitle({
        profile,
        enabledAgentIds,
        backendEntries: resolvedBackendEntries,
        strings,
    }), [enabledAgentIds, resolvedBackendEntries, strings]);

    return { groups, enabledAgentIds, resolvedBackendEntries, strings, profileEnabledById, describeProfile };
}
