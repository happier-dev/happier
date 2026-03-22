import { normalizeOpenCodeBackendMode } from '../providerSettings/definitions/opencode.js';
import { resolveCodexRuntimeBackendMode } from '../providerSettings/definitions/codex.js';
import { resolveAgentRuntimeControlSurface, resolveDefaultAgentRuntimeKind, type AgentRuntimeKind } from '../runtimeKinds.js';
import type { AgentCoreRuntimeControlSurface, AgentId } from '../types.js';
import { resolvePersistedCodexRuntimeIdentity } from './codexRuntimeIdentity.js';
import { readOpenCodeSessionAffinityFromMetadata } from './opencodeSessionRuntimeHandle.js';

function resolveConfiguredAgentRuntimeKind(params: Readonly<{
  agentId: AgentId;
  accountSettings?: Record<string, unknown> | null;
}>): AgentRuntimeKind | null {
  if (params.agentId === 'codex') {
    return resolveCodexRuntimeBackendMode({
      codexBackendMode: params.accountSettings?.codexBackendMode,
      experimentalCodexAcp: params.accountSettings?.experimentalCodexAcp === true,
      defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
    });
  }

  if (params.agentId === 'opencode') {
    return normalizeOpenCodeBackendMode(params.accountSettings?.opencodeBackendMode);
  }

  return null;
}

export function resolveCodexSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): 'mcp' | 'acp' | 'appServer' | null {
  const persistedIdentity = resolvePersistedCodexRuntimeIdentity(params.metadata);
  if (persistedIdentity) {
    return persistedIdentity.backendMode;
  }

  const configuredKind = resolveConfiguredAgentRuntimeKind({ agentId: 'codex', accountSettings: params.accountSettings });
  return configuredKind === 'mcp' || configuredKind === 'acp' || configuredKind === 'appServer' ? configuredKind : null;
}

export function resolveOpenCodeSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): 'server' | 'acp' | null {
  const persistedMode = readOpenCodeSessionAffinityFromMetadata(params.metadata).backendMode;
  if (persistedMode === 'server' || persistedMode === 'acp') {
    return persistedMode;
  }

  const configuredKind = resolveConfiguredAgentRuntimeKind({ agentId: 'opencode', accountSettings: params.accountSettings });
  return configuredKind === 'server' || configuredKind === 'acp' ? configuredKind : null;
}

export function resolveAgentRuntimeControlSurfaceForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): AgentCoreRuntimeControlSurface | null {
  if (params.agentId === 'codex') {
    const runtimeKind = resolvePersistedCodexRuntimeIdentity(params.metadata)?.backendMode
      ?? (() => {
        const configured = resolveConfiguredAgentRuntimeKind({ agentId: 'codex', accountSettings: params.accountSettings });
        return configured === 'mcp' || configured === 'acp' || configured === 'appServer' ? configured : null;
      })();
    return resolveAgentRuntimeControlSurface('codex', runtimeKind);
  }

  if (params.agentId === 'opencode') {
    const runtimeKind = readOpenCodeSessionAffinityFromMetadata(params.metadata).backendMode
      ?? (() => {
        const configured = resolveConfiguredAgentRuntimeKind({ agentId: 'opencode', accountSettings: params.accountSettings });
        return configured === 'server' || configured === 'acp' ? configured : null;
      })();
    return resolveAgentRuntimeControlSurface('opencode', runtimeKind);
  }

  return null;
}
