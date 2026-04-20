import type { AgentId } from '../../types.js';
import type { AgentRuntimeKind } from '../../runtimeKinds.js';
import { CODEX_SESSION_CONTROL_ADAPTER } from '../../providers/codex/sessionControlAdapter.js';
import { OPENCODE_SESSION_CONTROL_ADAPTER } from '../../providers/opencode/sessionControlAdapter.js';
import { PI_SESSION_CONTROL_ADAPTER } from '../../providers/pi/sessionControlAdapter.js';

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

export const PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS = [
  'codex',
  'opencode',
  'pi',
] as const satisfies readonly AgentId[];

type SupportedProviderSessionControlAdapterProviderId =
  (typeof PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];

const PROVIDER_SESSION_CONTROL_ADAPTERS = Object.freeze({
  codex: CODEX_SESSION_CONTROL_ADAPTER,
  opencode: OPENCODE_SESSION_CONTROL_ADAPTER,
  pi: PI_SESSION_CONTROL_ADAPTER,
} satisfies Readonly<Record<SupportedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>>);

function isSupportedProviderSessionControlAdapterProviderId(
  agentId: AgentId,
): agentId is SupportedProviderSessionControlAdapterProviderId {
  return (PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS as readonly string[]).includes(agentId);
}

export function getProviderSessionControlAdapter(agentId: AgentId): ProviderSessionControlAdapter | null {
  if (!isSupportedProviderSessionControlAdapterProviderId(agentId)) {
    return null;
  }
  return PROVIDER_SESSION_CONTROL_ADAPTERS[agentId];
}
