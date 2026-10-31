import * as React from 'react';
import { InteractionManager } from 'react-native';

import { type AgentId } from '@/agents/catalog/catalog';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import {
    readAccountPermissionDefaults,
    resolveNewSessionDefaultPermissionMode,
} from '@/sync/domains/permissions/permissionDefaults';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

type PersistedAuthoringDraftLike = Readonly<{
    permissionMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    permissionMode?: string | null;
}> | null | undefined;

export function useNewSessionPermissionModeState(params: Readonly<{
    agentType: AgentId;
    backendTarget: BackendTargetRefV1;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    enabledAgentIds: ReadonlyArray<AgentId>;
    sessionDefaultPermissionModeByTargetKey: Settings['sessionDefaultPermissionModeByTargetKey'];
}>): Readonly<{
    permissionMode: PermissionMode;
    handlePermissionModeChange: (mode: PermissionMode) => void;
}> {
    const accountDefaults = React.useMemo(() => {
        return readAccountPermissionDefaults(
            params.sessionDefaultPermissionModeByTargetKey,
            params.enabledAgentIds,
        );
    }, [params.enabledAgentIds, params.sessionDefaultPermissionModeByTargetKey]);

    const resolveDefaultPermissionMode = React.useCallback((profile: AIBackendProfile | null) => {
        return resolveNewSessionDefaultPermissionMode({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
        });
    }, [accountDefaults, params.agentType, params.backendTarget]);

    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(() => {
        if (isPermissionMode(params.hydratedTempAuthoringDraft?.permissionMode)) {
            return normalizePermissionModeForAgentType(params.hydratedTempAuthoringDraft.permissionMode, params.agentType);
        }

        const selectedProfile = params.selectedProfileId
            ? (params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId))
            : null;
        const draftPermissionMode = params.hydratedPersistedAuthoringDraft?.permissionMode;
        if (isPermissionMode(draftPermissionMode)) {
            return normalizePermissionModeForAgentType(draftPermissionMode, params.agentType);
        }

        return resolveDefaultPermissionMode(selectedProfile);
    });

    const hasUserSelectedPermissionModeRef = React.useRef<boolean>((() => {
        // Setup copies and automation edits carry an authored mode, including `default`.
        if (isPermissionMode(params.hydratedTempAuthoringDraft?.permissionMode)) return true;
        const draft = params.hydratedPersistedAuthoringDraft?.permissionMode;
        if (isPermissionMode(draft) && draft !== 'default') return true;
        return false;
    })());

    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        setPermissionMode((prev) => (prev === mode ? prev : mode));
        if (source === 'user') {
            hasUserSelectedPermissionModeRef.current = true;
        }
    }, []);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        applyPermissionMode(mode, 'user');
    }, [applyPermissionMode]);

    const selectedProfile = params.selectedProfileId
        ? params.profileMap.get(params.selectedProfileId) ?? getBuiltInProfile(params.selectedProfileId) ?? null
        : null;
    const currentDefaultsRef = React.useRef({ selectedProfile, resolveDefaultPermissionMode });
    React.useEffect(() => {
        currentDefaultsRef.current = { selectedProfile, resolveDefaultPermissionMode };
    }, [selectedProfile, resolveDefaultPermissionMode]);
    const targetKey = buildBackendTargetKey(params.backendTarget);
    const previousScopeRef = React.useRef({ profileId: params.selectedProfileId, targetKey });

    React.useEffect(() => {
        const previous = previousScopeRef.current;
        previousScopeRef.current = { profileId: params.selectedProfileId, targetKey };
        const backendChanged = previous.targetKey !== targetKey;
        const profileChanged = previous.profileId !== params.selectedProfileId;
        if (!backendChanged && !profileChanged) return;

        if (hasUserSelectedPermissionModeRef.current) {
            if (backendChanged) {
                applyPermissionMode(normalizePermissionModeForAgentType(permissionModeRef.current, params.agentType), 'auto');
            }
            return;
        }

        const applyCurrentDefault = () => {
            if (hasUserSelectedPermissionModeRef.current) return;
            const current = currentDefaultsRef.current;
            applyPermissionMode(current.resolveDefaultPermissionMode(current.selectedProfile), 'auto');
        };
        if (backendChanged) {
            applyCurrentDefault();
            return;
        }

        // Profile-only follow-up stays deferred. A backend/profile transition cancels it;
        // same-scope metadata refreshes use the latest canonical resolver when it runs.
        const task = InteractionManager.runAfterInteractions(applyCurrentDefault);
        return () => task.cancel();
    }, [applyPermissionMode, params.agentType, params.selectedProfileId, targetKey]);

    return {
        permissionMode,
        handlePermissionModeChange,
    };
}
