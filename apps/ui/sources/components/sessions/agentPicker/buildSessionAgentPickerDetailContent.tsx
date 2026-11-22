import * as React from 'react';

import type { PersistedBackendTargetRefV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { NewSessionDraftAgentIntent } from '@happier-dev/protocol/actions/appShellActionFamily';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import {
    projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
    resolveAgentConnectedAccountPurposeDefaults,
} from '@happier-dev/protocol/account/settings/connected-services';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';

import {
    NewSessionEngineOptionDetail,
    type NewSessionEngineOptionDetailProps,
} from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { resolveNewSessionModelCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { SessionModelPickerExperimentalConfirmationController } from '@/components/sessions/modelPicker/SessionModelPicker';
import type { FavoriteModelTogglePayload } from '@/components/sessions/new/hooks/screenModel/newSessionFavoriteModelsPickerOption';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';

/**
 * The model/mode/config choice a single Agent picker row currently carries.
 *
 * New Session projects this into authoring state; the in-session picker keeps it
 * as the target-Agent part of an armed continuation until the message is sent.
 */
export type SessionAgentPickerSelection = Readonly<Extract<NewSessionDraftAgentIntent, { kind: 'picker' }>['selection']>;

type SessionAgentPickerDetailContentParams = Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    agentCatalogEntry: ResolvedAgentCatalogEntry;
    runtimeCarrierAgentId?: string | null;
    selectedMachineId: string | null;
    accountScope?: ServerAccountScope | null;
    capabilityServerId: string;
    cwd: string | null;
    settings: Readonly<Record<string, unknown>>;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    includeProviderConnectedAccounts?: boolean;
    selectedProfileId?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    refreshProbe?: OptionPickerProbeState | null;
    /**
     * One short line under the section label saying what choosing here means on
     * this surface. New Session needs none; the in-session picker uses it to say
     * that the conversation carries over and nothing is sent yet.
     */
    modelSummary?: string;
    /** Several Sessions that run different models: no model reads as chosen, and the running line says Mixed. */
    mixedSelection?: NewSessionEngineOptionDetailProps['mixedSelection'];
    selection: SessionAgentPickerSelection;
    reconcileSelection?: NewSessionEngineOptionDetailProps['reconcileSelection'];
    favoriteModelSelections?: readonly FavoriteModelSelectionV1[];
    onToggleFavoriteModel?: (model: FavoriteModelTogglePayload) => void;
    onUpdateFavoriteModelReasoningEffort?: NewSessionEngineOptionDetailProps['onUpdateFavoriteModelReasoningEffort'];
    favoriteEngine?: Readonly<{
        favorite: boolean;
        onToggle: () => void;
    }>;
    providerProjection?: NewSessionEngineOptionDetailProps['providerProjection'];
    teamModels?: NewSessionEngineOptionDetailProps['teamModels'];
    nativeSourceLabel?: NewSessionEngineOptionDetailProps['nativeSourceLabel'];
    experimentalConfirmation?: SessionModelPickerExperimentalConfirmationController;
    onSelectionChange: (selection: SessionAgentPickerSelection) => void;
}>;

export function buildSessionAgentPickerDetailContent(params: SessionAgentPickerDetailContentParams): React.ReactElement {
    return <SessionAgentPickerDetailContent {...params} />;
}

/** Only an opened detail reads default-account authority; explicit draft bindings bypass default resolution. */
function SessionAgentPickerDetailContent(params: SessionAgentPickerDetailContentParams): React.ReactElement {
    const needsDefaults = !('connectedServices' in params) && params.agentCatalogEntry.connectedAccounts.length > 0;
    const { binding } = useServerCredentialAccountScopeBinding(needsDefaults ? params.capabilityServerId : null);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const purposes = useConnectedAccountCatalog('purposes', needsDefaults ? scope : null,
        { sourceMachineId: params.selectedMachineId });
    const connectedAccountPurposeBindings = purposes.status === 'ready' && !purposes.stale ? purposes.value : null;
    const consumer = params.agentCatalogEntry.identity
        ?? parseQualifiedPluginContributionKey(params.agentCatalogEntry.qualifiedId);
    const connectedServices = consumer && connectedAccountPurposeBindings
        ? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(resolveAgentConnectedAccountPurposeDefaults({
            settings: params.settings,
            purposeBindings: connectedAccountPurposeBindings,
            agentId: params.agentCatalogEntry.agentId,
            consumer,
            declarations: params.agentCatalogEntry.connectedAccounts,
        }))
        : null;
    const capabilityProbeContext = resolveNewSessionModelCapabilityProbeContext({
        backendTarget: params.backendTarget,
        modelId: params.selection.modelId,
        settings: params.settings,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId ?? null,
        machineId: params.selectedMachineId,
        accountScope: params.accountScope,
        selectedProfileId: params.selectedProfileId,
        runtimeDescriptorV1: params.runtimeDescriptorV1,
        connectedServices: 'connectedServices' in params ? params.connectedServices : connectedServices,
    });

    return (
        <NewSessionEngineOptionDetail
            backendTarget={params.backendTarget}
            runtimeCarrierAgentId={params.runtimeCarrierAgentId ?? null}
            selectedMachineId={!needsDefaults || connectedAccountPurposeBindings ? params.selectedMachineId : null}
            capabilityServerId={params.capabilityServerId}
            cwd={params.cwd}
            capabilityProbeContext={capabilityProbeContext}
            connectedServices={'connectedServices' in params ? params.connectedServices : connectedServices}
            includeProviderConnectedAccounts={params.includeProviderConnectedAccounts}
            refreshProbe={params.refreshProbe}
            modelSummary={params.modelSummary}
            mixedSelection={params.mixedSelection}
            selectedModelId={params.selection.modelId}
            selectedModelSelection={params.selection.modelSelection ?? null}
            selectedSessionModeId={params.selection.sessionModeId}
            selectedConfigOverrides={params.selection.configOverrides}
            reconcileSelection={params.reconcileSelection}
            favoriteModelSelections={params.favoriteModelSelections ?? []}
            onToggleFavoriteModel={params.onToggleFavoriteModel}
            onUpdateFavoriteModelReasoningEffort={params.onUpdateFavoriteModelReasoningEffort}
            favoriteEngine={params.favoriteEngine}
            {...(params.providerProjection ? { providerProjection: params.providerProjection } : {})}
            teamModels={params.teamModels}
            nativeSourceLabel={params.nativeSourceLabel}
            experimentalConfirmation={params.experimentalConfirmation}
            onSelectionChange={(next) => params.onSelectionChange(next)}
        />
    );
}
