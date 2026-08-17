import * as React from 'react';

import type { BackendTargetRefV2, SessionModelSelectionV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import type { AgentId } from '@/agents/catalog/catalog';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { FavoriteModelTogglePayload } from '@/components/sessions/new/hooks/screenModel/newSessionFavoriteModelsPickerOption';

/**
 * The model/mode/config choice a single Agent picker row currently carries.
 *
 * New Session projects this into authoring state; the in-session picker keeps it
 * as the target-Agent part of an armed continuation until the message is sent.
 */
export type SessionAgentPickerSelection = Readonly<{
    modelId: string;
    modelSelection?: SessionModelSelectionV1 | null;
    /**
     * What the pane called {@link modelId}, or null while the row is still on the
     * Agent's own settings. Carried rather than re-derived so the composer's engine
     * chip can name an armed model in the exact words the reader just selected.
     */
    modelLabel?: string | null;
    sessionModeId: string | null;
    configOverrides: Readonly<Record<string, string>>;
}>;

export function buildSessionAgentPickerDetailContent(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: AgentId | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    /**
     * One short line under the section label saying what choosing here means on
     * this surface. New Session needs none; the in-session picker uses it to say
     * that the conversation carries over and nothing is sent yet.
     */
    modelSummary?: string;
    selection: SessionAgentPickerSelection;
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: FavoriteModelTogglePayload) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectionChange: (selection: SessionAgentPickerSelection) => void;
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
            modelSummary={params.modelSummary}
            selectedModelId={params.selection.modelId}
            selectedModelSelection={params.selection.modelSelection ?? null}
            selectedSessionModeId={params.selection.sessionModeId}
            selectedConfigOverrides={params.selection.configOverrides}
            favoriteModelSelections={params.favoriteModelSelections ?? []}
            onToggleFavoriteModel={params.onToggleFavoriteModel}
            favoriteEngine={params.favoriteEngine}
            experimentalConfirmation={params.experimentalConfirmation}
            onSelectionChange={(next) => params.onSelectionChange(next)}
        />
    );
}
