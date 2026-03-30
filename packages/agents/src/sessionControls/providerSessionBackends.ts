import { normalizeOpenCodeBackendMode } from '../providerSettings/definitions/opencode.js';
import { normalizeCodexBackendMode, resolveCodexRuntimeBackendMode } from '../providerSettings/definitions/codex.js';
import { resolveAgentRuntimeControlSurface, resolveDefaultAgentRuntimeKind, type AgentRuntimeKind } from '../runtimeKinds.js';
import type { AgentCoreRuntimeControlSurface, AgentId } from '../types.js';
import { resolvePersistedCodexRuntimeIdentity } from './codexRuntimeIdentity.js';
import { readOpenCodeSessionAffinityFromMetadata } from './opencodeSessionRuntimeHandle.js';

export function normalizeAgentRuntimeKindOverride(params: Readonly<{
  agentId: AgentId;
  value: unknown;
}>): AgentRuntimeKind | null {
  if (params.agentId === 'codex') {
    return normalizeCodexBackendMode(params.value);
  }

  const normalized = typeof params.value === 'string' ? params.value.trim() : '';
  if (!normalized) return null;

  if (params.agentId === 'opencode') {
    return normalized === 'server' || normalized === 'acp'
      ? normalized
      : null;
  }

  return null;
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

  if (params.agentId === 'codex') {
    return {
      ...(params.accountSettings ?? {}),
      codexBackendMode: runtimeKind,
    };
  }

  if (params.agentId === 'opencode') {
    return {
      ...(params.accountSettings ?? {}),
      opencodeBackendMode: runtimeKind,
    };
  }

  return params.accountSettings;
}

export function resolveAgentConfiguredRuntimeKind(params: Readonly<{
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

  const configuredKind = resolveAgentConfiguredRuntimeKind({ agentId: 'codex', accountSettings: params.accountSettings });
  return normalizeCodexBackendMode(configuredKind);
}

export function resolveOpenCodeSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): 'server' | 'acp' | null {
  const persistedMode = readOpenCodeSessionAffinityFromMetadata(params.metadata).backendMode;
  if (persistedMode === 'server' || persistedMode === 'acp') {
    return persistedMode;
  }

  const configuredKind = resolveAgentConfiguredRuntimeKind({ agentId: 'opencode', accountSettings: params.accountSettings });
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
        const configured = resolveAgentConfiguredRuntimeKind({ agentId: 'codex', accountSettings: params.accountSettings });
        return normalizeCodexBackendMode(configured);
      })();
    return resolveAgentRuntimeControlSurface('codex', runtimeKind);
  }

  if (params.agentId === 'opencode') {
    const runtimeKind = readOpenCodeSessionAffinityFromMetadata(params.metadata).backendMode
      ?? (() => {
        const configured = resolveAgentConfiguredRuntimeKind({ agentId: 'opencode', accountSettings: params.accountSettings });
        return configured === 'server' || configured === 'acp' ? configured : null;
      })();
    return resolveAgentRuntimeControlSurface('opencode', runtimeKind);
  }

  return null;
}
