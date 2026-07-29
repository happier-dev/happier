import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerDetailContent } from './buildNewSessionAgentPickerDetailContent';
import { deferAgentInputPopoverClose } from '@/components/sessions/agentInput/selection/deferAgentInputPopoverClose';
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
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
}>;

export function buildNewSessionAgentPickerOptionInteractions(
    params: BuildNewSessionAgentPickerOptionInteractionsParams,
): Pick<
    AgentInputChipPickerOption,
    | 'closeOnSelectImmediate'
    | 'onSelectImmediate'
    | 'renderDetailContent'
    | 'deferRenderDetailContent'
    | 'deferredDetailContentCacheKey'
> {
    return {
        closeOnSelectImmediate: false,
        deferRenderDetailContent: true,
        deferredDetailContentCacheKey: [
            'new-session-engine',
            params.capabilityServerId,
            params.selectedMachineId ?? '',
            params.entry.backendTargetKey,
            params.selectedPath ?? '',
        ].join(':'),
        onSelectImmediate: () => {
            if (params.disabled) return;
            params.onRememberAgentPickerView?.({
                kind: 'backend',
                backendTargetKey: params.entry.backendTargetKey,
            });
            const nextSelection = params.getEngineSelectionForTargetKey(params.entry.backendTargetKey);
            params.selectEngineSelection(params.entry, nextSelection);
        },
        renderDetailContent: ({ onRequestClose }) => {
            const selection = params.getEngineSelectionForTargetKey(params.entry.backendTargetKey);
            return buildNewSessionAgentPickerDetailContent({
                backendTarget: params.entry.backendTarget,
                runtimeCarrierAgentId: params.entry.catalogAgentId,
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
                favoriteEngine: params.favoriteEngine,
                experimentalConfirmation: params.experimentalConfirmation,
                onSelectionChange: (nextSelection) => {
                    params.selectEngineSelection(params.entry, nextSelection);
                },
                onModelSelectionChange: () => {
                    deferAgentInputPopoverClose(onRequestClose);
                },
            });
        },
    };
}
