import {
  normalizeOpenCodeBackendMode,
  readOpenCodeSessionAffinityFromMetadata,
  readOpenCodeSessionMetadataRuntimeDescriptor,
} from '../../../identity/runtimeDescriptor.js';
import type { OpenCodeBackendMode } from '../../../../protocol/runtimeDescriptorV1.js';

type OpenCodeSessionControlAdapter = Readonly<{
  normalizeRuntimeKindOverride: (value: unknown) => OpenCodeBackendMode | null;
  applyRuntimeKindOverrideToAccountSettings: (
    accountSettings: Record<string, unknown> | null,
    runtimeKind: unknown,
  ) => Record<string, unknown>;
  resolveConfiguredRuntimeKind: (accountSettings?: Record<string, unknown> | null) => OpenCodeBackendMode | null;
  resolvePersistedSessionRuntimeKind: (metadata: unknown) => OpenCodeBackendMode | null;
  resolveVendorResumeId: (metadata: unknown) => string | null;
}>;

function normalizeOpenCodeRuntimeKindOverride(value: unknown): OpenCodeBackendMode | null {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (trimmed !== 'server' && trimmed !== 'acp') return null;
  return normalizeOpenCodeBackendMode(trimmed);
}

export const OPENCODE_SESSION_CONTROL_ADAPTER = Object.freeze({
  normalizeRuntimeKindOverride: normalizeOpenCodeRuntimeKindOverride,
  applyRuntimeKindOverrideToAccountSettings(
    accountSettings: Record<string, unknown> | null,
    runtimeKind: unknown,
  ): Record<string, unknown> {
    const opencodeBackendMode = normalizeOpenCodeRuntimeKindOverride(runtimeKind) ?? 'server';
    return {
      ...(accountSettings ?? {}),
      opencodeBackendMode,
    };
  },
  resolveConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): OpenCodeBackendMode | null {
    return normalizeOpenCodeBackendMode(accountSettings?.opencodeBackendMode);
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): OpenCodeBackendMode | null {
    return readOpenCodeSessionAffinityFromMetadata(metadata).backendMode;
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return readOpenCodeSessionMetadataRuntimeDescriptor(metadata)?.providerSessionId ?? null;
  },
} satisfies OpenCodeSessionControlAdapter);
