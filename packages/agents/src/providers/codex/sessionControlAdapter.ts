import { type AgentRuntimeKind, resolveDefaultAgentRuntimeKind } from '../../runtimeKinds.js';
import {
  resolveCodexRuntimeBackendModeFromSettings,
} from '../../runtime/preferences/codex.js';
import { normalizeCodexBackendMode } from '../../providerSettings/definitions/codex.js';
import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexProviderSessionId,
} from './runtimeIdentity.js';

function resolveCodexConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
  const defaultBackendMode = normalizeCodexBackendMode(resolveDefaultAgentRuntimeKind('codex'));
  return resolveCodexRuntimeBackendModeFromSettings(accountSettings ?? {}, {
    defaultBackendMode,
  });
}

function resolveCodexPersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
  return resolvePersistedCodexRuntimeIdentity(metadata)?.backendMode ?? null;
}

function resolveCodexVendorResumeId(metadata: unknown): string | null {
  return resolvePersistedCodexProviderSessionId(metadata);
}

function isExplicitCodexVendorResumeBackendEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  if (typeof settings.codexBackendMode === 'string') {
    const trimmed = settings.codexBackendMode.trim();
    return trimmed === 'acp' || trimmed === 'appServer' || trimmed === 'mcp_resume';
  }
  return settings.experimentalCodexAcp === true;
}

function isCodexRuntimeIdentityVendorResumeBackendEnabled(mode: AgentRuntimeKind): boolean {
  return mode === 'acp' || mode === 'appServer';
}

function isCodexExperimentalVendorResumeEnabled(input: Readonly<{
  metadata: unknown;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
  if (runtimeIdentity) {
    return isCodexRuntimeIdentityVendorResumeBackendEnabled(runtimeIdentity.backendMode);
  }
  const runtimeKind = resolveCodexConfiguredRuntimeKind(input.accountSettings);
  return runtimeKind === 'acp' || runtimeKind === 'appServer'
    ? isExplicitCodexVendorResumeBackendEnabled(input.accountSettings ?? {})
    : false;
}

function isCodexExperimentalVendorHandoffEnabled(input: Readonly<{
  metadata: unknown;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
  if (runtimeIdentity?.backendMode === 'acp' || runtimeIdentity?.backendMode === 'appServer') {
    return true;
  }
  if (runtimeIdentity) return false;
  return isExplicitCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
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
    const codexBackendMode = normalizeCodexBackendMode(runtimeKind);
    return {
      ...(accountSettings ?? {}),
      ...(codexBackendMode ? { codexBackendMode } : {}),
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
