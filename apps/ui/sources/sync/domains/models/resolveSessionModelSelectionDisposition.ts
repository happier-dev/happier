import type { Metadata } from '@happier-dev/session-core/state';
import { isSessionModelCatalogForAgent, readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents';
import { readExactSessionActiveModelSelection } from '@happier-dev/protocol/providers/active-model-selection';
import { readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';
import { readSessionProviderBindingMetadataStateV1, sessionProviderBindingMetadataMatchesRuntimeBasisV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { ProviderBoundModelRef, SessionModelSelectionIntentV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionActiveModelSelection, SessionModelRefV2, SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { resolveRetainedTeamProviderBindingRevisionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

export type CurrentSessionRunnerProcessIdentity = Readonly<{
    pid: number;
    processStartTimeMs: number;
}>;

export type SessionModelSelectionDisposition = Readonly<{
    sessionDisposition: 'active' | 'next_launch';
    proposedIntent: SessionModelSelectionIntentV1 | null;
    proposedSelection: ProviderBoundModelRef | null;
    proposedSelectionV2: SessionModelSelectionV2 | null;
    /** Picker identity, including coherent applied history; never live runtime authority. */
    selectedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    /** Source identity for the picker's running/last-reported marker. */
    reportedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    activeSelection: ProviderBoundModelRef | null;
    activeRouteSelection: ProviderBoundModelRef | SessionModelRefV2 | null;
    /** Coherent runtime-applied history for presentation; never current runner/context authority. */
    lastAppliedSelection: ProviderBoundModelRef | null;
    lastAppliedRouteSelection: ProviderBoundModelRef | SessionModelRefV2 | null;
    selectionTransitionPending: boolean;
    reportedSelection: ProviderBoundModelRef | null;
    reportedSelectionStatus: 'running' | 'last_used' | 'last_reported' | null;
    contextSelection: ProviderBoundModelRef | null;
    contextRouteSelection: ProviderBoundModelRef | SessionModelRefV2 | null;
}>;

function normalizeModelId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

function routeSelection(fact: SessionActiveModelSelection | null): ProviderBoundModelRef | SessionModelRefV2 | null {
    if (!fact) return null;
    if (fact.v === 1) return fact.selection;
    const { kind: _kind, ...ref } = fact.teamCredentialModel;
    return { source: 'team_resource', ...ref };
}

function matchingAppliedTeamSelection(
    fact: SessionActiveModelSelection | null,
    selection: ProviderBoundModelRef | null,
): TeamCredentialProviderModelSelectionV1 | null {
    return fact?.v === 2 && selection
        && selection.agentTargetKey === fact.selection.agentTargetKey
        && selection.providerConnectionId === fact.selection.providerConnectionId
        && selection.modelId === fact.selection.modelId
        ? fact.teamCredentialModel : null;
}

/**
 * Projects proposed, exact-active, and presentation-only model facts without
 * promoting fallback catalog state into active runtime truth.
 */
export function resolveSessionModelSelectionDisposition(params: Readonly<{
    agentId: string;
    agentTargetKey: string;
    metadata: Metadata | null | undefined;
    sessionActive: boolean;
    currentRunnerProcessIdentity: CurrentSessionRunnerProcessIdentity | null;
}>): SessionModelSelectionDisposition {
    let proposedIntent: SessionModelSelectionIntentV1 | null = null;
    const proposedSelectionV2 = readSessionModelSelectionV2FromMetadata(params.metadata);
    try {
        proposedIntent = readSessionModelSelectionIntentFromMetadata(
            params.metadata,
            params.agentTargetKey,
        );
    } catch {
        proposedIntent = null;
    }
    const proposedSelection: ProviderBoundModelRef | null = proposedSelectionV2
        ? proposedSelectionV2.ref.source === 'team_resource'
            ? null
            : {
                agentTargetKey: proposedSelectionV2.ref.agentTargetKey,
                providerConnectionId: proposedSelectionV2.ref.source === 'native'
                    ? null
                    : proposedSelectionV2.ref.providerConnectionId,
                modelId: proposedSelectionV2.ref.modelId,
            }
        : proposedIntent?.selection ?? null;

    const providerBindingState = readSessionProviderBindingMetadataStateV1(params.metadata);
    const exactFact = readExactSessionActiveModelSelection({
        metadata: params.metadata, agentId: params.agentId, agentTargetKey: params.agentTargetKey,
        currentRunnerProcessIdentity: params.currentRunnerProcessIdentity,
    });
    const exactSelection = exactFact?.selection ?? null;

    const sessionModels = readSessionModelsState(params.metadata);
    const fallbackModelId = isSessionModelCatalogForAgent(sessionModels, params.agentId)
        ? normalizeModelId(sessionModels.currentModelId)
        : '';
    const nativeFallbackSelection: ProviderBoundModelRef = {
        agentTargetKey: params.agentTargetKey,
        providerConnectionId: null,
        modelId: fallbackModelId,
    };
    const providerFallbackSelection: ProviderBoundModelRef | null =
        providerBindingState.kind === 'valid'
        && providerBindingState.binding.model?.id === fallbackModelId
        && sessionProviderBindingMetadataMatchesRuntimeBasisV1({
            selection: {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
            },
            binding: providerBindingState.binding,
        })
            ? {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
                modelId: fallbackModelId,
            }
            : null;
    const fallbackSelection: ProviderBoundModelRef | null = !fallbackModelId
        ? null
        : providerBindingState.kind === 'absent'
            ? nativeFallbackSelection
            : providerFallbackSelection;
    const reportedSelection = exactSelection ?? fallbackSelection;
    const activeSelection = params.sessionActive ? exactSelection : null;
    // A replacement runner is not a new model choice. Compare intent with
    // coherent applied history even while the replacement's model publication
    // is catching up. This history never supplies active/context authority;
    // a genuinely different selection still requires transition admission.
    const lastAppliedFact = exactFact ?? readExactSessionActiveModelSelection({
        metadata: params.metadata, agentId: params.agentId, agentTargetKey: params.agentTargetKey,
        currentRunnerProcessIdentity: params.metadata?.sessionModelsV1?.activeSelectionV1?.runner ?? null,
    });
    const lastAppliedSelection = lastAppliedFact?.selection ?? null;
    const teamIntent = proposedSelectionV2?.ref.source === 'team_resource' ? proposedSelectionV2.ref : null;
    const appliedTeamModel = lastAppliedFact?.v === 2 ? lastAppliedFact.teamCredentialModel : null;
    const teamIntentApplied = teamIntent !== null && appliedTeamModel !== null
        && appliedTeamModel.agentTargetKey === teamIntent.agentTargetKey
        && appliedTeamModel.modelId === teamIntent.modelId
        && resolveRetainedTeamProviderBindingRevisionV1(teamIntent, appliedTeamModel) !== null;
    // The V1 launch intent names a model tuple, not its runtime-opened source.
    // Retain that source for presentation only while the tuple still matches;
    // an explicit V2 native/Provider choice always takes precedence.
    let selectedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null = null;
    if (teamIntent) {
        const { source: _source, ...ref } = teamIntent;
        selectedTeamCredentialModel = params.sessionActive && exactFact?.v === 2 && teamIntentApplied
            ? exactFact.teamCredentialModel
            : { kind: 'team_credential_provider_model', ...ref };
    } else if (!proposedSelectionV2) {
        selectedTeamCredentialModel = matchingAppliedTeamSelection(lastAppliedFact, proposedSelection ?? reportedSelection);
    }
    const reportedTeamCredentialModel = matchingAppliedTeamSelection(lastAppliedFact, reportedSelection);
    const exactRouteSelection = routeSelection(exactFact);
    const activeRouteSelection = params.sessionActive ? exactRouteSelection : null;
    const lastAppliedRouteSelection = exactFact ? exactRouteSelection : routeSelection(lastAppliedFact);
    const selectionTransitionPending = params.sessionActive
        && (
            teamIntent
                ? !teamIntentApplied
                : (
                    (proposedSelectionV2 !== null && lastAppliedFact?.v === 2)
                    || (
                        proposedIntent !== null
                        // Session socket presence precedes native startup/model publication.
                        // The launch intent alone is not evidence of a changed runtime route.
                        // Leave active/context authority unknown until the producer publishes it.
                        && sessionModels !== null
                        && (
                            lastAppliedSelection === null
                            || proposedSelection === null
                            || lastAppliedSelection.agentTargetKey !== proposedSelection.agentTargetKey
                            || lastAppliedSelection.providerConnectionId !== proposedSelection.providerConnectionId
                            || lastAppliedSelection.modelId !== proposedSelection.modelId
                        )
                    )
                )
        );
    const reportedSelectionStatus = reportedSelection === null
        ? null
        : exactSelection !== null
            ? params.sessionActive ? 'running' : 'last_used'
            : 'last_reported';
    const contextSelection: ProviderBoundModelRef | null = params.sessionActive ? activeSelection : proposedSelection ?? reportedSelection;
    const contextRouteSelection = params.sessionActive ? activeRouteSelection
        : proposedSelectionV2?.ref ?? (
            selectedTeamCredentialModel
                ? lastAppliedRouteSelection : contextSelection
        );

    return {
        sessionDisposition: params.sessionActive ? 'active' : 'next_launch',
        proposedIntent,
        proposedSelection,
        proposedSelectionV2,
        selectedTeamCredentialModel,
        reportedTeamCredentialModel,
        activeSelection,
        activeRouteSelection,
        lastAppliedSelection,
        lastAppliedRouteSelection,
        selectionTransitionPending,
        reportedSelection,
        reportedSelectionStatus,
        contextSelection,
        contextRouteSelection,
    };
}
