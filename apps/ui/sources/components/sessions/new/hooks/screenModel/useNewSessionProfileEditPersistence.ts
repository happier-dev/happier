import * as React from 'react';
import { InteractionManager } from 'react-native';

import { useIsFocused } from '@react-navigation/native';
import type { Href, Router } from 'expo-router';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import {
    useNewSessionDraftAutoPersist,
    type NewSessionDraftTextSource,
} from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';

export function useNewSessionProfileEditPersistence(params: Readonly<{
    router: Router;
    draftId: string;
    selectedMachineId: string | null;
    buildCurrentPersistedDraft: () => NewSessionDraft;
    stageDraftIfEnabled: (draft: NewSessionDraft) => void;
    persistDraftIfEnabled: (draft: NewSessionDraft) => void;
    draftPersistenceEnabled: boolean;
    draftPersistenceGenerationRef: React.MutableRefObject<number>;
    draftText?: NewSessionDraftTextSource;
    draftChangeKey: string;
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
                draftId: params.draftId,
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
        params.draftId,
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
    const stageDraftNow = React.useCallback(() => {
        params.stageDraftIfEnabled(params.buildCurrentPersistedDraft());
    }, [params.buildCurrentPersistedDraft, params.stageDraftIfEnabled]);

    // Only the focused new-session screen instance may auto-persist the shared scoped
    // draft: an unfocused instance (stacked /new modal, screen behind a picker) holds a
    // stale prompt and persisting it would clobber the focused instance's live typing.
    const isFocused = useIsFocused();

    useNewSessionDraftAutoPersist({
        stageDraftNow,
        persistDraftNow,
        persistenceEnabled: params.draftPersistenceEnabled,
        draftText: params.draftText,
        draftChangeKey: params.draftChangeKey,
        persistOnMount: false,
        focused: isFocused,
    });

    return {
        openProfileEdit,
        handleAddProfile,
        handleDuplicateProfile,
    };
}
