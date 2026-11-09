import { buildBackendTargetKeyV2, type BackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import { resolveModelStructuredOutputSupport, type ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { encodeScmDiffSummaryModelOverride, type ScmDiffSummaryCatalogProfile } from './scmDiffSummarySettings.js';

export type AgentModelChoicePurpose = 'walkthrough' | 'runner';

export function selectAgentModelProfilesForPurpose(profiles: readonly ScmDiffSummaryCatalogProfile[], purpose: AgentModelChoicePurpose): readonly ScmDiffSummaryCatalogProfile[] {
    return purpose === 'runner' ? profiles : profiles.filter(profile => profile.structuredOutput === 'supported');
}

/** Project the owning catalog's actual model descriptors into the shared Summary preference. */
export function buildScmDiffSummaryModelProfiles(params: Readonly<{
    backendTarget: BackendTargetRefV2 | AgentExecutionTargetV1;
    models: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'capabilities' | 'costTier'>[];
    catalogModels?: readonly Pick<ProviderModelDescriptorV1, 'id' | 'costTier'>[];
    agentFormats?: readonly string[] | null;
    purpose?: AgentModelChoicePurpose;
}>): readonly ScmDiffSummaryCatalogProfile[] {
    if (params.models.length === 0) return [];
    const backendTargetKey = buildBackendTargetKeyV2(params.backendTarget);
    const profiles: readonly ScmDiffSummaryCatalogProfile[] = params.models.map(model => {
        const modelSelector = { backendTargetKey, modelId: model.id };
        const costTier = model.costTier ?? params.catalogModels?.find(candidate => candidate.id === model.id)?.costTier;
        return { catalogId: encodeScmDiffSummaryModelOverride(modelSelector), title: model.name, modelSelector,
            ...(costTier ? { costTier } : {}),
            structuredOutput: resolveModelStructuredOutputSupport({ model, catalogModel: true, agentFormats: params.agentFormats }) };
    });
    return params.purpose ? selectAgentModelProfilesForPurpose(profiles, params.purpose) : profiles;
}
