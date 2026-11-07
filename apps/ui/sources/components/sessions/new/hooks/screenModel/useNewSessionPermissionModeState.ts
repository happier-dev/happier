import * as React from 'react';

import { type AgentId } from '@/agents/catalog/catalog';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import {
    readAccountPermissionDefaults,
    resolveNewSessionDefaultPermissionMode,
    resolveNewSessionDefaultPermissionModeDecision,
} from '@/sync/domains/permissions/permissionDefaults';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
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
    backendTarget: PersistedBackendTargetRefV2;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    enabledAgentIds: ReadonlyArray<AgentId>;
    sessionDefaultPermissionModeByTargetKey: Settings['sessionDefaultPermissionModeByTargetKey'];
    managedDefaults?: ManagedSessionDefaultsContext;
}>): Readonly<{
    permissionMode: PermissionMode;
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
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: profile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: (profile?.defaultPermissionMode as PermissionMode | undefined) ?? undefined,
            managedDefaults: params.managedDefaults,
        });
    }, [accountDefaults, params.agentType, params.backendTarget, params.managedDefaults]);

    const [permissionSelection, setPermissionSelection] = React.useState<Readonly<{ mode: PermissionMode; explicit: boolean }>>(() => {
        if (isPermissionMode(params.hydratedTempAuthoringDraft?.permissionMode)) {
            return { mode: normalizePermissionModeForAgentType(params.hydratedTempAuthoringDraft.permissionMode, params.agentType), explicit: true };
        }

        const selectedProfile = params.selectedProfileId
            ? (params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId))
            : null;
        const draftPermissionMode = params.hydratedPersistedAuthoringDraft?.permissionMode;
        if (isPermissionMode(draftPermissionMode)) {
            return { mode: normalizePermissionModeForAgentType(draftPermissionMode, params.agentType), explicit: draftPermissionMode !== 'default' };
        }

        return { mode: resolveDefaultPermissionMode(selectedProfile), explicit: false };
    });

    const hasUserSelectedPermissionModeRef = React.useRef(permissionSelection.explicit);

    const selectedProfile = params.selectedProfileId
        ? (params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId))
        : null;
    const resolvePermissionModeDecision = React.useCallback((explicitPermissionMode?: PermissionMode) => {
        return resolveNewSessionDefaultPermissionModeDecision({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            accountDefaults,
            profileDefaultsByTargetKey: selectedProfile?.defaultPermissionModeByTargetKey ?? null,
            legacyProfileDefaultPermissionMode: selectedProfile?.defaultPermissionMode as PermissionMode | undefined,
            managedDefaults: params.managedDefaults,
            explicitPermissionMode,
        });
    }, [accountDefaults, params.agentType, params.backendTarget, params.managedDefaults, selectedProfile]);
    const decision = resolvePermissionModeDecision(
        permissionSelection.explicit ? permissionSelection.mode : undefined,
    );
    const permissionMode = decision.permissionMode;

    const permissionModeRef = React.useRef(permissionMode);
    React.useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);

    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        const next = resolvePermissionModeDecision(mode);
        if (next.lock) return;
        if (source === 'user') {
            hasUserSelectedPermissionModeRef.current = true;
        }
        setPermissionSelection((prev) => {
            const explicit = prev.explicit || source === 'user';
            return prev.mode === next.permissionMode && prev.explicit === explicit
                ? prev
                : { mode: next.permissionMode, explicit };
        });
    }, [resolvePermissionModeDecision]);

    const handlePermissionModeChange = React.useCallback((mode: PermissionMode) => {
        applyPermissionMode(mode, 'user');
    }, [applyPermissionMode]);

    return {
        permissionMode,
        permissionModeLock: decision.lock,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        handlePermissionModeChange,
        resolveDefaultPermissionMode,
    };
}
