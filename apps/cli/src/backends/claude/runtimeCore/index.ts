import type {
  BackendExecutionSurfaces,
  CliEngineAdapter,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { ResolvedBackendContribution, ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from '@happier-dev/agents';

import { createClaudeExecutionRunRuntime } from './executionRuns';
import { createClaudeSessionRuntime } from './session';

export function createClaudeRuntimeCore(params: Readonly<{
  backend: ResolvedBackendContribution;
  provider: ResolvedProviderContribution;
  executionSurfaces: BackendExecutionSurfaces;
}>): CliEngineAdapter {
  void params.backend;
  void params.provider;
  void params.executionSurfaces;

  return Object.freeze({
    runtimeCore: Object.freeze({
      createSessionRuntime: createClaudeSessionRuntime,
      createExecutionRunBackend: createClaudeExecutionRunRuntime,
    }),
    messageMeta: Object.freeze({
      buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
    }),
  });
}
