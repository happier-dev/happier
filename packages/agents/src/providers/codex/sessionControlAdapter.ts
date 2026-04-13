import { type AgentRuntimeKind } from '../../runtimeKinds.js';
import { CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS } from './providerSettingsRuntime.js';
import { normalizeCodexBackendMode } from '../../providerSettings/definitions/codex.js';

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
    return CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS.resolveConfiguredRuntimeKind(accountSettings);
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
    return CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS.resolvePersistedSessionRuntimeKind(metadata);
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS.resolveVendorResumeId(metadata);
  },
  isExperimentalVendorResumeEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    return CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS.isExperimentalVendorResumeEnabled(input);
  },
  isExperimentalVendorHandoffEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    return CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS.isExperimentalVendorHandoffEnabled(input);
  },
});
