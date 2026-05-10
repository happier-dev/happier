import { getProviderSessionControlAdapter } from '../../runtime/controlSurface/sessionControlAdapterRegistry.js';

import { resolveAgentConfiguredRuntimeKind } from './runtimeKindOverride.js';

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
