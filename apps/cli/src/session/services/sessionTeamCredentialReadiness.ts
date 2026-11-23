import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import type { TeamCredentialRouteV1 } from '@happier-dev/protocol/teams/credentials/deliveryV1';

import { createTeamCredentialLaunchFailureCause } from './sessionTeamCredentialLaunchError';

/** Forward the Home's readiness fact; brokered allowances do not govern Direct delivery. */
export function readTeamCredentialLaunchReadinessRefusal(
  resource: Pick<TeamCredentialResourceCatalogEntryV1, 'readiness' | 'deliveryUnavailableReason'>,
  deliveryMode: TeamCredentialRouteV1,
): 'team_credential_usage_limit' | Exclude<TeamCredentialResourceCatalogEntryV1['readiness']['kind'], 'available' | 'limit_reached'>
  | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired | ProviderErrorCodeV1 | null {
  const readiness = readTeamCredentialDeliveryReadinessV1(resource.readiness, deliveryMode);
  if (readiness.kind !== 'available' && resource.deliveryUnavailableReason) return resource.deliveryUnavailableReason;
  if (readiness.kind === 'source_unavailable') return readiness.reason ?? readiness.kind;
  return readiness.kind === 'limit_reached'
    ? 'team_credential_usage_limit' : readiness.kind === 'available' ? null : readiness.kind;
}

export function projectTeamCredentialLaunchReadinessRefusal(
  resource: Parameters<typeof readTeamCredentialLaunchReadinessRefusal>[0],
  deliveryMode: TeamCredentialRouteV1,
  phase: 'readiness' | 'purpose_binding',
) {
  const code = readTeamCredentialLaunchReadinessRefusal(resource, deliveryMode);
  if (!code) return null;
  const reason = resource.readiness.kind === 'broker_unavailable' ? resource.readiness.reason : undefined;
  return { code, ...(reason ? { failureCause: createTeamCredentialLaunchFailureCause(code, phase, reason) } : {}) };
}
