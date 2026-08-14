import type { AgentId } from '../../types.js';
import {
  GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS,
  GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS,
  type GeneratedProviderSessionControlAdapterProviderId,
} from '../../generated/sessionControlAdapters.js';
import type { ProviderSessionControlAdapter } from './types.js';

export const PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS =
  GENERATED_PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS satisfies readonly AgentId[];

type SupportedProviderSessionControlAdapterProviderId =
  (typeof PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS)[number];

const PROVIDER_SESSION_CONTROL_ADAPTERS =
  GENERATED_PROVIDER_SESSION_CONTROL_ADAPTERS satisfies Readonly<
    Record<SupportedProviderSessionControlAdapterProviderId, ProviderSessionControlAdapter>
  >;

function isSupportedProviderSessionControlAdapterProviderId(
  agentId: string,
): agentId is SupportedProviderSessionControlAdapterProviderId {
  return (PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS as readonly string[]).includes(agentId);
}

export function getProviderSessionControlAdapter(agentId: AgentId | string): ProviderSessionControlAdapter | null {
  if (!isSupportedProviderSessionControlAdapterProviderId(agentId)) {
    return null;
  }
  return PROVIDER_SESSION_CONTROL_ADAPTERS[agentId as GeneratedProviderSessionControlAdapterProviderId];
}

export function resolveSessionArtifactPathFromMetadata(metadata: unknown): string | null {
  const matches = PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS.flatMap((agentId) => {
    const path = PROVIDER_SESSION_CONTROL_ADAPTERS[agentId].resolveSessionArtifactPath?.(metadata);
    return path ? [path] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}
