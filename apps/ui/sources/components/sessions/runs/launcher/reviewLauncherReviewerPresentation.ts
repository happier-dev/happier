import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { getAgentModelConfig, resolveBundledAgentIdFromContributionIdentity } from '@happier-dev/agents';
import type { ReviewEngineReviewerSelectionV1, ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { t } from '@/text';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

export type ReviewLauncherInheritedModel = Readonly<{
    selection: NonNullable<ReviewEngineReviewerSelectionV1['modelSelection']>;
    label: string | null;
}>;

/** The Who row and its open detail identify the same intentional invocation. */
export function presentReviewLauncherReviewer(reviewer: ReviewEngineReviewerSelectionV1, index: number,
    reviewers: readonly ReviewReviewerSelectionV1[], choice: ExecutionRunLauncherBackendChoice,
    inheritedModel?: ReviewLauncherInheritedModel): Readonly<{ label: string; subtitle: string }> {
    const members = reviewers.flatMap((member, position) => member.kind === 'engine' && member.engineId === reviewer.engineId ? [position] : []);
    const label = members.length > 1 ? `${choice.title} ${members.indexOf(index) + 1}` : choice.title;
    const runnerKey = reviewer.runnerAgentTarget ? buildBackendTargetKeyV2(reviewer.runnerAgentTarget) : null;
    const runner = runnerKey ? choice.reviewRunnerChoices
        ?.find(candidate => candidate.choice.targetKey === runnerKey)?.choice : null;
    const agent = runner ?? (choice.reviewInventoryItem?.runnerAgents?.length ? null : choice);
    const agentId = agent?.agentId ?? (reviewer.runnerAgentTarget
        ? resolveBundledAgentIdFromContributionIdentity(reviewer.runnerAgentTarget.identity) : null);
    const runnerTitle = agent?.title ?? (reviewer.runnerAgentTarget ? resolveAgentCatalogTitle(
        agentId ?? buildQualifiedPluginContributionKey(reviewer.runnerAgentTarget.identity),
    ) : null);
    if (agentId && getAgentModelConfig(agentId)?.supportsSelection === false) {
        const connected = agent?.agentCatalogEntry?.connectedAccounts.some(declaration =>
            reviewer.connectedServices?.bindingsByServiceId[buildQualifiedPluginContributionKey(declaration.service)]?.source === 'connected');
        return { label, subtitle: choice.unavailableReason ?? (connected
            ? t('settings.connectedAccounts') : t('connectedServices.authModal.nativeAuthTitle')) };
    }
    const target = reviewer.runnerAgentTarget ?? agent?.backendTarget;
    const inherited = inheritedModel && target && reviewer.childSelection !== 'agentDefault'
        && reviewer.modelSelection === undefined && reviewer.teamCredentialModel === undefined && reviewer.modelId === undefined
        && backendTargetKeysMatch(inheritedModel.selection.agentTargetKey, target) ? inheritedModel : null;
    const modelSelection = reviewer.modelSelection ?? inherited?.selection;
    const modelId = reviewer.teamCredentialModel?.modelId ?? modelSelection?.modelId ?? reviewer.modelId;
    const model = modelId ? inherited?.label ?? resolveRunNativeModelLabel(target, undefined, {
            modelSelection: modelSelection ?? null, teamCredentialModel: reviewer.teamCredentialModel ?? null,
        })(modelId) ?? modelId : t('agentInput.model.useCliSettings');
    return { label, subtitle: choice.unavailableReason ?? [runnerTitle, model].filter(Boolean).join(' · ') };
}
