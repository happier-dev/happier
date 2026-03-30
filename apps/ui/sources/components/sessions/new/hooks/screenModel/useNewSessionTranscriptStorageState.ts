import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { Settings } from '@/sync/domains/settings/settings';
import { readAccountTranscriptStorageDefaults, resolveNewSessionDefaultTranscriptStorage } from '@/sync/domains/session/transcriptStorageDefaults';
import {
    coerceNewSessionTranscriptStorage,
    supportsDirectTranscriptStorageForNewSession,
    type NewSessionTranscriptStorage,
} from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

type PersistedAuthoringDraftLike = Readonly<{
    transcriptStorage?: NewSessionTranscriptStorage | null;
    profileId?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    transcriptStorage?: NewSessionTranscriptStorage | null;
}> | null | undefined;

type ProfileDefaultsLike = Readonly<{
    defaultPersistenceModeByTargetKey?: Readonly<Record<string, NewSessionTranscriptStorage>> | null;
}> | null;

export function useNewSessionTranscriptStorageState(params: Readonly<{
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    profileMap: ReadonlyMap<string, ProfileDefaultsLike>;
    selectedProfileId: string | null;
    newSessionDefaultPersistenceModeV1: Settings['newSessionDefaultPersistenceModeV1'];
    newSessionDefaultPersistenceModeByTargetKeyV1: Settings['newSessionDefaultPersistenceModeByTargetKeyV1'];
    resolvedBackendTargets: ReadonlyArray<BackendTargetRefV1>;
    agentType: AgentId;
    backendTarget: BackendTargetRefV1;
    settings: Settings;
    directSessionsFeatureEnabled: boolean;
}>): Readonly<{
    transcriptStorage: NewSessionTranscriptStorage;
    setTranscriptStorage: React.Dispatch<React.SetStateAction<NewSessionTranscriptStorage>>;
    supportsDirectTranscriptStorage: boolean;
    hasUserSelectedTranscriptStorageRef: React.MutableRefObject<boolean>;
}> {
    const [transcriptStorage, setTranscriptStorage] = React.useState<NewSessionTranscriptStorage>(() => {
        const tempTranscriptStorage = params.hydratedTempAuthoringDraft?.transcriptStorage;
        if (tempTranscriptStorage === 'direct' || tempTranscriptStorage === 'persisted') {
            return tempTranscriptStorage;
        }

        const profile = params.hydratedPersistedAuthoringDraft?.profileId
            ? (params.profileMap.get(params.hydratedPersistedAuthoringDraft.profileId) || getBuiltInProfile(params.hydratedPersistedAuthoringDraft.profileId))
            : null;
        const accountDefaults = readAccountTranscriptStorageDefaults({
            globalDefault: params.newSessionDefaultPersistenceModeV1,
            byTargetKey: params.newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: params.resolvedBackendTargets,
        });
        const resolvedDefault = resolveNewSessionDefaultTranscriptStorage({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPersistenceModeByTargetKey ?? null,
        });
        return coerceNewSessionTranscriptStorage({
            requested: params.hydratedPersistedAuthoringDraft?.transcriptStorage ?? resolvedDefault,
            agentId: params.agentType,
            settings: params.settings,
            directSessionsEnabled: params.directSessionsFeatureEnabled,
        });
    });

    const supportsDirectTranscriptStorage = React.useMemo(() => {
        return supportsDirectTranscriptStorageForNewSession({
            agentId: params.agentType,
            settings: params.settings,
        });
    }, [params.agentType, params.settings]);

    const accountTranscriptStorageDefaults = React.useMemo(() => {
        return readAccountTranscriptStorageDefaults({
            globalDefault: params.newSessionDefaultPersistenceModeV1,
            byTargetKey: params.newSessionDefaultPersistenceModeByTargetKeyV1,
            enabledBackendTargets: params.resolvedBackendTargets,
        });
    }, [
        params.newSessionDefaultPersistenceModeByTargetKeyV1,
        params.newSessionDefaultPersistenceModeV1,
        params.resolvedBackendTargets,
    ]);

    const selectedProfileForTranscriptStorage = React.useMemo(() => {
        if (!params.selectedProfileId) return null;
        return params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId) || null;
    }, [params.profileMap, params.selectedProfileId]);

    const selectedProfileTranscriptStorageDefaultsByTargetKey = selectedProfileForTranscriptStorage?.defaultPersistenceModeByTargetKey ?? null;

    const hasUserSelectedTranscriptStorageRef = React.useRef<boolean>(
        params.hydratedPersistedAuthoringDraft?.transcriptStorage === 'direct'
            || params.hydratedPersistedAuthoringDraft?.transcriptStorage === 'persisted',
    );

    React.useEffect(() => {
        const resolvedDefault = resolveNewSessionDefaultTranscriptStorage({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            accountDefaults: accountTranscriptStorageDefaults,
            profileDefaultsByTargetKey: selectedProfileTranscriptStorageDefaultsByTargetKey,
        });
        const requested = hasUserSelectedTranscriptStorageRef.current
            ? transcriptStorage
            : resolvedDefault;
        const coerced = coerceNewSessionTranscriptStorage({
            requested,
            agentId: params.agentType,
            settings: params.settings,
            directSessionsEnabled: params.directSessionsFeatureEnabled,
        });
        if (coerced !== transcriptStorage) {
            setTranscriptStorage(coerced);
        }
    }, [
        accountTranscriptStorageDefaults,
        params.agentType,
        params.backendTarget,
        params.directSessionsFeatureEnabled,
        params.settings,
        selectedProfileTranscriptStorageDefaultsByTargetKey,
        transcriptStorage,
    ]);

    return {
        transcriptStorage,
        setTranscriptStorage,
        supportsDirectTranscriptStorage,
        hasUserSelectedTranscriptStorageRef,
    };
}
