import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { AgentModelDescriptor } from '@happier-dev/protocol/models/descriptor';

/** Native pickers and Run admission consume the selected source's observed facts. */
export function projectObservedNativeModelCatalog(projection: DaemonProviderModelProjectionResponseV1, agentTargetKey: string): Readonly<{
  availableModels: readonly AgentModelDescriptor[];
  supportsFreeform: boolean;
}> | null {
  if (projection.status !== 'success' || projection.agentTargetKey !== agentTargetKey
    || projection.groups.length === 0 || !projection.groups.every(group => group.catalogObserved === true)) return null;
  const models = new Map(projection.groups.flatMap(group => group.rows
    .filter(row => row.ref.providerConnectionId === null && row.compatibility.confirmed)
    .map(row => [row.ref.modelId, { ...row.descriptor, id: row.ref.modelId }] as const)));
  return { availableModels: [...models.values()],
    supportsFreeform: projection.groups.some(group => group.supportsFreeformModelIds) };
}
