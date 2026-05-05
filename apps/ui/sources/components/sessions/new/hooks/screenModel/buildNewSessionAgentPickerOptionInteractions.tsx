import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerDetailContent } from './buildNewSessionAgentPickerDetailContent';
import type { FavoriteModelTogglePayload } from './newSessionFavoriteModelsPickerOption';

type BuildNewSessionAgentPickerOptionInteractionsParams = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    disabled: boolean;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
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
            const nextSelection = params.getEngineSelectionForTargetKey(params.entry.backendTargetKey);
            params.selectEngineSelection(params.entry, nextSelection);
        },
        renderDetailContent: () => {
            const selection = params.getEngineSelectionForTargetKey(params.entry.backendTargetKey);
            return buildNewSessionAgentPickerDetailContent({
                backendTarget: params.entry.backendTarget,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                cwd: params.selectedPath,
                settings: params.settings,
                refreshProbe: params.refreshProbe,
                selection,
                favoriteModelSelections: params.favoriteModelSelections ?? [],
                onToggleFavoriteModel: params.onToggleFavoriteModel
                    ? (model) => params.onToggleFavoriteModel?.(params.entry, model)
                    : undefined,
                onSelectionChange: (nextSelection) => {
                    params.selectEngineSelection(params.entry, nextSelection);
                },
            });
        },
    };
}
