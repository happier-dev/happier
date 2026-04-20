import type { AgentMessage } from '@/agent/core';
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

  return {
    async readResumeSupport(opts) {
      return await params.runtime.readResumeSupport(opts);
    },
    async provisionSession(opts) {
      hub.ensureUpstreamRegistered();
      const started = await params.runtime.provisionSession(opts);
      hub.publishFallbackIdentity();
      return started;
    },
    async sendPrompt(sessionId, prompt) {
      await params.runtime.sendPrompt(sessionId, prompt);
    },
    ...(typeof params.runtime.sendSteerPrompt === 'function'
      ? {
          async sendSteerPrompt(sessionId: string, prompt: string) {
            await params.runtime.sendSteerPrompt!(sessionId, prompt);
          },
        }
      : {}),
    async cancel(sessionId) {
      await params.runtime.cancel(sessionId);
    },
    subscribeMessages(handler) {
      return hub.subscribe(handler);
    },
    ...(typeof params.runtime.respondToPermission === 'function'
      ? {
          async respondToPermission(requestId: string, approved: boolean) {
            await params.runtime.respondToPermission!(requestId, approved);
          },
        }
      : {}),
    ...(typeof params.runtime.waitForTurnCompletion === 'function'
      ? {
          async waitForTurnCompletion(timeoutMs?: number | null) {
            await params.runtime.waitForTurnCompletion!(timeoutMs);
          },
        }
      : {}),
    async dispose() {
      hub.dispose();
      await params.runtime.dispose();
    },
  };
}
