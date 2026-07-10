import { createHash } from 'node:crypto';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpBackendFromAccountSettingsOrPlugins } from '@/agent/acp/catalog/configured/resolveBackend';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { isConfiguredAcpProbeTarget } from './isConfiguredAcpProbeTarget';

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

export async function resolveConfiguredAcpProbeCacheVariant(params: Readonly<{
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  happyHomeDir?: string;
}>): Promise<string | null> {
  if (!isConfiguredAcpProbeTarget(params)) {
    return null;
  }

  const backendId = params.backendTarget.backendId.trim();
  if (!backendId) {
    return 'configuredAcp:missing-backend-id';
  }
  const backend = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
    settings: params.accountSettings ?? {},
    backendId,
    happyHomeDir: params.happyHomeDir,
  });
  if (!backend) {
    if (!params.accountSettings) {
      return `configuredAcp:${backendId}:missing-account-settings`;
    }
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

  // Cache variants must not leak raw env/auth material (may contain secrets). Use a stable digest so
  // the key stays bounded and safe to log/debug.
  const digest = createHash('sha256').update(JSON.stringify(materialProbeSettings)).digest('base64url');
  return `configuredAcp:${backend.backendId}:${digest}`;
}
