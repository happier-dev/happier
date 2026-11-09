import type {
  AcpBackendAuthConfigV1,
  AcpBackendCapabilitiesV1,
  ValueRefV1,
} from '@happier-dev/protocol';
import type { AcpBackendDefinitionV1, AcpBackendLaunchV1, AcpConfiguredRuntimeV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildConfiguredAcpAgentSelectionV1, isCustomAcpAgentContributionIdentityV1, type ConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

/** Resolve the declared routing id separately from the instance's durable identity. */
export function resolveConfiguredAcpAgentSelection(definitionId: string): ConfiguredAcpAgentSelectionV1 & Readonly<{ runtimeRoutingAgentId: string }> {
  const selection = buildConfiguredAcpAgentSelectionV1(definitionId);
  const agents = readCurrentContributionRegistry().agentDefinitionsById;
  const declared = agents.get(selection.agentId) ?? agents.get(selection.agentTarget.identity.localId);
  if (!declared || !isCustomAcpAgentContributionIdentityV1(declared.identity)) {
    throw new AcpCatalogUnavailableError('contribution-unavailable');
  }
  return { ...selection, runtimeRoutingAgentId: declared.id };
}

export class AcpCatalogUnavailableError extends Error {
  readonly code = 'ACP_CATALOG_UNAVAILABLE';
  constructor(readonly reason: string, readonly revision?: number) { super(`Configured ACP catalog is unavailable: ${reason}`); }
}

export function requireReadyAcpCatalog(catalog: AcpCatalogSnapshotV1 | undefined): Extract<AcpCatalogSnapshotV1, { status: 'ready' }> {
  if (!catalog || catalog.status !== 'ready') {
    throw new AcpCatalogUnavailableError(!catalog ? 'catalog-unobserved' : 'reason' in catalog ? catalog.reason : 'loading');
  }
  return catalog;
}

export type ResolvedConfiguredAcpBackend = Readonly<{
  backendId: string;
  source: Readonly<{ kind: 'account_configured' }>;
  name: string;
  title: string;
  description?: string;
  launch: AcpBackendLaunchV1;
  env: Readonly<Record<string, ValueRefV1>>;
  auth?: AcpBackendAuthConfigV1;
  capabilities: AcpBackendCapabilitiesV1;
  defaultMode?: string;
  defaultModel?: string;
  runtime?: AcpConfiguredRuntimeV1;
}>;

function materializeConfiguredAcpBackendFromAccountSettingsEntry(
  backend: AcpBackendDefinitionV1,
): ResolvedConfiguredAcpBackend {
  const backendRecord = backend as Record<string, unknown>;
  const defaultMode = typeof backendRecord.defaultMode === 'string' ? backendRecord.defaultMode : undefined;
  const defaultModel = typeof backendRecord.defaultModel === 'string' ? backendRecord.defaultModel : undefined;

  return {
    backendId: backend.id,
    source: { kind: 'account_configured' },
    name: backend.name,
    title: backend.title,
    description: backend.description,
    launch: backend.launch,
    env: { ...backend.env },
    auth: backend.auth,
    capabilities: backend.capabilities,
    defaultMode,
    defaultModel,
    runtime: backend.runtime,
  };
}

export function resolveConfiguredAcpBackendFromAccountSettings(
  _settings: Readonly<Record<string, unknown>>,
  backendId: string,
  catalogSnapshot?: AcpCatalogSnapshotV1,
): ResolvedConfiguredAcpBackend | null {
  const acpCatalog = requireReadyAcpCatalog(catalogSnapshot);
  const backend = acpCatalog.record.definitions.find((entry) => entry.id === backendId) ?? null;
  return backend ? materializeConfiguredAcpBackendFromAccountSettingsEntry(backend) : null;
}

export async function listConfiguredAcpBackendsFromAccountSettings(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  catalogSnapshot?: AcpCatalogSnapshotV1;
}>): Promise<ReadonlyArray<ResolvedConfiguredAcpBackend>> {
  return requireReadyAcpCatalog(params.catalogSnapshot)
    .record.definitions
    .map((backend) => materializeConfiguredAcpBackendFromAccountSettingsEntry(backend));
}
