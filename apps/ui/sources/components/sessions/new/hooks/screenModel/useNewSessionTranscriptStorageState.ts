import * as React from 'react';

import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { Settings } from '@/sync/domains/settings/settings';
import { readAccountTranscriptStorageDefaults, resolveNewSessionDefaultTranscriptStorage } from '@/sync/domains/session/transcriptStorageDefaults';
import {
    coerceNewSessionTranscriptStorage,
    supportsDirectTranscriptStorageForNewSession,
    type NewSessionTranscriptStorage,
} from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

type PersistedAuthoringDraftLike = Readonly<{
    transcriptStorage?: NewSessionTranscriptStorage | null;
    selectedProfileId?: string | null;
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
    resolvedBackendTargets: ReadonlyArray<PersistedBackendTargetRefV2>;
    agentType: string;
    /**
     * The machine the composer will spawn on. An installed Agent's transcript
     * storage declaration is a per-machine fact, so the control it drives is
     * read from the machine that will actually run the Session.
     */
    selectedMachineId: string | null;
    backendTarget: PersistedBackendTargetRefV2;
    settings: Settings;
    externalSessionsFeatureEnabled: boolean;
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

        const persistedSelectedProfileId = params.hydratedPersistedAuthoringDraft?.selectedProfileId ?? null;
        const profile = persistedSelectedProfileId
            ? (params.profileMap.get(persistedSelectedProfileId) || getBuiltInProfile(persistedSelectedProfileId))
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
            machineId: params.selectedMachineId,
            settings: params.settings,
            externalSessionsEnabled: params.externalSessionsFeatureEnabled,
        });
    });

    const supportsDirectTranscriptStorage = React.useMemo(() => {
        return supportsDirectTranscriptStorageForNewSession({
            agentId: params.agentType,
            machineId: params.selectedMachineId,
            settings: params.settings,
        });
    }, [params.agentType, params.selectedMachineId, params.settings]);

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
            machineId: params.selectedMachineId,
            settings: params.settings,
            externalSessionsEnabled: params.externalSessionsFeatureEnabled,
        });
        if (coerced !== transcriptStorage) {
            setTranscriptStorage(coerced);
        }
    }, [
        accountTranscriptStorageDefaults,
        params.agentType,
        params.backendTarget,
        params.externalSessionsFeatureEnabled,
        params.selectedMachineId,
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
