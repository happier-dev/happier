import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

export function useNewSessionProfileActions(params: Readonly<{
    hasUserTouchedProfileSelectionRef: React.MutableRefObject<boolean>;
    setSelectedProfileId: React.Dispatch<React.SetStateAction<string | null>>;
    profiles: AIBackendProfile[];
    selectedProfileId: string | null;
    setProfiles: (value: AIBackendProfile[]) => void;
}>): Readonly<{
    onPressDefaultEnvironment: () => void;
    handleDeleteProfile: (profile: AIBackendProfile) => void;
}> {
    const onPressDefaultEnvironment = React.useCallback(() => {
        params.hasUserTouchedProfileSelectionRef.current = true;
        params.setSelectedProfileId(null);
    }, [params.hasUserTouchedProfileSelectionRef, params.setSelectedProfileId]);

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        const updatedProfiles = params.profiles.filter((candidate: AIBackendProfile) => candidate.id !== profile.id);
                        params.setProfiles(updatedProfiles);
                        if (params.selectedProfileId === profile.id) {
                            params.setSelectedProfileId(null);
                        }
                    },
                },
            ],
        );
    }, [params.profiles, params.selectedProfileId, params.setProfiles, params.setSelectedProfileId]);

    return {
        onPressDefaultEnvironment,
        handleDeleteProfile,
    };
}
