import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';

import type { ManagedProviderSourceModelCatalog } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { TeamCredentialBrokerSourceOpenInput } from './teamCredentialBrokerSourceOwner';
import { isSameTeamCredentialBrokerApplication } from './teamCredentialModelCatalog';

export type ReadConnectedAccountBrokerModelProjection = RuntimeProviderModelManagementServices['readSourceModelCatalogs'];

/** The wrapper receives the exact projection already used by policy, not an
 * independently fetched model list. Current-only admission never refreshes it. */
export async function readConnectedAccountBrokerModelCatalog(input: Readonly<{
  request: TeamCredentialBrokerSourceOpenInput & { source: Extract<TeamCredentialBrokerSourceOpenInput['source'], { kind: 'connected_account' | 'connected_pool' }> };
  purpose: QualifiedConnectedAccountPurposeV1;
  projectModels: ReadConnectedAccountBrokerModelProjection;
  signal: AbortSignal;
}>): Promise<Readonly<{ sourceRevision: string; modelCatalogs?: readonly ManagedProviderSourceModelCatalog[] }> | null> {
  const { request } = input;
  const admitted = await input.projectModels({
    machineId: request.brokerMachineId, source: request.source, application: request.application,
    refreshPolicy: 'current_only',
  }, input.signal);
  input.signal.throwIfAborted();
  if (admitted.status !== 'success') return null;
  const rows = admitted.catalogs.filter(catalog => isSameTeamCredentialBrokerApplication(catalog.application, request.application))
    .flatMap(catalog => catalog.rows
      .map(row => ({ row, sourceRevision: catalog.sourceRevision })));
  if (rows.length === 0 || new Set(rows.map(row => row.sourceRevision)).size !== 1) return null;
  const sourceRevision = rows[0]!.sourceRevision;
  if (request.sourceRevision && request.sourceRevision !== sourceRevision
    || request.modelId && !rows.some(({ row }) => row.descriptor.id === request.modelId)) return null;
  const observed = rows.every(({ row }) => row.sources.probe && !row.sources.static && row.confidence === 'probe');
  if (!observed && rows.some(({ row }) => row.sources.probe)) return null;
  return { sourceRevision, ...(observed ? { modelCatalogs: [{ purpose: input.purpose, sourceRevision,
    models: rows.map(({ row }) => ({ id: row.descriptor.id, name: row.descriptor.name })),
  }] } : {}) };
}
