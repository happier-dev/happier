import type { AgentMessage } from '@/agent/core/AgentMessage';
import {
  type ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { EngineAdapterResolution } from '@/agent/runtime/registry/engineRegistryTypes';
import { createNormalizedRuntimeEventPublicationHub } from '@/agent/runtime/events/createNormalizedRuntimeEventPublicationHub';
import {
  buildRuntimePublicationFromEngineResolution,
  type EngineRuntimePublication,
} from '@/agent/runtime/identity/buildRuntimePublicationFromEngineResolution';
import { wrapExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/wrap';

export function buildExecutionRunRuntimeIdentityPublication(
  resolution: EngineAdapterResolution,
): EngineRuntimePublication {
  return buildRuntimePublicationFromEngineResolution(resolution, {
    includeExecutionRun: true,
  });
}

export function withExecutionRunRuntimeIdentityPublication(params: Readonly<{
  runtime: ExecutionRunHostRuntime;
  identity: EngineRuntimePublication;
  modelContextWindowTokens?: number;
}>): ExecutionRunHostRuntime {
  const hub = createNormalizedRuntimeEventPublicationHub<AgentMessage>({
    identity: params.identity,
    subscribeUpstream: (handler) => params.runtime.subscribeMessages(handler),
    // The execution-run bridge speaks the legacy host-private `AgentMessage`
    // family, whose generic `EventMessage` member is a real member of that
    // union and whose session-state emitter already reads these facts there.
    mirrorIdentityPublicationToMessageStream: true,
  });

  return wrapExecutionRunHostRuntime({
    readPermissionCapability: () => params.runtime.permissionCapability,
    readPendingPermissionRequests: () => params.runtime.readPendingPermissionRequests?.bind(params.runtime),
    readInteraction: () => params.runtime.interaction,
    readExecuteAction: () => params.runtime.executeAction?.bind(params.runtime),
    readToolNormalizationSource: () => params.runtime.toolNormalizationSource,
    readResumeSupport: (opts) => params.runtime.readResumeSupport(opts),
    readPrepareInputBudget: () => params.runtime.prepareInputBudget?.bind(params.runtime),
    readModelContextWindowTokens: () => () => params.modelContextWindowTokens,
    readProviderSessionId: () => params.runtime.readProviderSessionId?.bind(params.runtime),
    readCanContinueAfterCancellation: () => params.runtime.canContinueAfterCancellation?.bind(params.runtime),
    async provisionRuntime(opts) {
      hub.ensureUpstreamRegistered();
      const started = await params.runtime.provisionRuntime(opts);
      hub.publishFallbackIdentity();
      return started;
    },
    deliverInput: (runtimeId, input, context) => params.runtime.deliverInput(runtimeId, input, context),
    readSteerInput: () => params.runtime.steerInput?.bind(params.runtime),
    getRuntimeLifetimeSignal: () => params.runtime.getRuntimeLifetimeSignal(),
    readSubscribeProviderInputOutcomes: () => params.runtime.subscribeProviderInputOutcomes?.bind(params.runtime),
    readSubscribeRuntimeEvents: () => params.runtime.subscribeRuntimeEvents?.bind(params.runtime),
    readActiveTurnAdmissionWitness: () => params.runtime.readActiveTurnAdmissionWitness?.bind(params.runtime),
    cancel: (runtimeId) => params.runtime.cancel(runtimeId),
    subscribeMessages: (handler) => hub.subscribe(handler),
    readRespondToPermission: () => params.runtime.permissionCapability === 'responds'
      ? params.runtime.respondToPermission
      : undefined,
    readAbortPendingPermissionRequests: () => params.runtime.abortPendingPermissionRequests?.bind(params.runtime),
    readWaitForTurnCompletion: () => params.runtime.waitForTurnCompletion,
    readProbeTurnLiveness: () => params.runtime.probeTurnLiveness,
    async dispose() {
      hub.dispose();
      await params.runtime.dispose();
    },
  });
}
