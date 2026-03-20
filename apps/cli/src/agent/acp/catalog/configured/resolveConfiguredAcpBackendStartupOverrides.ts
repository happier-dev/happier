import type { StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';

export function resolveConfiguredAcpBackendStartupOverrides(
  opts: StandardAcpProviderRunOptions,
  backend: Pick<ResolvedConfiguredAcpBackend, 'defaultMode' | 'defaultModel'>,
): Pick<
  StandardAcpProviderRunOptions,
  'agentModeId' | 'agentModeUpdatedAt' | 'modelId' | 'modelUpdatedAt'
> {
  const effectiveAgentModeId = opts.agentModeId ?? backend.defaultMode;
  const effectiveAgentModeUpdatedAt = effectiveAgentModeId
    ? (opts.agentModeUpdatedAt ?? Date.now())
    : opts.agentModeUpdatedAt;
  const effectiveModelId = opts.modelId ?? backend.defaultModel;
  const effectiveModelUpdatedAt = effectiveModelId
    ? (opts.modelUpdatedAt ?? Date.now())
    : opts.modelUpdatedAt;

  return {
    ...(effectiveAgentModeId ? { agentModeId: effectiveAgentModeId, agentModeUpdatedAt: effectiveAgentModeUpdatedAt } : {}),
    ...(effectiveModelId ? { modelId: effectiveModelId, modelUpdatedAt: effectiveModelUpdatedAt } : {}),
  };
}
