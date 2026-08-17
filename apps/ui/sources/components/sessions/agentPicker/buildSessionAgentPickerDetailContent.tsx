import * as React from 'react';

import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { Settings } from '@/sync/domains/settings/settings';

/**
 * The model/mode/config choice a single Agent picker row currently carries.
 *
 * New Session projects this into authoring state; the in-session picker keeps it
 * as the target-Agent part of an armed continuation until the message is sent.
 */
export type SessionAgentPickerSelection = Readonly<{
    modelId: string;
    /**
     * What the pane called {@link modelId}, or null while the row is still on the
     * Agent's own settings. Carried rather than re-derived so the composer's engine
     * chip can name an armed model in the exact words the reader just selected.
     */
    modelLabel: string | null;
    sessionModeId: string | null;
    configOverrides: Readonly<Record<string, string>>;
}>;

/**
 * One Agent row's engine detail, for any Agent on any surface.
 *
 * This is the shared seam between New Session and the in-session picker: both
 * show the same models, thinking tiers and configuration for the same Agent,
 * because both render the same owner rather than each composing their own.
 */
export function buildSessionAgentPickerDetailContent(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    profileId?: string | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
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
    onToggleFavoriteModel?: (model: Readonly<{ modelId: string; modelLabel: string }>) => void;
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    onSelectionChange: (selection: SessionAgentPickerSelection) => void;
}>): React.ReactElement {
    const capabilityProbeContext = resolveNewSessionCapabilityProbeContext({
        backendTarget: params.backendTarget,
        settings: params.settings,
    });

    return (
        <NewSessionEngineOptionDetail
            backendTarget={params.backendTarget}
            selectedMachineId={params.selectedMachineId}
            capabilityServerId={params.capabilityServerId}
            cwd={params.cwd}
            profileId={params.profileId ?? null}
            capabilityProbeContext={capabilityProbeContext}
            connectedServices={params.connectedServices ?? null}
            refreshProbe={params.refreshProbe}
            modelSummary={params.modelSummary}
            selectedModelId={params.selection.modelId}
            selectedSessionModeId={params.selection.sessionModeId}
            selectedConfigOverrides={params.selection.configOverrides}
            favoriteModelSelections={params.favoriteModelSelections ?? []}
            onToggleFavoriteModel={params.onToggleFavoriteModel}
            favoriteEngine={params.favoriteEngine}
            onSelectionChange={(next) => params.onSelectionChange({
                modelId: next.modelId,
                modelLabel: next.modelLabel,
                sessionModeId: next.sessionModeId,
                configOverrides: next.configOverrides,
            })}
        />
    );
}
