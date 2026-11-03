import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';

import { createConfiguredAcpProbeBackend } from './configuredAcpProbeBackend';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';

export type ConfiguredAcpProbeBackendResult<T> = Readonly<
  | { kind: 'missing' }
  | { kind: 'present'; result: T }
>;

export async function probeConfiguredAcpBackend<T>(params: Readonly<{
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  secretSources?: import('@/plugins/runtime/lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1;
  processEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cleanupScope?: PreflightCatalogCleanupScope;
  onBackend: (backend: AcpProbeBackend) => Promise<T>;
}>): Promise<ConfiguredAcpProbeBackendResult<T>> {
  params.signal?.throwIfAborted();
  const backend = await createConfiguredAcpProbeBackend({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    cwd: params.cwd,
    accountSettings: params.accountSettings,
    credentials: params.credentials,
    acpCatalogSnapshot: params.acpCatalogSnapshot,
    savedSecretOperationContext: params.savedSecretOperationContext,
    machineAdmission: params.machineAdmission,
    secretSources: params.secretSources,
    processEnv: params.processEnv,
    signal: params.signal,
  });
  if (!backend) return { kind: 'missing' };

  // The containing deadline and the native probe's own finally can meet here.
  // Both join the same disposal instead of treating an in-progress dispose as done.
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= backend.dispose();
  const releaseCleanup = await params.cleanupScope?.retain(dispose);
  try {
    params.signal?.throwIfAborted();
    return { kind: 'present', result: await params.onBackend(backend) };
  } finally {
    try { await dispose(); } finally { releaseCleanup?.(); }
  }
}
