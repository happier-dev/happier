import { type AgentRuntimeKind, resolveDefaultAgentRuntimeKind } from '../../runtimeKinds.js';
import {
  isCodexVendorResumeBackendEnabled,
  resolveCodexRuntimeBackendModeFromSettings,
} from '../../runtime/preferences/codex.js';
import { normalizeCodexBackendMode } from '../../providerSettings/definitions/codex.js';
import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
} from './runtimeIdentity.js';

function resolveCodexConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
  return resolveCodexRuntimeBackendModeFromSettings(accountSettings ?? {}, {
    defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
  });
}

function resolveCodexPersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
  return resolvePersistedCodexRuntimeIdentity(metadata)?.backendMode ?? null;
}

function resolveCodexVendorResumeId(metadata: unknown): string | null {
  return resolvePersistedCodexVendorSessionId(metadata);
}

function isCodexExperimentalVendorResumeEnabled(input: Readonly<{
  metadata: unknown;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  const runtimeKind = resolvePersistedCodexRuntimeIdentity(input.metadata)?.backendMode
    ?? resolveCodexRuntimeBackendModeFromSettings(input.accountSettings ?? {}, {
      defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
    });
  return isCodexVendorResumeBackendEnabled(runtimeKind ? { codexBackendMode: runtimeKind } : {});
}

function isCodexExperimentalVendorHandoffEnabled(input: Readonly<{
  metadata: unknown;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
  if (runtimeIdentity?.backendMode === 'acp' || runtimeIdentity?.backendMode === 'appServer') {
    return true;
  }
  return isCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
}

export const CODEX_SESSION_CONTROL_ADAPTER = Object.freeze({
  normalizeRuntimeKindOverride(value: unknown): AgentRuntimeKind | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return null;
    const normalized = normalizeCodexBackendMode(trimmed);
    return trimmed === 'mcp'
      || trimmed === 'acp'
      || trimmed === 'appServer'
      || trimmed === 'mcp_resume'
      ? normalized
      : null;
  },
  applyRuntimeKindOverrideToAccountSettings(
    accountSettings: Record<string, unknown> | null,
    runtimeKind: AgentRuntimeKind,
  ): Record<string, unknown> {
    return {
      ...(accountSettings ?? {}),
      codexBackendMode: runtimeKind,
    };
  },
  resolveConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
    return resolveCodexConfiguredRuntimeKind(accountSettings);
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
    return resolveCodexPersistedSessionRuntimeKind(metadata);
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return resolveCodexVendorResumeId(metadata);
  },
  isExperimentalVendorResumeEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    return isCodexExperimentalVendorResumeEnabled(input);
  },
  isExperimentalVendorHandoffEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    return isCodexExperimentalVendorHandoffEnabled(input);
  },
});
