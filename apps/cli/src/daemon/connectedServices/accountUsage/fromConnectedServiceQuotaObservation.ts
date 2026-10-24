import { connectedServiceUsageRequiresOrganizationId } from '@happier-dev/protocol';
import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceQuotaConfidenceV1Schema,
  ConnectedServiceQuotaSourceV1Schema,
  type ConnectedServiceQuotaSnapshotV1,
  type ProviderAccountUsageConfidenceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol';
import { getConnectedAccountDescriptor } from '../descriptors/connectedAccountDescriptors';

function mapQuotaSourceToUsageSource(source: ConnectedServiceQuotaSnapshotV1['source']): ProviderAccountUsageSourceV1 {
  const normalized = source ? ConnectedServiceQuotaSourceV1Schema.parse(source) : 'unknown';
  const mapped: Record<typeof normalized, ProviderAccountUsageSourceV1> = {
    provider_api: 'providerHttp',
    background_fetch: 'proxy',
    runtime_event: 'runtimeSignal',
    runtime_probe: 'runtimeSignal',
    in_band_snapshot: 'runtimeSignal',
    in_band_provider_snapshot: 'runtimeSignal',
    manual_refresh: 'manual',
    user_probe: 'connectedServiceProbe',
    cached: 'cached',
    unknown: 'unknown',
  };
  return mapped[normalized];
}

function mapQuotaConfidenceToUsageConfidence(
  confidence: ConnectedServiceQuotaSnapshotV1['confidence'],
): ProviderAccountUsageConfidenceV1 {
  const normalized = confidence ? ConnectedServiceQuotaConfidenceV1Schema.parse(confidence) : 'unknown';
  if (normalized === 'exact' || normalized === 'derived') return 'confirmed';
  if (normalized === 'estimated') return 'estimated';
  return 'unknown';
}

export function buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation(input: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  observedAtMs?: number;
  sourceProviderAccountId?: string | null;
}>): ProviderAccountUsageSnapshotV1 {
  const snapshot = input.snapshot;
  const providerId = (snapshot.providerId ?? snapshot.serviceId).trim();
  const sourceProviderAccountId = typeof input.sourceProviderAccountId === 'string'
    ? input.sourceProviderAccountId.trim()
    : '';
  const stableAccountId = (snapshot.activeAccountId ?? sourceProviderAccountId).trim();
  const organizationId = snapshot.providerOrganizationId?.trim() || null;
  const requiresOrganization = connectedServiceUsageRequiresOrganizationId(snapshot.serviceId);
  const hasStableSubject = Boolean(stableAccountId) && (!requiresOrganization || Boolean(organizationId));
  const accountSubjectId = hasStableSubject ? stableAccountId
    : `legacy-connected-service:${snapshot.serviceId}:${snapshot.profileId}`;
  const fetchedAtMs = snapshot.fetchedAtMs ?? snapshot.fetchedAt;
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId,
    accountSubjectId,
    subjectKind: hasStableSubject ? 'account' : 'unknown',
    quotaScope: hasStableSubject && organizationId ? 'organization' : 'account',
    ...(hasStableSubject && organizationId ? { quotaScopeId: organizationId } : {}),
  };

  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId,
    accountSubject: hasStableSubject
      ? { kind: 'providerSubject', id: accountSubjectId }
      : { kind: 'provisionalLocalSubject', id: accountSubjectId, mergeKey: `${snapshot.serviceId}:${snapshot.profileId}` },
    observedAtMs: input.observedAtMs ?? snapshot.evidence?.observedAtMs ?? fetchedAtMs,
    fetchedAtMs,
    staleAfterMs: snapshot.staleAfterMs,
    source: mapQuotaSourceToUsageSource(snapshot.source),
    confidence: mapQuotaConfidenceToUsageConfidence(snapshot.confidence),
    state: snapshot.confidence === 'stale'
      ? 'stale_data'
      : snapshot.meters.length > 0
        ? 'loaded_data'
        : 'loaded_empty',
    planLabel: snapshot.planLabel,
    accountLabel: snapshot.accountLabel,
    ...(snapshot.subscription ? { subscription: snapshot.subscription } : {}),
    ...(snapshot.recoveryCredits ? { recoveryCredits: snapshot.recoveryCredits } : {}),
    ...(snapshot.recoveryCreditDetails ? { recoveryCreditDetails: snapshot.recoveryCreditDetails } : {}),
    meters: snapshot.meters,
  });
}
