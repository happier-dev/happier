import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings';
import type { CatalogAgentId } from '@/backends/types';

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function resolveConfiguredAcpProbeCacheVariant(params: Readonly<{
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): string | null {
  if (params.agentId !== 'customAcp' || params.backendTarget?.kind !== 'configuredAcpBackend') {
    return null;
  }

  const backendId = params.backendTarget.backendId.trim();
  if (!backendId) {
    return 'configuredAcp:missing-backend-id';
  }
  if (!params.accountSettings) {
    return `configuredAcp:${backendId}:missing-account-settings`;
  }

  const backend = resolveConfiguredAcpBackendFromAccountSettings(params.accountSettings, backendId);
  if (!backend) {
    return `configuredAcp:${backendId}:missing-backend`;
  }

  const materialProbeSettings = sortJsonValue({
    command: backend.command,
    args: backend.args,
    env: backend.env,
    auth: backend.auth,
    transportProfile: backend.transportProfile,
    capabilities: backend.capabilities,
    defaultMode: backend.defaultMode,
    defaultModel: backend.defaultModel,
  });

  return `configuredAcp:${backend.backendId}:${JSON.stringify(materialProbeSettings)}`;
}
