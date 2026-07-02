import {
  resolvePersistedCodexProviderSessionId,
  resolvePersistedCodexRuntimeIdentity,
} from '../../../identity/runtimeDescriptor.js';
import {
  type CodexBackendMode,
  normalizeCodexBackendMode,
} from '../../../../protocol/runtimeDescriptorV1.js';

type CodexRuntimeControlMode = CodexBackendMode | 'mcp';
type AgentRuntimeKind = CodexRuntimeControlMode | 'server';

const CODEX_DEFAULT_BACKEND_MODE: CodexBackendMode = 'appServer';

function resolveCodexRuntimeBackendMode(params: Readonly<{
  codexBackendMode?: unknown;
  defaultBackendMode?: CodexBackendMode | null;
}>): CodexBackendMode | null {
  return normalizeCodexBackendMode(params.codexBackendMode)
    ?? normalizeCodexBackendMode(params.defaultBackendMode);
}

function resolveCodexRuntimeBackendModeFromSettings(
  settings: Readonly<Record<string, unknown>>,
  params: Readonly<{ defaultBackendMode?: CodexBackendMode | null }> = {},
): CodexBackendMode | null {
  const mode = resolveCodexRuntimeBackendMode({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: params.defaultBackendMode,
  });
  return mode ?? (settings.experimentalCodexAcp === true ? 'acp' : null);
}

function isExplicitCodexVendorResumeBackendEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  if (typeof settings.codexBackendMode === 'string') {
    const trimmed = settings.codexBackendMode.trim();
    return trimmed === 'acp' || trimmed === 'appServer' || trimmed === 'mcp_resume';
  }
  return settings.experimentalCodexAcp === true;
}

function isCodexRuntimeIdentityVendorResumeBackendEnabled(mode: CodexRuntimeControlMode): boolean {
  return mode === 'acp' || mode === 'appServer';
}

function resolveCodexConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
  const settings = accountSettings ?? {};
  return resolveCodexRuntimeBackendMode({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: CODEX_DEFAULT_BACKEND_MODE,
  }) ?? (settings.experimentalCodexAcp === true ? 'acp' : null);
}

function resolveCodexPersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
  return resolvePersistedCodexRuntimeIdentity(metadata)?.backendMode ?? null;
}

function resolveCodexVendorResumeId(metadata: unknown): string | null {
  return resolvePersistedCodexProviderSessionId(metadata);
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
  if (runtimeIdentity) {
    return isCodexRuntimeIdentityVendorResumeBackendEnabled(runtimeIdentity.backendMode);
  }
  return isExplicitCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
}

export const CODEX_SESSION_CONTROL_ADAPTER = Object.freeze({
  normalizeRuntimeKindOverride(value: unknown): AgentRuntimeKind | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return null;
    return trimmed === 'mcp'
      || trimmed === 'acp'
      || trimmed === 'appServer'
      || trimmed === 'mcp_resume'
      ? normalizeCodexBackendMode(trimmed)
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
