import * as React from 'react';

import { buildNewSessionProfilesListProps } from '@/components/sessions/new/components/buildNewSessionProfilesListProps';
import { AgentInput } from '@/components/sessions/agentInput';
import { NewSessionProfilePopoverBrowserContent } from '@/components/sessions/new/components/NewSessionProfilePopoverBrowserContent';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

import type { NewSessionWizardProfilesProps } from './NewSessionWizard';

type Params = Readonly<{
    useProfiles: boolean;
    profilesProps: NewSessionWizardProfilesProps;
    serverId?: string | null;
    machineName?: string | null;
    popoverBoundaryRef: React.RefObject<any> | null;
}>;

type Result = Readonly<{
    sharedProfilesListProps: ReturnType<typeof buildNewSessionProfilesListProps>;
    profilePopover: React.ComponentProps<typeof AgentInput>['profilePopover'];
}>;

export function buildNewSessionProfileSelectionPopover(params: Params): Result {
    const handleProfileSecretBadgePress = (profile: AIBackendProfile) => {
        const satisfaction = params.profilesProps.getSecretSatisfactionForProfile(profile);
        const isMissingForSelectedProfile =
            profile.id === params.profilesProps.selectedProfileId && !satisfaction.isSatisfied;
        params.profilesProps.openSecretRequirementModal(profile, { revertOnCancel: isMissingForSelectedProfile });
    };

    const sharedProfilesListProps = buildNewSessionProfilesListProps({
        profiles: params.profilesProps.profiles,
        favoriteProfileIds: params.profilesProps.favoriteProfileIds,
        setFavoriteProfileIds: params.profilesProps.setFavoriteProfileIds,
        selectedProfileId: params.profilesProps.selectedProfileId,
        selectedMachineId: params.profilesProps.selectedMachineId,
        onPressDefaultEnvironment: params.profilesProps.onPressDefaultEnvironment,
        onPressProfile: params.profilesProps.onPressProfile,
        getProfileDisabled: params.profilesProps.getProfileDisabled,
        getProfileSubtitleExtra: params.profilesProps.getProfileSubtitleExtra,
        handleAddProfile: params.profilesProps.handleAddProfile,
        openProfileEdit: params.profilesProps.openProfileEdit,
        handleDuplicateProfile: params.profilesProps.handleDuplicateProfile,
        handleDeleteProfile: params.profilesProps.handleDeleteProfile,
        onViewEnvironmentVariables: () => {},
        onSecretBadgePress: handleProfileSecretBadgePress,
        profilesGroupTitles: params.profilesProps.profilesGroupTitles,
        getSecretOverrideReady: params.profilesProps.getSecretOverrideReady,
        getSecretMachineEnvOverride: params.profilesProps.getSecretMachineEnvOverride,
        popoverBoundaryRef: params.popoverBoundaryRef,
    });

    const profilePopover: React.ComponentProps<typeof AgentInput>['profilePopover'] = params.useProfiles
        ? {
            maxHeightCap: 560,
            maxWidthCap: 600,
            renderContent: ({ maxHeight, requestClose }) => (
                <NewSessionProfilePopoverBrowserContent
                    maxHeight={maxHeight}
                    profilesListProps={{
                        ...sharedProfilesListProps,
                        popoverBoundaryRef: params.popoverBoundaryRef,
                        onPressDefaultEnvironment: () => {
                            requestClose();
                            params.profilesProps.onPressDefaultEnvironment();
                        },
                        onPressProfile: (profile) => {
                            requestClose();
                            return params.profilesProps.onPressProfile(profile);
                        },
                        onAddProfilePress: () => {
                            requestClose();
                            params.profilesProps.handleAddProfile();
                        },
                        onEditProfile: (profile) => {
                            requestClose();
                            params.profilesProps.openProfileEdit({ profileId: profile.id });
                        },
                        onDuplicateProfile: (profile) => {
                            requestClose();
                            params.profilesProps.handleDuplicateProfile(profile);
                        },
                        onDeleteProfile: (profile) => {
                            requestClose();
                            params.profilesProps.handleDeleteProfile(profile);
                        },
                        onSecretBadgePress: (profile) => {
                            requestClose();
                            handleProfileSecretBadgePress(profile);
                        },
                    }}
                    machineId={params.profilesProps.selectedMachineId}
                    serverId={params.serverId}
                    machineName={params.machineName}
                />
            ),
        }
        : undefined;

    return {
        sharedProfilesListProps,
        profilePopover,
    };
}
