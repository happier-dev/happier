import * as React from 'react';
import { type PersistedBackendTargetRefV2, type SessionModelSelectionV1 } from '@happier-dev/protocol';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import {
    isBackendEntrySelectableForNewSession,
    resolveNextSelectableBackendEntryForNewSession,
    type NewSessionSelectableBackendEntry,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import { normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

export function useNewSessionProfileBackendReconciliation(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    setSelectedProfileId: React.Dispatch<React.SetStateAction<string | null>>;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly NewSessionSelectableBackendEntry[];
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    machineAgentsById: Readonly<Record<string, MachineAgent | undefined>>;
    hasUserSelectedPermissionModeRef: React.MutableRefObject<boolean>;
    permissionModeRef: React.MutableRefObject<PermissionMode>;
    applyPermissionMode: (mode: PermissionMode, source: 'user' | 'auto') => void;
    resolveDefaultPermissionMode: (profile: AIBackendProfile | null) => PermissionMode;
    prepareSecretPromptForProfileSelection: (prevProfileId: string | null) => void;
    agentType: string;
    resolveProfileAuthoringIntent?: (profileId: string) => Readonly<{
        preferredAgentTargetKey: string | null;
        modelSelection: SessionModelSelectionV1 | null;
    }>;
    setModelSelectionForBackendTarget?: (backendTargetKey: string, selection: SessionModelSelectionV1 | null) => void;
}>): Readonly<{
    selectProfile: (profileId: string) => void;
}> {
    const pendingProfileSelectionRef = React.useRef<{
        profileId: string;
        prevProfileId: string | null;
        requestId: number;
    } | null>(null);
    const latestSelectionRequestIdRef = React.useRef(0);
    const latestSelectedProfileIdRef = React.useRef(params.selectedProfileId);
    latestSelectedProfileIdRef.current = params.selectedProfileId;

    const resolveNextCompatibleBackendEntry = React.useCallback((
        compatibleBackendEntries: readonly NewSessionSelectableBackendEntry[],
    ) => resolveNextSelectableBackendEntryForNewSession({
        candidateBackendEntries: compatibleBackendEntries,
        currentTargetKey: params.selectedBackendTargetKey,
        machineAgentsById: params.machineAgentsById,
    }), [
        params.machineAgentsById,
        params.selectedBackendTargetKey,
    ]);

    const isCurrentCompatibleBackendSelectable = React.useCallback((
        compatibleBackendEntries: readonly NewSessionSelectableBackendEntry[],
    ) => {
        const currentEntry = compatibleBackendEntries.find((entry) => entry.backendTargetKey === params.selectedBackendTargetKey) ?? null;
        if (!currentEntry) {
            return false;
        }

        return isBackendEntrySelectableForNewSession({
            entry: currentEntry,
            machineAgentsById: params.machineAgentsById,
        });
    }, [
        params.machineAgentsById,
        params.selectedBackendTargetKey,
    ]);

    const selectProfile = React.useCallback((profileId: string) => {
        params.prepareSecretPromptForProfileSelection(params.selectedProfileId);
        const prevSelectedProfileId = params.selectedProfileId;
        const requestId = latestSelectionRequestIdRef.current + 1;
        latestSelectionRequestIdRef.current = requestId;
        pendingProfileSelectionRef.current = profileId === prevSelectedProfileId
            ? null : { profileId, prevProfileId: prevSelectedProfileId, requestId };
        const profile = params.profileMap.get(profileId) || getBuiltInProfile(profileId);
        const authoringIntent = params.resolveProfileAuthoringIntent?.(profileId) ?? null;
        if (profile && authoringIntent?.preferredAgentTargetKey) {
            const preferredEntry = params.getCompatibleProfileBackendEntries(profile)
                .find((entry) => entry.backendTargetKey === authoringIntent.preferredAgentTargetKey) ?? null;
            if (preferredEntry && isBackendEntrySelectableForNewSession({
                entry: preferredEntry,
                machineAgentsById: params.machineAgentsById,
            })) {
                params.setBackendTarget(preferredEntry.backendTarget);
            }
        }
        if (authoringIntent?.modelSelection) {
            params.setModelSelectionForBackendTarget?.(
                authoringIntent.modelSelection.ref.agentTargetKey,
                authoringIntent.modelSelection,
            );
        }
        params.setSelectedProfileId(profileId);
    }, [
        params.machineAgentsById,
        params.getCompatibleProfileBackendEntries,
        params.prepareSecretPromptForProfileSelection,
        params.profileMap,
        params.resolveProfileAuthoringIntent,
        params.selectedProfileId,
        params.setBackendTarget,
        params.setModelSelectionForBackendTarget,
        params.setSelectedProfileId,
    ]);

    React.useEffect(() => {
        if (!params.selectedProfileId) return;
        const pending = pendingProfileSelectionRef.current;
        if (!pending || pending.profileId !== params.selectedProfileId) return;
        pendingProfileSelectionRef.current = null;

        // Timeout fallback keeps the reconciliation running when interactions
        // never settle; the request-id/profile-id guards keep late runs safe.
        const cancelReconciliation = runAfterInteractionsWithFallback(() => {
            if (latestSelectionRequestIdRef.current !== pending.requestId) return;
            if (latestSelectedProfileIdRef.current !== pending.profileId) return;

            const profile = params.profileMap.get(pending.profileId) || getBuiltInProfile(pending.profileId);
            if (!profile) return;

            const compatibleBackendEntries = params.getCompatibleProfileBackendEntries(profile);
            const currentSelectable = isCurrentCompatibleBackendSelectable(compatibleBackendEntries);
            const authoringIntent = params.resolveProfileAuthoringIntent?.(profile.id) ?? null;
            const preferredEntry = authoringIntent?.preferredAgentTargetKey
                ? compatibleBackendEntries.find((entry) => entry.backendTargetKey === authoringIntent.preferredAgentTargetKey) ?? null
                : null;
            const preferredEntrySelectable = preferredEntry
                ? isBackendEntrySelectableForNewSession({
                    entry: preferredEntry,
                    machineAgentsById: params.machineAgentsById,
                })
                : false;

            if (preferredEntry && preferredEntrySelectable) {
                if (preferredEntry.backendTargetKey !== params.selectedBackendTargetKey) {
                    params.setBackendTarget(preferredEntry.backendTarget);
                }
            } else if (compatibleBackendEntries.length > 0 && !currentSelectable) {
                const nextEntry = resolveNextCompatibleBackendEntry(compatibleBackendEntries);
                if (nextEntry) {
                    params.setBackendTarget(nextEntry.backendTarget);
                }
            }

            if (!params.hasUserSelectedPermissionModeRef.current) {
                params.applyPermissionMode(params.resolveDefaultPermissionMode(profile), 'auto');
            }
        });

        return () => {
            cancelReconciliation();
        };
    }, [
        params.agentType,
        params.applyPermissionMode,
        params.getCompatibleProfileBackendEntries,
        params.hasUserSelectedPermissionModeRef,
        params.profileMap,
        params.resolveDefaultPermissionMode,
        params.resolveProfileAuthoringIntent,
        params.selectedBackendTargetKey,
        params.selectedProfileId,
        params.setBackendTarget,
        resolveNextCompatibleBackendEntry,
    ]);

    React.useEffect(() => {
        if (!params.useProfiles || params.selectedProfileId === null) {
            return;
        }

        const profile = params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);
        if (!profile) {
            return;
        }

        const compatibleBackendEntries = params.getCompatibleProfileBackendEntries(profile);
        // Inventory refresh or sign-in readiness must not replace compatible
        // authored intent. Only an incompatible profile needs another Agent.
        const currentCompatible = compatibleBackendEntries.some((entry) => entry.backendTargetKey === params.selectedBackendTargetKey);

        if (compatibleBackendEntries.length > 0 && !currentCompatible) {
            const nextEntry = resolveNextCompatibleBackendEntry(compatibleBackendEntries);
            if (nextEntry) {
                params.setBackendTarget(nextEntry.backendTarget);
            }
        }
    }, [
        params.getCompatibleProfileBackendEntries,
        params.profileMap,
        params.selectedBackendTargetKey,
        params.selectedProfileId,
        params.setBackendTarget,
        params.useProfiles,
        resolveNextCompatibleBackendEntry,
    ]);

    const prevAgentTypeRef = React.useRef(params.agentType);

    React.useEffect(() => {
        const prev = prevAgentTypeRef.current;
        if (prev === params.agentType) {
            return;
        }
        prevAgentTypeRef.current = params.agentType;

        if (!params.hasUserSelectedPermissionModeRef.current) {
            const profile = params.selectedProfileId
                ? (params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId))
                : null;
            params.applyPermissionMode(params.resolveDefaultPermissionMode(profile), 'auto');
            return;
        }

        const current = params.permissionModeRef.current;
        const mapped = normalizePermissionModeForAgentType(current, params.agentType);
        params.applyPermissionMode(mapped, 'auto');
    }, [
        params.agentType,
        params.applyPermissionMode,
        params.profileMap,
        params.resolveDefaultPermissionMode,
        params.selectedProfileId,
    ]);

    return {
        selectProfile,
    };
}
