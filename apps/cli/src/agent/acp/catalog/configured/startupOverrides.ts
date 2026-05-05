import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export function resolveConfiguredAcpBackendStartupOverrides(
  opts: HostSessionRuntimeRunOptions,
  backend: Pick<ResolvedConfiguredAcpBackend, 'defaultMode' | 'defaultModel'>,
): Pick<
  HostSessionRuntimeRunOptions,
  'sessionModeId' | 'sessionModeUpdatedAt' | 'modelId' | 'modelUpdatedAt'
> {
  const effectiveSessionModeId = opts.sessionModeId ?? backend.defaultMode;
  const effectiveSessionModeUpdatedAt = effectiveSessionModeId
    ? (opts.sessionModeUpdatedAt ?? Date.now())
    : opts.sessionModeUpdatedAt;
  const effectiveModelId = opts.modelId ?? backend.defaultModel;
  const effectiveModelUpdatedAt = effectiveModelId
    ? (opts.modelUpdatedAt ?? Date.now())
    : opts.modelUpdatedAt;

  return {
    ...(effectiveSessionModeId ? { sessionModeId: effectiveSessionModeId, sessionModeUpdatedAt: effectiveSessionModeUpdatedAt } : {}),
    ...(effectiveModelId ? { modelId: effectiveModelId, modelUpdatedAt: effectiveModelUpdatedAt } : {}),
  };
}
