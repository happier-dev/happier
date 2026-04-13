import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import {
    resolveNewSessionAgentPickerEntryByTargetKey,
    resolveNewSessionAgentPickerSingleSelectFallbackEntry,
} from './resolveNewSessionAgentPickerDispatch';
import { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';

export function useNewSessionAgentPickerControls(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    /**
     * Optional probe surface to merge into the engine detail pane's refresh affordance.
     * This is used to make the model refresh button also refresh CLI detection.
     */
    refreshProbe?: OptionPickerProbeState | null;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    } = useNewSessionAgentPickerEngineSelectionState({
        selectedBackendEntry: params.selectedBackendEntry,
        selectedBackendTargetKey: params.selectedBackendTargetKey,
        modelMode: params.modelMode,
        acpSessionModeId: params.acpSessionModeId,
        sessionConfigOptionOverrides: params.sessionConfigOptionOverrides,
        setBackendTarget: params.setBackendTarget,
        setModelMode: params.setModelMode,
        setAcpSessionModeId: params.setAcpSessionModeId,
        setSessionConfigOptionOverrides: params.setSessionConfigOptionOverrides,
    });

    const {
        agentPickerOptions,
        selectableBackendEntries,
    } = React.useMemo(() => buildNewSessionAgentPickerOptions({
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        profileMap: params.profileMap,
        resolvedBackendEntries: params.resolvedBackendEntries,
        getCompatibleProfileBackendEntries: params.getCompatibleProfileBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
        getEngineSelectionForTargetKey,
        selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        selectedPath: params.selectedPath,
        settings: params.settings,
        refreshProbe: params.refreshProbe,
    }), [
        getEngineSelectionForTargetKey,
        params.capabilityServerId,
        params.getCompatibleProfileBackendEntries,
        params.isBackendEntrySelectable,
        params.profileMap,
        params.refreshProbe,
        params.resolvedBackendEntries,
        params.selectedMachineId,
        params.selectedPath,
        params.selectedProfileId,
        params.settings,
        params.useProfiles,
        selectEngineSelection,
    ]);

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        const nextEntry = resolveNewSessionAgentPickerEntryByTargetKey({
            resolvedBackendEntries: params.resolvedBackendEntries,
            selectedId,
        });
        if (nextEntry) {
            const nextSelection = getEngineSelectionForTargetKey(nextEntry.targetKey);
            selectEngineSelection(nextEntry, nextSelection);
        }
    }, [getEngineSelectionForTargetKey, params.resolvedBackendEntries, selectEngineSelection]);

    const selectedBackendTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
    const handleAgentClick = React.useCallback(() => {
        const nextEntry = resolveNewSessionAgentPickerSingleSelectFallbackEntry({
            selectableBackendEntries,
            selectedBackendTargetKey,
        });
        if (nextEntry) {
            params.setBackendTarget(nextEntry.target);
        }
    }, [
        params.setBackendTarget,
        selectedBackendTargetKey,
        selectableBackendEntries,
    ]);

    return {
        agentPickerOptions,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
