import { createHash } from 'node:crypto';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { AcpCatalogUnavailableError, requireReadyAcpCatalog, resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
  catalogSnapshot?: AcpCatalogSnapshotV1;
}>): Promise<string | null> {
  if (!isConfiguredAcpProbeTarget(params)) {
    return null;
  }

  const active = getActiveAccountSettingsSnapshot();
  const catalog = requireReadyAcpCatalog(params.catalogSnapshot ?? (
    active && params.accountSettings === active.settings ? active.acpCatalog : undefined
  ));

  const backendId = params.backendTarget.backendId.trim();
  if (!backendId) {
    throw new AcpCatalogUnavailableError('backend-id-missing');
  }
  const backend = resolveConfiguredAcpBackendFromAccountSettings(
    params.accountSettings ?? {},
    backendId,
    catalog,
  );
  if (!backend) {
    if (!params.accountSettings) {
      return `configuredAcp:${backendId}:missing-account-settings`;
    }
    return `configuredAcp:${backendId}:missing-backend`;
  }

  const materialProbeSettings = sortJsonValue({
    source: backend.source,
    command: backend.command,
    args: backend.args,
    env: backend.env,
    auth: backend.auth,
    runtime: backend.runtime,
    capabilities: backend.capabilities,
    defaultMode: backend.defaultMode,
    defaultModel: backend.defaultModel,
  });

  // Cache variants must not leak raw env/auth material (may contain secrets). Use a stable digest so
  // the key stays bounded and safe to log/debug.
  const digest = createHash('sha256').update(JSON.stringify(materialProbeSettings)).digest('base64url');
  return `configuredAcp:${backend.backendId}:${digest}`;
}
