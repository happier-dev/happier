import type { AgentBackend } from '@/agent/core';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';

import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';

export type ConfiguredAcpProbeBackendResult<T> = Readonly<
  | { kind: 'missing' }
  | { kind: 'present'; result: T }
>;

export async function probeConfiguredAcpBackend<T>(params: Readonly<{
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  onBackend: (backend: AgentBackend) => Promise<T>;
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
