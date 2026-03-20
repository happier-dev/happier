import * as React from 'react';

import { ProfilesList } from '@/components/profiles/ProfilesList';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

type BuildNewSessionProfilesListPropsParams = Readonly<{
    profiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    setFavoriteProfileIds: (ids: string[]) => void;
    selectedProfileId: string | null;
    selectedMachineId: string | null;
    onPressDefaultEnvironment: () => void;
    onPressProfile: (profile: AIBackendProfile) => void | Promise<void>;
    getProfileDisabled: (profile: AIBackendProfile) => boolean;
    getProfileSubtitleExtra: (profile: AIBackendProfile) => string | null;
    handleAddProfile: () => void;
    openProfileEdit: (params: { profileId: string }) => void;
    handleDuplicateProfile: (profile: AIBackendProfile) => void;
    handleDeleteProfile: (profile: AIBackendProfile) => void;
    onViewEnvironmentVariables: (profile: AIBackendProfile) => void;
    onSecretBadgePress: (profile: AIBackendProfile) => void;
    profilesGroupTitles: { favorites: string; custom: string; builtIn: string };
    getSecretOverrideReady: (profile: AIBackendProfile) => boolean;
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
    popoverBoundaryRef: React.RefObject<any> | null;
}>;

export function buildNewSessionProfilesListProps(
    params: BuildNewSessionProfilesListPropsParams,
): React.ComponentProps<typeof ProfilesList> {
    return {
        customProfiles: params.profiles,
        favoriteProfileIds: params.favoriteProfileIds,
        onFavoriteProfileIdsChange: params.setFavoriteProfileIds,
        selectedProfileId: params.selectedProfileId,
        popoverBoundaryRef: params.popoverBoundaryRef,
        includeDefaultEnvironmentRow: true,
        onPressDefaultEnvironment: params.onPressDefaultEnvironment,
        onPressProfile: params.onPressProfile,
        machineId: params.selectedMachineId,
        getSecretOverrideReady: params.getSecretOverrideReady,
        getSecretMachineEnvOverride: params.getSecretMachineEnvOverride,
        getProfileDisabled: params.getProfileDisabled,
        getProfileSubtitleExtra: params.getProfileSubtitleExtra,
        includeAddProfileRow: true,
        onAddProfilePress: params.handleAddProfile,
        onEditProfile: (profile) => {
            params.openProfileEdit({ profileId: profile.id });
        },
        onDuplicateProfile: params.handleDuplicateProfile,
        onDeleteProfile: params.handleDeleteProfile,
        getHasEnvironmentVariables: (profile) => Object.keys(getProfileEnvironmentVariables(profile)).length > 0,
        onViewEnvironmentVariables: params.onViewEnvironmentVariables,
        onSecretBadgePress: params.onSecretBadgePress,
        groupTitles: params.profilesGroupTitles,
    };
}
