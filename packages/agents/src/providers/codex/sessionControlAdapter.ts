import { resolveDefaultAgentRuntimeKind, type AgentRuntimeKind } from '../../runtimeKinds.js';
import { normalizeCodexBackendMode, resolveCodexRuntimeBackendMode } from '../../providerSettings/definitions/codex.js';
import { readSessionMetadataRuntimeDescriptor } from '../../sessionControls/agentRuntimeDescriptor.js';
import { resolvePersistedCodexRuntimeIdentity } from '../../sessionControls/codexRuntimeIdentity.js';

import { isCodexVendorResumeBackendEnabled } from '../../providerSettings/definitions/codex.js';

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
    return resolveCodexRuntimeBackendMode({
      codexBackendMode: accountSettings?.codexBackendMode,
      experimentalCodexAcp: accountSettings?.experimentalCodexAcp === true,
      defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
    });
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
    return resolvePersistedCodexRuntimeIdentity(metadata)?.backendMode ?? null;
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return readSessionMetadataRuntimeDescriptor(metadata, 'codex')?.vendorSessionId ?? null;
  },
  isExperimentalVendorResumeEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    const runtimeKind = resolvePersistedCodexRuntimeIdentity(input.metadata)?.backendMode
      ?? resolveCodexRuntimeBackendMode({
        codexBackendMode: input.accountSettings?.codexBackendMode,
        experimentalCodexAcp: input.accountSettings?.experimentalCodexAcp === true,
        defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
      });
    return isCodexVendorResumeBackendEnabled(runtimeKind ? { codexBackendMode: runtimeKind } : {});
  },
  isExperimentalVendorHandoffEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
    if (runtimeIdentity?.backendMode === 'acp' || runtimeIdentity?.backendMode === 'appServer') {
      return true;
    }
    return isCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
  },
});
