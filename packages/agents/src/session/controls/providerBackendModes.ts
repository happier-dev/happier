import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';
import type { AgentId } from '../../types.js';
import type { AgentRuntimeKind } from '../../runtimeKinds.js';

import { resolveAgentConfiguredRuntimeKind } from './runtimeKindOverride.js';

export function resolveProviderSessionBackendMode(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): AgentRuntimeKind | null {
  const adapter = getProviderSessionControlAdapter(params.agentId);
  return adapter?.resolvePersistedSessionRuntimeKind?.(params.metadata)
    ?? (adapter ? resolveAgentConfiguredRuntimeKind({
    agentId: params.agentId,
    accountSettings: params.accountSettings,
  }) : null);
}
