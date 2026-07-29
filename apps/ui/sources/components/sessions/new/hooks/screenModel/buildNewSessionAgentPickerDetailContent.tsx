import * as React from 'react';

import type { BackendTargetRefV2, SessionModelSelectionV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import type { AgentId } from '@/agents/catalog/catalog';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { FavoriteModelTogglePayload } from './newSessionFavoriteModelsPickerOption';

export type NewSessionAgentPickerSelection = Readonly<{
    modelId: string;
    modelSelection?: SessionModelSelectionV1 | null;
    sessionModeId: string | null;
    configOverrides: Readonly<Record<string, string>>;
}>;

export function buildNewSessionAgentPickerDetailContent(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: AgentId | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    selection: NewSessionAgentPickerSelection;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: FavoriteModelTogglePayload) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectionChange: (selection: NewSessionAgentPickerSelection) => void;
    onModelSelectionChange?: () => void;
}>): React.ReactElement {
    const capabilityProbeContext = resolveNewSessionCapabilityProbeContext({
        backendTarget: params.backendTarget,
        settings: params.settings,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId ?? null,
    });

    return (
        <NewSessionEngineOptionDetail
            backendTarget={params.backendTarget}
            runtimeCarrierAgentId={params.runtimeCarrierAgentId ?? null}
            selectedMachineId={params.selectedMachineId}
            capabilityServerId={params.capabilityServerId}
            cwd={params.cwd}
            capabilityProbeContext={capabilityProbeContext}
            refreshProbe={params.refreshProbe}
            selectedModelId={params.selection.modelId}
            selectedModelSelection={params.selection.modelSelection ?? null}
            selectedSessionModeId={params.selection.sessionModeId}
            selectedConfigOverrides={params.selection.configOverrides}
            favoriteModelSelections={params.favoriteModelSelections ?? []}
            onToggleFavoriteModel={params.onToggleFavoriteModel}
            favoriteEngine={params.favoriteEngine}
            experimentalConfirmation={params.experimentalConfirmation}
            onSelectionChange={(next) => params.onSelectionChange(next)}
            onModelSelectionChange={params.onModelSelectionChange}
        />
    );
}
