import * as React from 'react';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { Settings } from '@/sync/domains/settings/settings';

export type NewSessionAgentPickerSelection = Readonly<{
    modelId: string;
    sessionModeId: string;
    configOverrides: Readonly<Record<string, string>>;
}>;

export function buildNewSessionAgentPickerDetailContent(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
    selection: NewSessionAgentPickerSelection;
    onSelectionChange: (selection: NewSessionAgentPickerSelection) => void;
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
            capabilityProbeContext={capabilityProbeContext}
            refreshProbe={params.refreshProbe}
            selectedModelId={params.selection.modelId}
            selectedSessionModeId={params.selection.sessionModeId}
            selectedConfigOverrides={params.selection.configOverrides}
            onSelectionChange={params.onSelectionChange}
        />
    );
}
