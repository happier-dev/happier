import type { AgentId } from '../types.js';
import type { AgentRuntimeKind } from '../runtimeKinds.js';
import { CODEX_SESSION_CONTROL_ADAPTER } from './codex/sessionControlAdapter.js';
import { OPENCODE_SESSION_CONTROL_ADAPTER } from './opencode/sessionControlAdapter.js';
import { PI_SESSION_CONTROL_ADAPTER } from './pi/sessionControlAdapter.js';

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

const PROVIDER_SESSION_CONTROL_ADAPTERS: Readonly<Partial<Record<AgentId, ProviderSessionControlAdapter>>> = Object.freeze({
  codex: CODEX_SESSION_CONTROL_ADAPTER,
  opencode: OPENCODE_SESSION_CONTROL_ADAPTER,
  pi: PI_SESSION_CONTROL_ADAPTER,
});

export function getProviderSessionControlAdapter(agentId: AgentId): ProviderSessionControlAdapter | null {
  return PROVIDER_SESSION_CONTROL_ADAPTERS[agentId] ?? null;
}
