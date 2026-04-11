import type { AgentRuntimeKind } from '../../runtimeKinds.js';
import { normalizeOpenCodeBackendMode } from '../../providerSettings/definitions/opencode.js';
import { readSessionMetadataRuntimeDescriptor } from '../../sessionControls/agentRuntimeDescriptor.js';
import { readOpenCodeSessionAffinityFromMetadata } from '../../sessionControls/opencodeSessionRuntimeHandle.js';

export const OPENCODE_SESSION_CONTROL_ADAPTER = Object.freeze({
  normalizeRuntimeKindOverride(value: unknown): AgentRuntimeKind | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return null;
    return trimmed === 'server' || trimmed === 'acp'
      ? normalizeOpenCodeBackendMode(trimmed)
      : null;
  },
  applyRuntimeKindOverrideToAccountSettings(
    accountSettings: Record<string, unknown> | null,
    runtimeKind: AgentRuntimeKind,
  ): Record<string, unknown> {
    return {
      ...(accountSettings ?? {}),
      opencodeBackendMode: runtimeKind,
    };
  },
  resolveConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
    return normalizeOpenCodeBackendMode(accountSettings?.opencodeBackendMode);
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
    return readOpenCodeSessionAffinityFromMetadata(metadata).backendMode;
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return readSessionMetadataRuntimeDescriptor(metadata, 'opencode')?.vendorSessionId ?? null;
  },
});
