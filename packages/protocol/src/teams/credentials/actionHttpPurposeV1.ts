import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, ProviderBrokerActionOpenRequestV3Schema, type ProviderBrokerActionOpenRequestV3 } from '../../providers/brokerRouteGrantV1.js';
import { TeamCredentialDirectMaterialOpenRequestV1Schema, TeamCredentialDirectMaterialRouteParamsV1Schema, type TeamCredentialDirectMaterialOpenRequestV1 } from './directMaterialV1.js';

import type { TeamCredentialActionOperationConsumerV1 } from './actionOperationV1.js';

export type TeamCredentialActionHttpPurposeV1 =
  | Readonly<{ kind: 'direct_material'; teamId: string; resourceId: string; body: TeamCredentialDirectMaterialOpenRequestV1; consumer: TeamCredentialActionOperationConsumerV1 }>
  | Readonly<ProviderBrokerActionOpenRequestV3 & { kind: 'broker_action' }>;

/** Classifies only the exact finite credential HTTP shapes; callers own signed authority. */
export function readTeamCredentialActionHttpPurposeV1(request: Readonly<{ method: string; path: string; body?: unknown }>): TeamCredentialActionHttpPurposeV1 | null {
  if (request.method.toUpperCase() !== 'POST') return null;
  if (request.path === PROVIDER_BROKER_OPEN_HTTP_PATH_V1) {
    const parsed = ProviderBrokerActionOpenRequestV3Schema.safeParse(request.body);
    return parsed.success ? { kind: 'broker_action' as const, ...parsed.data } : null;
  }
  const path = /^\/v2\/teams\/([^/?#]+)\/credential-resources\/([^/?#]+)\/direct-material$/u.exec(request.path);
  if (!path) return null;
  const parsed = TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(request.body);
  if (!parsed.success || parsed.data.consumer.kind !== 'action_operation') return null;
  try {
    const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse({ teamId: decodeURIComponent(path[1]!), resourceId: decodeURIComponent(path[2]!) });
    if (!params.success || params.data.resourceId !== parsed.data.resourceId
      || request.path !== `/v2/teams/${encodeURIComponent(params.data.teamId)}/credential-resources/${encodeURIComponent(params.data.resourceId)}/direct-material`) return null;
    return { kind: 'direct_material' as const, ...params.data, body: parsed.data, consumer: parsed.data.consumer };
  } catch { return null; }
}
