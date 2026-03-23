import * as React from 'react';

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
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

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
    hasUserSelectedPermissionModeRef: React.MutableRefObject<boolean>;
    permissionModeRef: React.MutableRefObject<PermissionMode>;
    applyPermissionMode: (mode: PermissionMode, source: 'user' | 'auto') => void;
    handlePermissionModeChange: (mode: PermissionMode) => void;
    resolveDefaultPermissionMode: (profile: AIBackendProfile | null) => PermissionMode;
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

    return {
        permissionMode,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        handlePermissionModeChange,
        resolveDefaultPermissionMode,
    };
}
