import { z } from '../zodRuntimePolicy.js';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../connect/connectedServiceUxDiagnostics.js';
import { ProviderErrorV1Schema } from '../providers/errors.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../providers/brokerRouteGrantV1.js';
import { DaemonProviderModelProjectionResponseV1Schema, type DaemonProviderModelProjectionGroupV1, type DaemonProviderModelProjectionRowV1 } from './providers.js';

export type TeamCredentialSourceModelProjectionFailureV1 = Readonly<{
  status: 'unavailable';
  reason: 'response_invalid' | 'projection_unavailable' | 'not_granted' | 'incompatible'
    | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  error?: z.infer<typeof ProviderErrorV1Schema>;
}>;

/** Shared source-row admission for recipient projection and broker execution.
 * This reads source facts only; entitlement, Team policy and disclosure remain
 * at their respective owners. The strict RPC reader is also used in-process. */
export function admitTeamCredentialSourceModelRowsV1(response: unknown):
  | TeamCredentialSourceModelProjectionFailureV1
  | Readonly<{ status: 'success'; rows: readonly Readonly<{
      group: DaemonProviderModelProjectionGroupV1;
      row: DaemonProviderModelProjectionRowV1 & { application: z.infer<typeof ProviderBrokerApplicationBindingV1Schema> };
      sourceRevision: string;
    }>[] }> {
  const parsed = DaemonProviderModelProjectionResponseV1Schema.safeParse(response);
  if (!parsed.success) return { status: 'unavailable', reason: 'response_invalid' };
  if (parsed.data.status === 'error') {
    return { status: 'unavailable', reason: parsed.data.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
      ? parsed.data.error.code : parsed.data.error.code === 'provider_incompatible_with_agent'
        ? 'incompatible' : 'projection_unavailable', error: parsed.data.error };
  }
  const projection = parsed.data;
  let failure: TeamCredentialSourceModelProjectionFailureV1 | undefined;
  const rows = projection.groups.flatMap(group => {
    if (!group.authorization.authorized) {
      failure ??= { status: 'unavailable', reason: group.authorization.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
        ? group.authorization.error.code : 'not_granted', error: group.authorization.error };
      return [];
    }
    if (!group.sourceRevision) {
      failure ??= { status: 'unavailable', reason: 'projection_unavailable' };
      return [];
    }
    const sourceRevision = group.sourceRevision;
    return group.rows.flatMap(row => {
      if (row.visibility !== 'visible') return [];
      if (row.catalog.stale) {
        failure ??= { status: 'unavailable', reason: 'projection_unavailable' };
        return [];
      }
      if (!row.application || row.ref.modelId !== row.descriptor.id
        || row.application.agentTargetKey !== projection.agentTargetKey
        || row.ref.agentTargetKey !== row.application.agentTargetKey) {
        failure ??= { status: 'unavailable', reason: 'response_invalid' };
        return [];
      }
      if (!row.sourceFacts && row.compatibility.result.status === 'incompatible') {
        failure ??= { status: 'unavailable', reason: 'incompatible' };
        return [];
      }
      return [{ group, row: { ...row, application: row.application }, sourceRevision }];
    });
  });
  if (rows.length > 0) return { status: 'success', rows };
  const refreshFailure = projection.refreshFailures?.[0];
  if (refreshFailure) return { status: 'unavailable', reason: refreshFailure.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
    ? refreshFailure.error.code : 'projection_unavailable', error: refreshFailure.error };
  return failure ?? { status: 'success', rows: [] };
}
