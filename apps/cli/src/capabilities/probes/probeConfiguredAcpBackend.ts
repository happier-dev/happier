import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { Credentials } from '@/persistence';

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
  credentials?: Credentials | null;
  onBackend: (backend: AcpProbeBackend) => Promise<T>;
}>): Promise<ConfiguredAcpProbeBackendResult<T>> {
  const backend = await createConfiguredAcpProbeBackend({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    cwd: params.cwd,
    accountSettings: params.accountSettings,
    credentials: params.credentials,
  });
  if (!backend) return { kind: 'missing' };

  try {
    return { kind: 'present', result: await params.onBackend(backend) };
  } finally {
    await backend.dispose().catch(() => {});
  }
}
