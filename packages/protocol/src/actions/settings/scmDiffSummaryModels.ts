import { buildBackendTargetKeyV2, type BackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { resolveModelStructuredOutputSupport, type ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { encodeScmDiffSummaryModelOverride, type ScmDiffSummaryCatalogProfile } from './scmDiffSummarySettings.js';

/** Project the owning catalog's actual model descriptors into the shared Summary preference. */
export function buildScmDiffSummaryModelProfiles(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    models: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'capabilities'>[];
    agentFormats?: readonly string[] | null;
}>): readonly ScmDiffSummaryCatalogProfile[] {
    return params.models.map(model => {
        const modelSelector = { backendTargetKey: buildBackendTargetKeyV2(params.backendTarget), modelId: model.id };
        return { catalogId: encodeScmDiffSummaryModelOverride(modelSelector), title: model.name, modelSelector,
            structuredOutput: resolveModelStructuredOutputSupport({ model, catalogModel: true, agentFormats: params.agentFormats }) };
    });
}
