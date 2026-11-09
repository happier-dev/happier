import * as React from 'react';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { getModelOptionsForSession, supportsFreeformModelSelectionForSession, type ModelOption, type SessionModelOptionsContext } from '@/sync/domains/models/modelOptions';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type SessionModelDiscoveryContext = Parameters<typeof useNewSessionPreflightModelsState>[0];
export type SessionModelDetailState = Readonly<{
    modelOptions: readonly ModelOption[];
    modelOptionsContext: SessionModelOptionsContext;
    canEnterCustomModel: boolean;
    probe: OptionPickerProbeState;
}>;

/** The deferred picker detail owns discovery; a closed composer never mounts it. */
export function SessionModelDiscoveryDetail(props: Readonly<{
    agentId: string;
    machineId?: string | null;
    accountScope?: ServerAccountScope | null;
    composerOptionsInput: ComposerOptionsInputV1 | null;
    discovery: (settings: Readonly<Record<string, unknown>>) => SessionModelDiscoveryContext;
    selectedModelId?: string;
    renderDetail: (state: SessionModelDetailState) => React.ReactNode;
}>) {
    const settings = useAgentUiSettings({ agentIds: [props.agentId], machineId: props.machineId, accountScope: props.accountScope, domain: 'runtime' });
    const discovery = React.useMemo(() => props.discovery(settings), [props.discovery, settings]);
    const { preflightModels, preflightModelsTargetKey, probe } = useNewSessionPreflightModelsState(discovery);
    const currentTargetKey = discovery.backendTarget ? resolveBackendTargetKeyV2(discovery.backendTarget) : null;
    const modelOptionsContext = React.useMemo<SessionModelOptionsContext>(() => ({
        preflight: preflightModels,
        preflightUpdatedAt: probe.refreshedAt,
        preflightTargetKey: preflightModelsTargetKey,
        currentTargetKey,
        selectedModelId: props.selectedModelId,
    }), [preflightModels, preflightModelsTargetKey, currentTargetKey, probe.refreshedAt, props.selectedModelId]);
    const modelOptions = React.useMemo(() => getModelOptionsForSession(props.agentId, props.composerOptionsInput, modelOptionsContext),
        [props.agentId, props.composerOptionsInput, modelOptionsContext]);
    return props.renderDetail({
        modelOptions, modelOptionsContext, probe,
        canEnterCustomModel: supportsFreeformModelSelectionForSession(props.agentId, props.composerOptionsInput, modelOptionsContext),
    });
}
