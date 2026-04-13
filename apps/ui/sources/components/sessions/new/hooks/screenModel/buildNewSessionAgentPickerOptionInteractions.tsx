import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { Settings } from '@/sync/domains/settings/settings';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerDetailContent } from './buildNewSessionAgentPickerDetailContent';

type BuildNewSessionAgentPickerOptionInteractionsParams = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    disabled: boolean;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
}>;

export function buildNewSessionAgentPickerOptionInteractions(
    params: BuildNewSessionAgentPickerOptionInteractionsParams,
): Pick<AgentInputChipPickerOption, 'closeOnSelectImmediate' | 'onSelectImmediate' | 'renderDetailContent'> {
    return {
        closeOnSelectImmediate: false,
        onSelectImmediate: () => {
            if (params.disabled) return;
            const nextSelection = params.getEngineSelectionForTargetKey(params.entry.targetKey);
            params.selectEngineSelection(params.entry, nextSelection);
        },
        renderDetailContent: () => {
            const selection = params.getEngineSelectionForTargetKey(params.entry.targetKey);
            return buildNewSessionAgentPickerDetailContent({
                backendTarget: params.entry.target,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                cwd: params.selectedPath,
                settings: params.settings,
                refreshProbe: params.refreshProbe,
                selection,
                onSelectionChange: (nextSelection) => {
                    params.selectEngineSelection(params.entry, nextSelection);
                },
            });
        },
    };
}
