import { resolveAgentRuntimeControlSurface, type AgentRuntimeKind } from '../runtimeKinds.js';
import type { AgentId } from '../types.js';
import { getProviderSessionControlAdapter } from '../runtime/controlSurface/sessionControlAdapterRegistry.js';
import type { RuntimeControlSurface } from '../runtime/engine/contracts.js';

function resolveAgentRuntimeSurface(agentId: AgentId, runtimeKind: AgentRuntimeKind | null): RuntimeControlSurface {
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
}>): RuntimeControlSurface | null {
  // This is the live shared owner for effective session control-surface resolution. Keep bridge
  // consumers pointing here instead of reintroducing a bridge-local `resolveRuntimeControlSurface`.
  const adapter = getProviderSessionControlAdapter(params.agentId);
  const runtimeKind = adapter?.resolvePersistedSessionRuntimeKind?.(params.metadata)
    ?? (adapter ? resolveAgentConfiguredRuntimeKind({ agentId: params.agentId, accountSettings: params.accountSettings }) : null);
  return resolveAgentRuntimeSurface(params.agentId, runtimeKind);
}
