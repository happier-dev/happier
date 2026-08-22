import { resolveAgentRuntimeControlSurface, type AgentRuntimeKind } from '../../runtimeKinds.js';
import type { AgentId } from '../../types.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';
import type { RuntimeControlSurface } from '../../runtime/engine/contracts.js';

import { resolveAgentConfiguredRuntimeKind } from './runtimeKindOverride.js';

function resolveAgentRuntimeSurface(agentId: AgentId, runtimeKind: AgentRuntimeKind | null): RuntimeControlSurface | null {
  return resolveAgentRuntimeControlSurface(agentId, runtimeKind as never);
}

export function resolveAgentRuntimeControlSurfaceForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): RuntimeControlSurface | null {
  // This is the live shared owner for effective session control-surface resolution. Keep bridge
  // consumers pointing here instead of reintroducing a bridge-local `resolveRuntimeControlSurface`.
  const adapter = getProviderSessionControlAdapter(params.agentId);
  const runtimeKind = adapter?.resolvePersistedSessionRuntimeKind?.(params.metadata)
    ?? (adapter ? resolveAgentConfiguredRuntimeKind({ agentId: params.agentId, accountSettings: params.accountSettings }) : null);
  return resolveAgentRuntimeSurface(params.agentId, runtimeKind);
}
