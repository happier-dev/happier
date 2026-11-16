import * as React from 'react';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { NewSessionAgentPickerViewV1 } from '@/sync/domains/state/newSessionInteractionSchemas';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { NewSessionEngineOptionDetailProps } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';

import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import { buildSessionAgentPickerDetailContent } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { FavoriteModelTogglePayload } from './newSessionFavoriteModelsPickerOption';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';

type BuildNewSessionAgentPickerOptionInteractionsParams = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    disabled: boolean;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    refreshProbe?: OptionPickerProbeState | null;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (entry: ResolvedBackendCatalogEntry, model: FavoriteModelTogglePayload) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    providerProjection?: NewSessionEngineOptionDetailProps['providerProjection'];
    teamModels?: NewSessionEngineOptionDetailProps['teamModels'];
    nativeSourceLabel?: NewSessionEngineOptionDetailProps['nativeSourceLabel'];
    connectedServices?: ConnectedServiceBindingsV2 | null;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onRememberAgentPickerView?: (view: NewSessionAgentPickerViewV1) => void;
    getEngineSelectionForTargetKey: (targetKey: string) => SessionAgentPickerSelection;
    selectBackendTarget: (entry: ResolvedBackendCatalogEntry) => void;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => void;
    /** One machine-wide line under the open Agent's Model label (an offline machine), said once rather than per row. */
    modelSummary?: string;
}>;

function NewSessionAgentPickerDetailContent(props: Omit<
    Parameters<typeof buildSessionAgentPickerDetailContent>[0], 'settings'
>) {
    const detail = props;
    const settings = useAgentUiSettings({ agentIds: [props.runtimeCarrierAgentId ?? props.agentCatalogEntry.agentId],
        machineId: props.selectedMachineId, domain: 'runtime' });
    return buildSessionAgentPickerDetailContent({ ...detail, settings });
}

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
            params.selectBackendTarget(params.entry);
        },
        renderDetailContent: () => {
            const selection = params.getEngineSelectionForTargetKey(params.entry.backendTargetKey);
            return React.createElement(NewSessionAgentPickerDetailContent, {
                backendTarget: params.entry.backendTarget,
                agentCatalogEntry: params.entry.agentCatalogEntry,
                // The OPERATIONAL Agent identity, not the closed built-in
                // `catalogAgentId` backing (which is `null` for every
                // plugin-contributed Agent). Every probe in the expanded detail
                // — models, session modes, ACP configuration options — keys on
                // the Agent that actually owns the backend at runtime.
                runtimeCarrierAgentId: params.entry.agentId,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                cwd: params.selectedPath,
                        refreshProbe: params.refreshProbe,
                modelSummary: params.modelSummary,
                selection,
                favoriteModelSelections: params.favoriteModelSelections ?? [],
                onToggleFavoriteModel: params.onToggleFavoriteModel
                    ? (model) => params.onToggleFavoriteModel?.(params.entry, model)
                    : undefined,
                favoriteEngine: params.favoriteEngine,
                ...(params.providerProjection ? { providerProjection: params.providerProjection } : {}),
                teamModels: params.teamModels,
                nativeSourceLabel: params.nativeSourceLabel,
                ...('connectedServices' in params ? { connectedServices: params.connectedServices } : {}),
                experimentalConfirmation: params.experimentalConfirmation,
                onSelectionChange: (nextSelection) => {
                    params.selectEngineSelection(params.entry, nextSelection);
                },
            });
        },
    };
}
