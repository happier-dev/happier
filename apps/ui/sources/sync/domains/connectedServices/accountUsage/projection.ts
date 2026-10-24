import {
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaSnapshotV1Schema,
  projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { getAgentCore, isAgentId, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';

function resolveDefaultServiceIdForProvider(providerId: string | null | undefined): ConnectedServiceQuotaSnapshotV1['serviceId'] | null {
  const agentId = isAgentId(providerId) ? providerId : resolveAgentIdFromFlavor(providerId);
  if (!agentId) {
    const parsed = ConnectedServiceIdSchema.safeParse(providerId);
    return parsed.success ? parsed.data : null;
  }
  return getAgentCore(agentId).connectedServices?.supportedServiceIds[0] ?? null;
}

function selectDisplayableProviderAccountUsageSnapshot(
  snapshot: ProviderAccountUsageSnapshotV1,
): ProviderAccountUsageSnapshotV1 | null {
  if (snapshot.state === 'not_loaded' || snapshot.state === 'loaded_empty') return null;
  if (snapshot.meters.length === 0) return null;
  return snapshot;
}

function snapshotMatchesDisplayProvider(params: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  providerId: string | null;
}>): boolean {
  const requestedProviderId = String(params.providerId ?? '').trim();
  if (!requestedProviderId) return true;
  if (params.snapshot.providerId === requestedProviderId) return true;
  const agentId = isAgentId(requestedProviderId)
    ? requestedProviderId
    : resolveAgentIdFromFlavor(requestedProviderId);
  return agentId === params.snapshot.providerId;
}

export function projectProviderAccountUsageToConnectedServiceProfileSnapshot(params: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
  profileId: ConnectedServiceQuotaSnapshotV1['profileId'];
}>): ConnectedServiceQuotaSnapshotV1 | null {
  const snapshot = selectDisplayableProviderAccountUsageSnapshot(params.snapshot);
  if (!snapshot) return null;
  return projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
    snapshot,
    source: {
      serviceId: params.serviceId,
      profileId: params.profileId,
      bindingKind: 'profile',
    },
  });
}

export function projectProviderAccountUsageToNativeDisplaySnapshot(params: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  providerId: string | null;
}>): ConnectedServiceQuotaSnapshotV1 | null {
  const snapshot = selectDisplayableProviderAccountUsageSnapshot(params.snapshot);
  if (!snapshot) return null;
  if (!snapshotMatchesDisplayProvider({ snapshot, providerId: params.providerId })) return null;

  const serviceId = resolveDefaultServiceIdForProvider(params.providerId ?? snapshot.providerId);
  if (!serviceId) return null;

  const profileId = ConnectedServiceProfileIdSchema.safeParse(`acct:${snapshot.recordId}`);
  if (!profileId.success) return null;

  const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
    snapshot,
    source: { serviceId, profileId: profileId.data, bindingKind: 'profile' },
  });
  if (!projected) return null;
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    ...projected,
    source: snapshot.source === 'providerHttp'
      ? 'provider_api'
      : snapshot.source === 'runtimeSignal'
        ? 'runtime_event'
        : snapshot.source === 'cached'
          ? 'cached'
          : snapshot.source === 'manual'
            ? 'manual_refresh'
            : 'unknown',
  });
}
