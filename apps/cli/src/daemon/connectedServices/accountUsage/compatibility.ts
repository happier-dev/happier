import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
  type ProviderAccountUsageSnapshotV1,
  type ProviderAccountUsageSourceV1,
} from '@happier-dev/protocol';

function readConnectedQuotaSource(source: ConnectedServiceQuotaSnapshotV1['source']): ProviderAccountUsageSourceV1 {
  switch (source) {
    case 'in_band_provider_snapshot':
      return 'runtimeSignal';
    case 'provider_api':
      return 'providerHttp';
    case 'background_fetch':
      return 'proxy';
    case 'user_probe':
      return 'connectedServiceProbe';
    case 'cached':
      return 'cached';
    case 'manual_refresh':
      return 'manual';
    default:
      return 'unknown';
  }
}

function readProviderId(snapshot: ConnectedServiceQuotaSnapshotV1): string {
  return typeof snapshot.providerId === 'string' && snapshot.providerId.trim()
    ? snapshot.providerId.trim()
    : snapshot.serviceId;
}

export function projectConnectedServiceQuotaSnapshotToProviderAccountUsageSnapshot(input: Readonly<{
  serviceId: ConnectedServiceId;
  sessionId?: string;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>): ProviderAccountUsageSnapshotV1 {
  const providerId = readProviderId(input.snapshot);
  const activeAccountId = typeof input.snapshot.activeAccountId === 'string' && input.snapshot.activeAccountId.trim()
    ? input.snapshot.activeAccountId.trim()
    : `connected:${input.snapshot.serviceId}:${input.snapshot.profileId}`;
  const stable = activeAccountId === input.snapshot.activeAccountId;
  const recordKey = {
    providerId,
    accountSubjectId: activeAccountId,
    subjectKind: stable ? 'account' as const : 'unknown' as const,
    quotaScope: 'account' as const,
  };
  const recordId = buildProviderAccountUsageRecordId(recordKey);
  return {
    v: 1,
    recordId,
    recordKey,
    providerId,
    accountSubject: {
      kind: stable ? 'providerSubject' : 'provisionalLocalSubject',
      id: activeAccountId,
    },
    aliases: [
      {
        kind: 'connectedServiceProfile',
        providerId,
        serviceId: input.snapshot.serviceId,
        profileId: input.snapshot.profileId,
        accountSubjectId: activeAccountId,
      },
      ...(input.sessionId ? [{
        kind: 'runtimeSession' as const,
        providerId,
        sessionId: input.sessionId,
        accountSubjectId: activeAccountId,
      }] : []),
    ],
    observedAtMs: input.snapshot.fetchedAtMs ?? input.snapshot.fetchedAt,
    fetchedAtMs: input.snapshot.fetchedAtMs ?? input.snapshot.fetchedAt,
    staleAfterMs: input.snapshot.staleAfterMs,
    source: readConnectedQuotaSource(input.snapshot.source),
    confidence: input.snapshot.confidence === 'estimated' ? 'estimated' : input.snapshot.confidence === 'unknown' ? 'unknown' : 'confirmed',
    state: input.snapshot.meters.length === 0 ? 'loaded_empty' : 'loaded_data',
    planLabel: input.snapshot.planLabel ?? null,
    accountLabel: input.snapshot.accountLabel ?? null,
    meters: input.snapshot.meters,
  };
}
