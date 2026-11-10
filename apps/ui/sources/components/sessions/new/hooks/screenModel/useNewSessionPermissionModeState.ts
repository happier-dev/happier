import * as React from 'react';
import type { AgentSessionModeDescriptor } from '@happier-dev/agents';

import { type AgentId } from '@/agents/catalog/catalog';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import {
    readAccountPermissionDefaults,
    resolveNewSessionDefaultPermissionMode,
    resolveNewSessionDefaultPermissionModeDecision,
} from '@/sync/domains/permissions/permissionDefaults';
import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
import type { OrganizationPolicyLock } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

type PersistedAuthoringDraftLike = Readonly<{
    permissionMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    permissionMode?: string | null;
}> | null | undefined;

export function useNewSessionPermissionModeState(params: Readonly<{
    agentType: string;
    sessionModeDescriptor?: AgentSessionModeDescriptor | null;
    backendTarget: PersistedBackendTargetRefV2;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    persistedPermissionModeExplicit?: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    enabledAgentIds: ReadonlyArray<AgentId>;
    sessionDefaultPermissionModeByTargetKey: Settings['sessionDefaultPermissionModeByTargetKey'];
    managedDefaults?: ManagedSessionDefaultsContext;
}>): Readonly<{
    permissionMode: PermissionMode;
    permissionModeForPersistence: PermissionMode;
    permissionModeExplicit: boolean;
    permissionModeLock: OrganizationPolicyLock | null;
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
            sessionModeDescriptor: params.sessionModeDescriptor,
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
            managedDefaults: params.managedDefaults,
        });
    }, [accountDefaults, params.agentType, params.backendTarget, params.managedDefaults, params.sessionModeDescriptor]);

    // Draft hydration can finish after mount. Store only a choice made in this
    // editor; until then the hydrated draft remains the source of intent.
    const [authoredPermissionMode, setAuthoredPermissionMode] = React.useState<PermissionMode | null>(null);
    const tempPermissionMode = params.hydratedTempAuthoringDraft?.permissionMode;
    const persistedPermissionMode = params.hydratedPersistedAuthoringDraft?.permissionMode;
    const draftPermissionMode = isPermissionMode(tempPermissionMode)
        ? tempPermissionMode
        : isPermissionMode(persistedPermissionMode) && (persistedPermissionMode !== 'default'
            || params.persistedPermissionModeExplicit === true)
            ? persistedPermissionMode : undefined;
    const explicitPermissionMode = authoredPermissionMode ?? draftPermissionMode;
    const hasUserSelectedPermissionModeRef = React.useRef(explicitPermissionMode !== undefined);
    hasUserSelectedPermissionModeRef.current = explicitPermissionMode !== undefined;

    const selectedProfile = params.selectedProfileId
        ? (params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId))
        : null;
    const resolvePermissionModeDecision = React.useCallback((explicitPermissionMode?: PermissionMode) => {
        return resolveNewSessionDefaultPermissionModeDecision({
            agentType: params.agentType,
            sessionModeDescriptor: params.sessionModeDescriptor,
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: selectedProfile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: selectedProfile?.defaultPermissionMode as PermissionMode | undefined,
            managedDefaults: params.managedDefaults,
            explicitPermissionMode,
        });
    }, [accountDefaults, params.agentType, params.backendTarget, params.managedDefaults, params.sessionModeDescriptor, selectedProfile]);
    const decision = resolvePermissionModeDecision(explicitPermissionMode);
    const permissionMode = decision.permissionMode;

    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        const next = resolvePermissionModeDecision(mode);
        if (next.lock) return;
        if (source === 'user' || hasUserSelectedPermissionModeRef.current) {
            hasUserSelectedPermissionModeRef.current = true;
            setAuthoredPermissionMode(next.permissionMode);
        }
    }, [resolvePermissionModeDecision]);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        applyPermissionMode(mode, 'user');
    }, [applyPermissionMode]);

    return {
        permissionMode,
        permissionModeForPersistence: explicitPermissionMode ?? 'default',
        permissionModeExplicit: explicitPermissionMode !== undefined,
        permissionModeLock: decision.lock,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        handlePermissionModeChange,
        resolveDefaultPermissionMode,
    };
}
