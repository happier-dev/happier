import type {
  BackendExecutionSurfaces,
  CliEngineAdapter,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { ResolvedBackendContribution, ResolvedProviderContribution } from '@/extensions/registry/types';
import { buildClaudeRemoteOutgoingMessageMetaExtras } from '@happier-dev/agents';

import { createClaudeExecutionRunBinding } from './executionRuns';
import { createClaudeSessionBinding } from './session';

export function createClaudeBindings(params: Readonly<{
  backend: ResolvedBackendContribution;
  provider: ResolvedProviderContribution;
  executionSurfaces: BackendExecutionSurfaces;
}>): CliEngineAdapter {
  void params.backend;
  void params.provider;
  void params.executionSurfaces;

  return Object.freeze({
    bindings: Object.freeze({
      createSessionRuntime: createClaudeSessionBinding,
      createExecutionRunBackend: createClaudeExecutionRunBinding,
    }),
    messageMeta: Object.freeze({
      buildOutgoingMessageMetaExtras: buildClaudeRemoteOutgoingMessageMetaExtras,
    }),
  });
}
