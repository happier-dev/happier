import type { AgentRuntimeKind } from '../../runtimeKinds.js';

export type ProviderSessionControlAdapter = Readonly<{
  normalizeRuntimeKindOverride?: (value: unknown) => AgentRuntimeKind | null;
  applyRuntimeKindOverrideToAccountSettings?: (
    accountSettings: Record<string, unknown> | null,
    runtimeKind: AgentRuntimeKind,
  ) => Record<string, unknown> | null;
  resolveConfiguredRuntimeKind?: (accountSettings?: Record<string, unknown> | null) => AgentRuntimeKind | null;
  resolvePersistedSessionRuntimeKind?: (metadata: unknown) => AgentRuntimeKind | null;
  resolveVendorResumeId?: (metadata: unknown) => string | null;
  isExperimentalVendorResumeEnabled?: (input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>) => boolean;
  isExperimentalVendorHandoffEnabled?: (input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>) => boolean;
}>;
