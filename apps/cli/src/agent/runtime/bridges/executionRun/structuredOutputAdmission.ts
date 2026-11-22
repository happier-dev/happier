import { isSessionModelRefSourceBound } from '@happier-dev/protocol/providers/selection/v2';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import type { CliProbeDependencies } from '@/capabilities/probes/agentPreflight';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { resolveExecutionRunRuntimeBackendId } from './backendTargets';
import type { ExecutionRunManagerStartParams } from './executionRunTypes';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';
import { readExecutionRunErrorCode } from './errors';
import { resolveModelStructuredOutputSupport, type AgentModelDescriptor } from '@happier-dev/protocol/models/descriptor';
import { sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { projectObservedNativeModelCatalog } from '@/providers/modelManagement/nativeModelObservation';

type ModelAdmissionParams = Pick<ExecutionRunManagerStartParams,
  'backendTarget' | 'modelId' | 'modelSelection' | 'teamCredentialModel' | 'cwd'
  | 'accountSettings' | 'promptCredentials' | 'runtimeDescriptorV1' | 'readNativeOfferedModel' | 'nativeOfferedModel'
  | 'connectedServices' | 'secretReferenceOverlay' | 'signal'> & Readonly<{
    /** Already prepared for this exact Provider/Team runtime; never a new acquisition. */
    prepared?: Readonly<{ providerBinding?: Readonly<{ model: AgentModelDescriptor }> }>;
  }>;

export function usesExecutionRunProviderModel(params: Pick<ModelAdmissionParams, 'modelSelection' | 'teamCredentialModel'>): boolean {
  return Boolean(params.teamCredentialModel || (params.modelSelection && isSessionModelRefSourceBound(params.modelSelection)));
}

export async function assertExecutionRunStructuredAnalysisModelAllowed(params: ModelAdmissionParams & Readonly<{ intent?: string }>): Promise<void> {
  // Reviews retain the prompt/parse/repair path when native JSON is unavailable.
  if (params.intent !== 'scm_diff_summary') return;
  await assertExecutionRunStructuredOutputModelAllowed(params);
}

export function modelCatalogUnavailable(modelId: string, reason: string, causeCode?: string): Error {
  const code = 'model_catalog_unavailable';
  return Object.assign(new Error('The selected model catalog could not be read.'), {
    code,
    rpcErrorCode: code,
    details: { modelId, reason, ...(causeCode ? { causeCode } : {}) },
  });
}

export function findNativeExecutionRunOfferedModel(models: readonly AgentModelDescriptor[], modelId: string): AgentModelDescriptor | undefined {
  const model = models.find(model => model.id === modelId);
  if (model) return model;
  const variant = models.find(model => model.extendedContextModelId === modelId);
  if (!variant) return undefined;
  // An explicitly offered variant does not inherit its base model's context size.
  const { contextWindowTokens: _baseWindow, extendedContextModelId: _variantId, ...facts } = variant;
  return { ...facts, id: modelId };
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
    machineId?: string;
    readProviderModels?: (request: DaemonProviderModelProjectionRequestV1) => Promise<DaemonProviderModelProjectionResponseV1>;
    preflightDependencies?: Pick<CliProbeDependencies, 'createApiClient' | 'activatePurposeBindings' | 'connectedAccountsOwner' | 'savedSecretOperationContext'>;
  }>) {
  if (params.connectedServices && !params.runtimeDescriptorV1 && params.machineId && params.readProviderModels) {
    const agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(params.backendTarget));
    const projection = await params.readProviderModels({ machineId: params.machineId, agentTargetKey,
      connectedServices: params.connectedServices, mode: 'picker' });
    const catalog = projectObservedNativeModelCatalog(projection, agentTargetKey);
    if (catalog) return findNativeExecutionRunOfferedModel(catalog.availableModels, params.modelId);
  }
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
  if (catalog.data.source === 'unavailable') {
    if (catalog.data.refreshError || catalog.data.failureCause || catalog.data.spawnFailure) {
      throw modelCatalogUnavailable(params.modelId, 'catalog_unavailable');
    }
    return undefined;
  }
  const model = findNativeExecutionRunOfferedModel(catalog.data.availableModels, params.modelId);
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
  if (!usesExecutionRunProviderModel(params)) {
    if (params.nativeOfferedModel?.id === modelId) return params.nativeOfferedModel;
    try {
      const request = { backendTarget: params.backendTarget, modelId, cwd: params.cwd ?? sessionWorkingDirectory(),
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
  const model = await readExecutionRunOfferedModel(params);
  const support = resolveModelStructuredOutputSupport({ model, catalogModel: Boolean(model) });
  if (support !== 'supported') {
    const code = 'model_structured_output_unsupported';
    throw Object.assign(new Error('The selected model does not establish structured JSON output support.'), {
      code,
      rpcErrorCode: code,
      details: { modelId, structuredOutput: support },
    });
  }
}

/** Models may receive a schema hint; only transports with a mapping apply it. */
export async function readExecutionRunSelectedModelStructuredOutputSupport(params: ModelAdmissionParams): Promise<boolean> {
  params.signal?.throwIfAborted();
  const model = params.prepared?.providerBinding?.model ?? await readExecutionRunOfferedModel(params);
  return model?.capabilities?.structuredOutput === 'supported';
}
