import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import type { CliProbeDependencies } from '@/capabilities/probes/agentPreflight';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { resolveExecutionRunRuntimeBackendId } from './backendTargets';
import type { ExecutionRunManagerStartParams } from './executionRunTypes';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';
import { readExecutionRunErrorCode } from './errors';
import type { AgentModelDescriptor } from '@happier-dev/protocol/models/descriptor';

type ModelAdmissionParams = Pick<ExecutionRunManagerStartParams,
  'backendTarget' | 'modelId' | 'modelSelection' | 'teamCredentialModel' | 'cwd'
  | 'accountSettings' | 'promptCredentials' | 'runtimeDescriptorV1' | 'readNativeOfferedModel'
  | 'connectedServices' | 'secretReferenceOverlay' | 'signal'> & Readonly<{
    /** Already prepared for this exact Provider/Team runtime; never a new acquisition. */
    prepared?: Readonly<{ providerBinding?: Readonly<{ model: AgentModelDescriptor }> }>;
  }>;

function modelCatalogUnavailable(modelId: string, reason: string, causeCode?: string): Error {
  const code = 'model_catalog_unavailable';
  return Object.assign(new Error('The selected model catalog could not be read.'), {
    code,
    rpcErrorCode: code,
    details: { modelId, reason, ...(causeCode ? { causeCode } : {}) },
  });
}

/** One probe owner serves both daemon-retained and ordinary native admission. */
export async function readNativeExecutionRunOfferedModel(params: Parameters<NonNullable<ExecutionRunManagerStartParams['readNativeOfferedModel']>>[0]
  & Pick<ExecutionRunManagerStartParams, 'accountSettings' | 'promptCredentials'> & Readonly<{
    catalogEntry?: AgentCatalogEntry | null;
    runtimeCacheKey?: string;
    registrySnapshot?: ResolvedContributionRegistry;
    signal?: AbortSignal;
    createAgentInvocationServices?: CreateAgentInvocationServices;
    isCurrent?: () => boolean;
    preflightDependencies?: Pick<CliProbeDependencies, 'createApiClient' | 'activatePurposeBindings' | 'connectedAccountsOwner'>;
  }>) {
  const agentId = resolveExecutionRunRuntimeBackendId(params.backendTarget);
  // Structured-output runs are rare; the probe owner loads on the first one.
  const { invokeCliPreflightMethod } = await import('@/capabilities/probes/agentPreflight');
  const response = await invokeCliPreflightMethod(agentId, 'probeModels', {
    backendTarget: params.backendTarget, cwd: params.cwd, runtimeDescriptorV1: params.runtimeDescriptorV1,
    connectedServices: params.connectedServices,
    secretReferenceOverlay: params.secretReferenceOverlay,
  }, {
    ...params.preflightDependencies,
    createApiClient: params.preflightDependencies?.createApiClient
      ?? (async credentials => (await import('@/api/api')).ApiClient.create(credentials)),
    accountContext: { credentials: params.promptCredentials ?? null, accountSettings: params.accountSettings ?? null },
    agentCatalogEntry: params.catalogEntry, agentRuntimeCacheKey: params.runtimeCacheKey,
    agentRegistrySnapshot: params.registrySnapshot,
    createAgentInvocationServices: params.createAgentInvocationServices,
    isAgentRegistryCurrent: params.isCurrent,
  }, { signal: params.signal });
  if (!response.ok) throw modelCatalogUnavailable(params.modelId, 'preflight_failed', response.error.code);
  const catalog = AgentModelsProbeObservationSchema.safeParse(response.result);
  if (!catalog.success || catalog.data.agentId !== agentId) {
    throw modelCatalogUnavailable(params.modelId, 'invalid_catalog');
  }
  if (catalog.data.source === 'unavailable') throw modelCatalogUnavailable(params.modelId, 'catalog_unavailable');
  let model = catalog.data.availableModels.find(model => model.id === params.modelId);
  if (!model) {
    const variant = catalog.data.availableModels.find(model => model.extendedContextModelId === params.modelId);
    if (variant) {
      // This is an explicitly offered variant, not a freeform suffix. Its base
      // model's window does not establish the variant's actual context size.
      const { contextWindowTokens: _baseWindow, extendedContextModelId: _variantId, ...facts } = variant;
      model = { ...facts, id: params.modelId };
    }
  }
  // A failed refresh does not erase a published model fact. Structured-output
  // support is a separate admission decision, not a condition for reading it.
  if (catalog.data.refreshError && !model) {
    throw modelCatalogUnavailable(params.modelId, 'catalog_refresh_failed');
  }
  return model;
}

/** Admission consumes the same actual offered-model truth published by the probe. */
export async function readExecutionRunOfferedModel(params: ModelAdmissionParams) {
  params.signal?.throwIfAborted();
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  // A Provider/Team model must supply its own evidence; a native catalog cannot
  // grant that distinct source the Agent's native JSON contract.
  if (!params.teamCredentialModel && !params.modelSelection?.providerConnectionId) {
    try {
      const request = { backendTarget: params.backendTarget, modelId, cwd: params.cwd ?? process.cwd(),
        ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
        ...(params.secretReferenceOverlay ? { secretReferenceOverlay: params.secretReferenceOverlay } : {}),
        ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}) };
      if (params.readNativeOfferedModel) {
        const model = await params.readNativeOfferedModel(request, params.signal);
        params.signal?.throwIfAborted();
        return model?.id === modelId ? model : undefined;
      }
      const agentId = resolveExecutionRunRuntimeBackendId(params.backendTarget);
      return await withAgentPreflightCatalog({ agentId, signal: params.signal }, context => readNativeExecutionRunOfferedModel({
        ...params, ...request, ...context,
      }));
    } catch (error) {
      if (readExecutionRunErrorCode(error) || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw modelCatalogUnavailable(modelId, 'catalog_read_failed');
    }
  }
  const model = params.prepared?.providerBinding?.model;
  return model?.id === modelId ? model : undefined;
}

export async function assertExecutionRunStructuredOutputModelAllowed(params: ModelAdmissionParams): Promise<void> {
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  const support = (await readExecutionRunOfferedModel(params))?.capabilities?.structuredOutput ?? 'unknown';
  if (support !== 'supported') {
    const code = 'model_structured_output_unsupported';
    throw Object.assign(new Error('The selected model does not establish structured JSON output support.'), {
      code,
      rpcErrorCode: code,
      details: { modelId, structuredOutput: support },
    });
  }
}
