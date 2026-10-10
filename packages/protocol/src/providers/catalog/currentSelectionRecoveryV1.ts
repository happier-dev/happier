import type { ProviderBoundModelRef } from '../selection/v1.js';
import type { ProviderSettingsV1 } from '../settings/v1.js';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '../../rpc/providers.js';
import { createProviderErrorV1 } from '../errors.js';

/** Shared selected-intent recovery; declaration lookup is supplied by its admitted authority. */
export function resolveProviderCurrentSelectionRecoveryV1(input: Readonly<{
  currentSelection: ProviderBoundModelRef | undefined;
  settings: Pick<ProviderSettingsV1, 'connections' | 'connectionTombstones'>;
  readContribution(contributionKey: string): Readonly<{ name: string }> | null;
  projectedGroups: readonly Readonly<{ rows: readonly Readonly<{ ref: ProviderBoundModelRef }>[] }>[];
  machineId?: string;
}>): DaemonProviderCurrentSelectionRecoveryV1 | null {
  const ref = input.currentSelection;
  if (!ref?.providerConnectionId) return null;
  if (input.projectedGroups.some(group => group.rows.some(row =>
    row.ref.agentTargetKey === ref.agentTargetKey && row.ref.providerConnectionId === ref.providerConnectionId
    && row.ref.modelId === ref.modelId))) return null;
  const errorContext = { connectionId: ref.providerConnectionId, ...(input.machineId ? { machineId: input.machineId } : {}) };
  const connection = input.settings.connections.find(candidate => candidate.id === ref.providerConnectionId);
  if (!connection) {
    const tombstone = input.settings.connectionTombstones.find(candidate => candidate.id === ref.providerConnectionId);
    return { kind: tombstone ? 'connection_deleted' : 'connection_missing', ref,
      error: createProviderErrorV1('provider_connection_not_found', errorContext),
      displaySnapshot: tombstone ? { connectionName: tombstone.lastDisplayName, modelName: ref.modelId } : null };
  }
  const contribution = connection.source.kind === 'contribution' ? input.readContribution(connection.source.contributionKey) : null;
  const displaySnapshot = { providerName: connection.source.kind === 'custom' ? connection.source.template.name
    : contribution?.name ?? connection.displayName, connectionName: connection.displayName, modelName: ref.modelId };
  return connection.source.kind === 'contribution' && !contribution
    ? { kind: 'contribution_unavailable', ref, error: createProviderErrorV1('provider_contribution_unavailable', errorContext), displaySnapshot }
    : { kind: 'model_not_found', ref, error: createProviderErrorV1('provider_model_not_found', errorContext), displaySnapshot };
}
