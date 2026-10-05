import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { resolveExecutionRunRuntimeBackendId } from './backendTargets';
import type { ExecutionRunManagerStartParams } from './executionRunTypes';

type ModelAdmissionParams = Pick<ExecutionRunManagerStartParams,
  'backendTarget' | 'modelId' | 'modelSelection' | 'teamCredentialModel' | 'cwd'
  | 'accountSettings' | 'promptCredentials' | 'runtimeDescriptorV1'>;

/** Admission consumes the same actual offered-model truth published by the probe. */
export async function readExecutionRunOfferedModel(params: ModelAdmissionParams) {
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  // A Provider/Team model must supply its own evidence; a native catalog cannot
  // grant that distinct source the Agent's native JSON contract.
  if (!params.teamCredentialModel && !params.modelSelection?.providerConnectionId) {
    try {
      const agentId = resolveExecutionRunRuntimeBackendId(params.backendTarget);
      return await withAgentPreflightCatalog({ agentId }, async ({ catalogEntry, runtimeCacheKey }) => {
        const catalog = await probeAgentModelsBestEffort({
          agentId, catalogEntry, runtimeCacheKey, backendTarget: params.backendTarget,
          cwd: params.cwd ?? process.cwd(), accountSettings: params.accountSettings,
          credentials: params.promptCredentials, runtimeDescriptorV1: params.runtimeDescriptorV1,
        });
        return catalog.source === 'unavailable' ? undefined
          : catalog.availableModels.find((model) => model.id === modelId);
      });
    } catch {
      // An unavailable catalog is not evidence of structured publication support.
      return undefined;
    }
  }
  return undefined;
}

export async function assertExecutionRunStructuredOutputModelAllowed(params: ModelAdmissionParams): Promise<void> {
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  const support = (await readExecutionRunOfferedModel(params))?.capabilities?.structuredOutput ?? 'unknown';
  if (support !== 'supported') {
    throw Object.assign(new Error('The selected model does not establish structured JSON output support.'), {
      code: 'model_structured_output_unsupported',
      details: { modelId, structuredOutput: support },
    });
  }
}
