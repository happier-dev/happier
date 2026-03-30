import * as React from 'react';
import { InteractionManager } from 'react-native';

import type { Href, Router } from 'expo-router';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { useNewSessionDraftAutoPersist } from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';

export function useNewSessionProfileEditPersistence(params: Readonly<{
    router: Router;
    selectedMachineId: string | null;
    buildCurrentPersistedDraft: () => NewSessionDraft;
    persistDraftIfEnabled: (draft: NewSessionDraft) => void;
    draftPersistenceEnabled: boolean;
    draftPersistenceGenerationRef: React.MutableRefObject<number>;
}>): Readonly<{
    openProfileEdit: (args: Readonly<{ profileId?: string; cloneFromProfileId?: string }>) => void;
    handleAddProfile: () => void;
    handleDuplicateProfile: (profile: AIBackendProfile) => void;
}> {
    const openProfileEdit = React.useCallback((next: Readonly<{ profileId?: string; cloneFromProfileId?: string }>) => {
        const draft = params.buildCurrentPersistedDraft();
        const persistenceGeneration = params.draftPersistenceGenerationRef.current;

        params.router.push({
            pathname: '/new/pick/profile-edit',
            params: {
                ...next,
                ...(params.selectedMachineId ? { machineId: params.selectedMachineId } : {}),
            },
        } as Href);

        InteractionManager.runAfterInteractions(() => {
            if (persistenceGeneration !== params.draftPersistenceGenerationRef.current) {
                return;
            }

            params.persistDraftIfEnabled(draft);
        });
    }, [
        params.buildCurrentPersistedDraft,
        params.draftPersistenceGenerationRef,
        params.persistDraftIfEnabled,
        params.router,
        params.selectedMachineId,
    ]);

    const handleAddProfile = React.useCallback(() => {
        openProfileEdit({});
    }, [openProfileEdit]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        openProfileEdit({ cloneFromProfileId: profile.id });
    }, [openProfileEdit]);

    const persistDraftNow = React.useCallback(() => {
        params.persistDraftIfEnabled(params.buildCurrentPersistedDraft());
    }, [params.buildCurrentPersistedDraft, params.persistDraftIfEnabled]);

    useNewSessionDraftAutoPersist({
        persistDraftNow,
        persistenceEnabled: params.draftPersistenceEnabled,
    });

    return {
        openProfileEdit,
        handleAddProfile,
        handleDuplicateProfile,
    };
}
