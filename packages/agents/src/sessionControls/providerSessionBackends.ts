import { resolveAgentRuntimeControlSurface, type AgentRuntimeKind } from '../runtimeKinds.js';
import type { AgentCoreRuntimeControlSurface, AgentId } from '../types.js';
import { getProviderSessionControlAdapter } from '../providers/sessionControlAdapterRegistry.js';

function resolveAgentRuntimeSurface(agentId: AgentId, runtimeKind: AgentRuntimeKind | null): AgentCoreRuntimeControlSurface {
  return resolveAgentRuntimeControlSurface(agentId, runtimeKind as never);
}

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

export function resolveCodexSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): 'mcp' | 'acp' | 'appServer' | null {
  const adapter = getProviderSessionControlAdapter('codex');
  const persistedKind = adapter?.resolvePersistedSessionRuntimeKind?.(params.metadata) ?? null;
  if (persistedKind === 'mcp' || persistedKind === 'acp' || persistedKind === 'appServer') {
    return persistedKind;
  }

  const configuredKind = resolveAgentConfiguredRuntimeKind({ agentId: 'codex', accountSettings: params.accountSettings });
  return configuredKind === 'mcp' || configuredKind === 'acp' || configuredKind === 'appServer'
    ? configuredKind
    : null;
}

export function resolveOpenCodeSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): 'server' | 'acp' | null {
  const adapter = getProviderSessionControlAdapter('opencode');
  const persistedKind = adapter?.resolvePersistedSessionRuntimeKind?.(params.metadata) ?? null;
  if (persistedKind === 'server' || persistedKind === 'acp') {
    return persistedKind;
  }

  const configuredKind = resolveAgentConfiguredRuntimeKind({ agentId: 'opencode', accountSettings: params.accountSettings });
  return configuredKind === 'server' || configuredKind === 'acp' ? configuredKind : null;
}

export function resolveAgentRuntimeControlSurfaceForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): AgentCoreRuntimeControlSurface | null {
  const adapter = getProviderSessionControlAdapter(params.agentId);
  if (!adapter) return null;

  const runtimeKind = adapter.resolvePersistedSessionRuntimeKind?.(params.metadata)
    ?? resolveAgentConfiguredRuntimeKind({ agentId: params.agentId, accountSettings: params.accountSettings });
  return resolveAgentRuntimeSurface(params.agentId, runtimeKind);
}
