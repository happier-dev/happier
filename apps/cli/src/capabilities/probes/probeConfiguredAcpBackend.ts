import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';

import { createConfiguredAcpProbeBackend } from './configuredAcpProbeBackend';

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
  processEnv?: NodeJS.ProcessEnv;
  onBackend: (backend: AcpProbeBackend) => Promise<T>;
}>): Promise<ConfiguredAcpProbeBackendResult<T>> {
  const backend = await createConfiguredAcpProbeBackend({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    cwd: params.cwd,
    accountSettings: params.accountSettings,
    credentials: params.credentials,
    acpCatalogSnapshot: params.acpCatalogSnapshot,
    savedSecretOperationContext: params.savedSecretOperationContext,
    processEnv: params.processEnv,
  });
  if (!backend) return { kind: 'missing' };

  try {
    return { kind: 'present', result: await params.onBackend(backend) };
  } finally {
    await backend.dispose().catch(() => {});
  }
}
