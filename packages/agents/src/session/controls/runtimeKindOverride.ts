import type { AgentId } from '../../types.js';
import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';
import type { AgentRuntimeKind } from '../../runtimeKinds.js';

export function normalizeAgentRuntimeKindOverride(params: Readonly<{
  agentId: AgentId;
  value: unknown;
}>): AgentRuntimeKind | null {
  const adapter = getProviderSessionControlAdapter(params.agentId);
  return adapter?.normalizeRuntimeKindOverride?.(params.value) ?? null;
}

export function applyAgentRuntimeKindOverrideToAccountSettings(params: Readonly<{
  agentId: AgentId;
  accountSettings: Record<string, unknown> | null;
  runtimeKindOverride: unknown;
}>): Record<string, unknown> | null {
  const runtimeKind = normalizeAgentRuntimeKindOverride({ agentId: params.agentId, value: params.runtimeKindOverride });
  if (!runtimeKind) {
    return params.accountSettings;
  }

  const adapter = getProviderSessionControlAdapter(params.agentId);
  return adapter?.applyRuntimeKindOverrideToAccountSettings
    ? adapter.applyRuntimeKindOverrideToAccountSettings(params.accountSettings, runtimeKind)
    : params.accountSettings;
}

export function resolveAgentConfiguredRuntimeKind(params: Readonly<{
  agentId: AgentId;
  accountSettings?: Record<string, unknown> | null;
}>): AgentRuntimeKind | null {
  const adapter = getProviderSessionControlAdapter(params.agentId);
  return adapter?.resolveConfiguredRuntimeKind?.(params.accountSettings) ?? null;
}
