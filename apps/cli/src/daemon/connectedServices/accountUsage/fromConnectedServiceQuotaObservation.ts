import {
    buildProviderAccountUsageRecordId,
    buildQualifiedPluginContributionKey,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageConfidenceV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
    type QualifiedConnectedAccountQuotaSnapshotV4,
    type QualifiedConnectedAccountRef,
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

/**
 * Quota observation input for the canonical scalar codec. `serviceId` accepts
 * either the released bundled scalar id or the canonical qualified contribution
 * key: both are canonical Connected Account service identities, and this
 * mapper reads the field only as fallback/merge identity text.
 */
type ConnectedServiceQuotaObservation = Omit<ConnectedServiceQuotaSnapshotV1, 'serviceId'> & Readonly<{
    serviceId: string;
}>;

export function buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation(input: Readonly<{
    snapshot: ConnectedServiceQuotaObservation;
    observedAtMs?: number;
    sourceProviderAccountId?: string | null;
}>): ProviderAccountUsageSnapshotV1 {
    const snapshot: ConnectedServiceQuotaObservation = input.snapshot;
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

/**
 * Canonical local hydration of a freshly opened qualified V4 quota row (server-side projection
 * of the authoritative provider-account-usage record) into the PAU snapshot shape the daemon
 * account-usage store records. The V4 row content is the quota-fields projection of the stored
 * PAU record, and its validated source resolution pins `activeAccountId` to the stored provider
 * account subject, so the record key reconstructs the same stable identity the writer used.
 *
 * This is a thin delegation to the incumbent scalar observation codec: the qualified ref is
 * projected onto the canonical scalar observation shape (qualified contribution key as service
 * id, the qualified account id as profile id) and the row's `activeAccountId` is handed over as
 * the proven source provider account. There is deliberately no second record-key/subject/
 * source/confidence/state implementation here.
 */
export function buildProviderAccountUsageSnapshotFromQualifiedQuotaRow(input: Readonly<{
    ref: QualifiedConnectedAccountRef;
    quota: QualifiedConnectedAccountQuotaSnapshotV4;
    observedAtMs?: number;
}>): ProviderAccountUsageSnapshotV1 {
    const contributionKey = buildQualifiedPluginContributionKey(input.ref.service);
    const { ref: _qualifiedRef, ...quotaFields } = input.quota;
    return buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: {
            ...quotaFields,
            serviceId: contributionKey,
            profileId: input.ref.accountId.trim(),
        },
        ...(input.observedAtMs === undefined ? {} : { observedAtMs: input.observedAtMs }),
        sourceProviderAccountId: input.quota.activeAccountId,
    });
}
