import {
    buildProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageConfidenceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

function mapQuotaSourceToUsageSource(source: ConnectedServiceQuotaSnapshotV1['source']): ProviderAccountUsageSourceV1 {
    const normalized = source ?? 'unknown';
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
    const normalized = confidence ?? 'unknown';
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
    const hasStableSubject = Boolean(stableAccountId);
    const accountSubjectId = stableAccountId
        || `legacy-connected-service:${snapshot.serviceId}:${snapshot.profileId}`;
    const fetchedAtMs = snapshot.fetchedAtMs ?? snapshot.fetchedAt;
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId,
        accountSubjectId,
        subjectKind: hasStableSubject ? 'account' : 'unknown',
        quotaScope: 'account',
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
        ...(snapshot.recoveryCredits ? { recoveryCredits: snapshot.recoveryCredits } : {}),
        meters: snapshot.meters,
    });
}
