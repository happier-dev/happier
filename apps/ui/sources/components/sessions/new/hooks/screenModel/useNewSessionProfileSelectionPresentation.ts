import * as React from 'react';

import { getAgentCore, isAgentId, resolveAgentIdFromCliDetectKey } from '@/agents/catalog/catalog';
import { consumeProfileIdParam } from '@/profileRouteParams';
import { t } from '@/text';

type ProfileAvailability = Readonly<{ available: boolean; reason?: string }>;

export function useNewSessionProfileSelectionPresentation(params: Readonly<{
    useProfiles: boolean;
    profileIdParam?: string | string[];
    selectedProfileId: string | null;
    setSelectedProfileId: React.Dispatch<React.SetStateAction<string | null>>;
    selectProfile: (profileId: string) => void;
    profileAvailabilityById: ReadonlyMap<string, ProfileAvailability>;
    clearProfileRouteParam: () => void;
}>): Readonly<{
    profilesGroupTitles: Readonly<{ favorites: string; custom: string; builtIn: string }>;
    getProfileDisabled: (profile: { id: string }) => boolean;
    getProfileSubtitleExtra: (profile: { id: string }) => string | null;
    onPressProfile: (profile: { id: string }) => void;
}> {
    const profilesGroupTitles = React.useMemo(() => {
        return {
            favorites: t('profiles.groups.favorites'),
            custom: t('profiles.groups.custom'),
            builtIn: t('profiles.groups.builtIn'),
        };
    }, []);

    const getProfileDisabled = React.useCallback((profile: { id: string }) => {
        return !(params.profileAvailabilityById.get(profile.id) ?? { available: true }).available;
    }, [params.profileAvailabilityById]);

    const getProfileSubtitleExtra = React.useCallback((profile: { id: string }) => {
        const availability = params.profileAvailabilityById.get(profile.id) ?? { available: true };
        if (availability.available || !availability.reason) return null;
        if (availability.reason.startsWith('requires-agent:')) {
            const required = availability.reason.split(':')[1];
            const agentLabel = isAgentId(required) ? t(getAgentCore(required).displayNameKey) : required;
            return t('newSession.profileAvailability.requiresAgent', { agent: agentLabel });
        }
        if (availability.reason.startsWith('logged-out:')) {
            return t('profiles.machineLogin.status.notLoggedIn');
        }
        if (availability.reason.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const agentFromCli = resolveAgentIdFromCliDetectKey(cli);
            const cliLabel = agentFromCli ? t(getAgentCore(agentFromCli).displayNameKey) : cli;
            return t('newSession.profileAvailability.cliNotDetected', { cli: cliLabel });
        }
        return availability.reason;
    }, [params.profileAvailabilityById]);

    const onPressProfile = React.useCallback((profile: { id: string }) => {
        const availability = params.profileAvailabilityById.get(profile.id) ?? { available: true };
        if (!availability.available) return;
        params.selectProfile(profile.id);
    }, [params.profileAvailabilityById, params.selectProfile]);

    React.useEffect(() => {
        if (!params.useProfiles) {
            return;
        }

        const { nextSelectedProfileId, shouldClearParam } = consumeProfileIdParam({
            profileIdParam: params.profileIdParam,
            selectedProfileId: params.selectedProfileId,
        });

        if (nextSelectedProfileId === null) {
            if (params.selectedProfileId !== null) {
                params.setSelectedProfileId(null);
            }
        } else if (typeof nextSelectedProfileId === 'string') {
            params.selectProfile(nextSelectedProfileId);
        }

        if (shouldClearParam) {
            params.clearProfileRouteParam();
        }
    }, [
        params.clearProfileRouteParam,
        params.profileIdParam,
        params.selectProfile,
        params.selectedProfileId,
        params.setSelectedProfileId,
        params.useProfiles,
    ]);

    return {
        profilesGroupTitles,
        getProfileDisabled,
        getProfileSubtitleExtra,
        onPressProfile,
    };
}
