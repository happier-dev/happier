import type { TeamCredentialResourceCatalogEntryV1, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';

/** Forward the Home's readiness fact; brokered allowances do not govern Direct delivery. */
export function readTeamCredentialLaunchReadinessRefusal(
  resource: Pick<TeamCredentialResourceCatalogEntryV1, 'readiness' | 'deliveryUnavailableReason'>,
  deliveryMode: TeamResourceConnectedServiceSelectionV2['deliveryMode'],
): 'team_credential_usage_limit' | 'broker_unavailable' | 'update_required'
  | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired | ProviderErrorCodeV1 | null {
  const readiness = readTeamCredentialDeliveryReadinessV1(resource.readiness, deliveryMode);
  if (readiness.kind !== 'available' && resource.deliveryUnavailableReason) return resource.deliveryUnavailableReason;
  if (readiness.kind === 'source_unavailable' && readiness.reason) return readiness.reason;
  if (readiness.kind === 'update_required') return 'update_required';
  if (readiness.kind === 'broker_unavailable' || readiness.kind === 'source_unavailable') {
    return 'broker_unavailable';
  }
  return readiness.kind === 'limit_reached'
    ? 'team_credential_usage_limit' : null;
}
