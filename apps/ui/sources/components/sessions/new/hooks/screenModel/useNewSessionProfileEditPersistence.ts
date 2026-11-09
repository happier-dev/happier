import * as React from 'react';

import type { Href, Router } from 'expo-router';

import { buildBackendTargetRouteParams, type SerializedBackendTargetRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import {
    useNewSessionDraftAutoPersist,
    type NewSessionDraftTextSource,
} from '@/components/sessions/new/hooks/useNewSessionDraftAutoPersist';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { useNewSessionHostFocused } from '@/components/sessions/new/navigation/newSessionHost';

export function useNewSessionProfileEditPersistence(params: Readonly<{
    router: Router;
    draftId: string;
    selectedMachineId: string | null;
    backendTargetRouteParams: SerializedBackendTargetRouteParams;
    buildCurrentPersistedDraft: () => NewSessionDraft;
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
        const draftBackendTargetRouteParams = buildBackendTargetRouteParams({
            agentType: draft.agentType,
            backendTarget: draft.agentTarget,
            backendTargetKey: undefined,
            fallbackTarget: draft.agentTarget ?? null,
        });

        params.router.push({
            pathname: '/new/pick/profile-edit',
            params: {
                ...next,
                draftId: params.draftId,
                ...params.backendTargetRouteParams,
                ...draftBackendTargetRouteParams,
                ...(params.selectedMachineId ? { machineId: params.selectedMachineId } : {}),
            },
        } as Href);

        // Timeout fallback keeps the draft persisting even when interactions
        // never settle; the generation check keeps late runs harmless.
        runAfterInteractionsWithFallback(() => {
            if (persistenceGeneration !== params.draftPersistenceGenerationRef.current) {
                return;
            }

            params.persistDraftIfEnabled(draft);
        });
    }, [
        params.buildCurrentPersistedDraft,
        params.draftPersistenceGenerationRef,
        params.backendTargetRouteParams,
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

    // The host owns draft activity: a docked composer stays active across navigation,
    // while an unfocused route instance must not overwrite the live draft.
    const isFocused = useNewSessionHostFocused();

    useNewSessionDraftAutoPersist({
        persistDraftNow,
        persistenceEnabled: params.draftPersistenceEnabled,
        draftText: params.draftText,
        draftChangeKey: params.draftChangeKey,
        focused: isFocused,
    });

    return {
        openProfileEdit,
        handleAddProfile,
        handleDuplicateProfile,
    };
}
