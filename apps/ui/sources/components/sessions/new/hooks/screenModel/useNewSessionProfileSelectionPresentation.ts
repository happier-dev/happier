import * as React from 'react';

import { getAgentCore, isBundledAgentId, resolveAgentIdFromCliDetectKey } from '@/agents/catalog/catalog';
import { consumeProfileIdParam } from '@/profileRouteParams';
import { t } from '@/text';

type ProfileAvailability = Readonly<{ available: boolean; reason?: string }>;

export function useNewSessionProfileSelectionPresentation(params: Readonly<{
    useProfiles: boolean;
    profileIdParam?: string | string[];
    selectedProfileId: string | null;
    setSelectedProfileId: React.Dispatch<React.SetStateAction<string | null>>;
    selectProfile: (profileId: string) => void;
    canSelectProfile: (profileId: string) => boolean;
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
        return !params.canSelectProfile(profile.id);
    }, [params.canSelectProfile]);

    const getProfileSubtitleExtra = React.useCallback((profile: { id: string }) => {
        const availability = params.profileAvailabilityById.get(profile.id) ?? { available: true };
        if (availability.available || !availability.reason) return null;
        if (availability.reason.startsWith('requires-agent:')) {
            const required = availability.reason.split(':')[1];
            const agentLabel = isBundledAgentId(required) ? t(getAgentCore(required).displayNameKey) : required;
            return t('newSession.profileAvailability.requiresAgent', { agent: agentLabel });
        }
        if (availability.reason.startsWith('logged-out:')) {
            return t('profiles.machineLogin.status.notLoggedIn');
        }
        if (availability.reason.startsWith('cli-not-detected:')) {
            const cli = availability.reason.split(':')[1];
            const agentFromCli = resolveAgentIdFromCliDetectKey(cli);
            const displayNameKey = getAgentCore(agentFromCli ?? '')?.displayNameKey;
            const cliLabel = displayNameKey ? t(displayNameKey) : cli;
            return t('newSession.profileAvailability.cliNotDetected', { cli: cliLabel });
        }
        return availability.reason;
    }, [params.profileAvailabilityById]);

    const onPressProfile = React.useCallback((profile: { id: string }) => {
        if (!params.canSelectProfile(profile.id)) return;
        params.selectProfile(profile.id);
    }, [params.canSelectProfile, params.selectProfile]);

    React.useEffect(() => {
        if (!params.useProfiles) {
            return;
        }

        const { nextSelectedProfileId, shouldClearParam } = consumeProfileIdParam({
            profileIdParam: params.profileIdParam,
            selectedProfileId: params.selectedProfileId,
        });
        const rejectedProfileIdParam = typeof nextSelectedProfileId === 'string' && !params.canSelectProfile(nextSelectedProfileId);

        if (nextSelectedProfileId === null) {
            if (params.selectedProfileId !== null) {
                params.setSelectedProfileId(null);
            }
        } else if (typeof nextSelectedProfileId === 'string' && !rejectedProfileIdParam) {
            params.selectProfile(nextSelectedProfileId);
        }

        if (shouldClearParam || rejectedProfileIdParam) {
            params.clearProfileRouteParam();
        }
    }, [
        params.canSelectProfile,
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
