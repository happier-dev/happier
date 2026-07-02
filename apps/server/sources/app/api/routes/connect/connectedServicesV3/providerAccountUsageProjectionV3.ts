import {
    buildProviderAccountUsageRecordId,
    normalizeProviderAccountUsageAliases,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageConfidenceV1,
    type ProviderAccountUsageSnapshotV1,
    type ProviderAccountUsageSourceV1,
} from "@happier-dev/protocol";

function mapQuotaSourceToUsageSource(source: ConnectedServiceQuotaSnapshotV1["source"]): ProviderAccountUsageSourceV1 {
    const mapped: Record<NonNullable<ConnectedServiceQuotaSnapshotV1["source"]>, ProviderAccountUsageSourceV1> = {
        provider_api: "providerHttp",
        background_fetch: "proxy",
        runtime_event: "runtimeSignal",
        runtime_probe: "runtimeSignal",
        in_band_snapshot: "runtimeSignal",
        in_band_provider_snapshot: "runtimeSignal",
        manual_refresh: "manual",
        user_probe: "connectedServiceProbe",
        cached: "cached",
        unknown: "unknown",
    };
    return source ? mapped[source] : "connectedServiceProbe";
}

function mapQuotaConfidenceToUsageConfidence(
    confidence: ConnectedServiceQuotaSnapshotV1["confidence"],
): ProviderAccountUsageConfidenceV1 {
    if (confidence === "exact" || confidence === "derived") return "confirmed";
    if (confidence === "estimated" || confidence === "stale") return "estimated";
    return "unknown";
}

export function buildProviderAccountUsageSnapshotFromQuotaSnapshot(
    snapshot: ConnectedServiceQuotaSnapshotV1,
): ProviderAccountUsageSnapshotV1 {
    const providerId = snapshot.providerId?.trim() || snapshot.serviceId;
    const accountSubjectId = snapshot.activeAccountId?.trim() || `connected-service:${snapshot.serviceId}:${snapshot.profileId}`;
    const hasProviderSubject = !!snapshot.activeAccountId?.trim();
    const recordKey = {
        providerId,
        accountSubjectId,
        subjectKind: hasProviderSubject ? "account" : "unknown",
        quotaScope: "account",
    } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const fetchedAtMs = snapshot.fetchedAtMs ?? snapshot.fetchedAt;
    const diagnostic = snapshot.evidence
        ? {
            kind: "projection" as const,
            code: snapshot.evidence.code,
            message: snapshot.evidence.message,
            status: snapshot.evidence.status,
            headers: snapshot.evidence.headers,
            observedAtMs: snapshot.evidence.observedAtMs,
        }
        : undefined;

    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId,
        recordKey,
        providerId,
        accountSubject: {
            kind: hasProviderSubject ? "providerSubject" : "provisionalLocalSubject",
            id: accountSubjectId,
        },
        aliases: normalizeProviderAccountUsageAliases([
            {
                kind: "connectedServiceProfile",
                providerId,
                serviceId: snapshot.serviceId,
                profileId: snapshot.profileId,
                accountSubjectId,
            },
        ]),
        observedAtMs: fetchedAtMs,
        fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        source: mapQuotaSourceToUsageSource(snapshot.source),
        confidence: mapQuotaConfidenceToUsageConfidence(snapshot.confidence),
        planLabel: snapshot.planLabel,
        accountLabel: snapshot.accountLabel,
        meters: snapshot.meters,
        ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    });
}

export function buildConnectedServiceFallbackProviderAccountUsageRecordId(params: Readonly<{
    serviceId: string;
    profileId: string;
}>): string {
    return buildProviderAccountUsageRecordId({
        providerId: params.serviceId,
        accountSubjectId: `connected-service:${params.serviceId}:${params.profileId}`,
        subjectKind: "unknown",
        quotaScope: "account",
    });
}
