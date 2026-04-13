import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerResolvedOptions } from './buildNewSessionAgentPickerResolvedOptions';
import { partitionNewSessionAgentPickerOptions } from './partitionNewSessionAgentPickerOptions';
import { resolveNewSessionAgentPickerSelectionContext } from './resolveNewSessionAgentPickerSelectionContext';

type BuildNewSessionAgentPickerOptionsParams = Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
}>;

export type NewSessionAgentPickerOptionsState = Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    selectableBackendEntries: readonly ResolvedBackendCatalogEntry[];
}>;

export function buildNewSessionAgentPickerOptions(
    params: BuildNewSessionAgentPickerOptionsParams,
): NewSessionAgentPickerOptionsState {
    const {
        profileForAgentSelection,
        compatibleBackendTargetKeys,
        selectableBackendEntries,
    } = resolveNewSessionAgentPickerSelectionContext({
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        profileMap: params.profileMap,
        resolvedBackendEntries: params.resolvedBackendEntries,
        getCompatibleProfileBackendEntries: params.getCompatibleProfileBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
    });

    const hasConfiguredAcpBackend = params.resolvedBackendEntries.some((entry) => entry.family === 'configuredAcpBackend');
    if (params.resolvedBackendEntries.length <= 1 && !hasConfiguredAcpBackend) {
        return {
            selectableBackendEntries,
        };
    }

    const resolved = buildNewSessionAgentPickerResolvedOptions({
        profileForAgentSelection,
        compatibleBackendTargetKeys,
        resolvedBackendEntries: params.resolvedBackendEntries,
        isBackendEntrySelectable: params.isBackendEntrySelectable,
        getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
        selectEngineSelection: params.selectEngineSelection,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        selectedPath: params.selectedPath,
        settings: params.settings,
        refreshProbe: params.refreshProbe,
    });

    const { available, muted, disabled } = partitionNewSessionAgentPickerOptions(resolved);

    return {
        agentPickerOptions: [...available, ...muted, ...disabled],
        selectableBackendEntries,
    };
}
