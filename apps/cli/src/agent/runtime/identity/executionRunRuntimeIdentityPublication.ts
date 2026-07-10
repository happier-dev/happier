import type { AgentMessage } from '@/agent/core/AgentMessage';
import {
  type ExecutionRunHostRuntime,
  type ExecutionRunHostRuntimeMessageHandler,
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
    descriptorSchemaId: 'happier.executionRunRuntimeIdentity',
    includeExecutionRun: true,
  });
}

export function withExecutionRunRuntimeIdentityPublication(params: Readonly<{
  runtime: ExecutionRunHostRuntime;
  identity: EngineRuntimePublication;
}>): ExecutionRunHostRuntime {
  const hub = createNormalizedRuntimeEventPublicationHub<AgentMessage>({
    identity: params.identity,
    subscribeUpstream: (handler) => params.runtime.subscribeMessages(handler),
  });

  return wrapExecutionRunHostRuntime({
    readPermissionCapability: () => params.runtime.permissionCapability,
    readResumeSupport: (opts) => params.runtime.readResumeSupport(opts),
    async provisionSession(opts) {
      hub.ensureUpstreamRegistered();
      const started = await params.runtime.provisionSession(opts);
      hub.publishFallbackIdentity();
      return started;
    },
    sendPrompt: (sessionId, prompt, meta) => params.runtime.sendPrompt(sessionId, prompt, meta),
    readSendSteerPrompt: () => params.runtime.sendSteerPrompt,
    cancel: (sessionId) => params.runtime.cancel(sessionId),
    subscribeMessages: (handler) => hub.subscribe(handler),
    readRespondToPermission: () => params.runtime.permissionCapability === 'responds'
      ? params.runtime.respondToPermission
      : undefined,
    readWaitForTurnCompletion: () => params.runtime.waitForTurnCompletion,
    readProbeTurnLiveness: () => params.runtime.probeTurnLiveness,
    async dispose() {
      hub.dispose();
      await params.runtime.dispose();
    },
  });
}
