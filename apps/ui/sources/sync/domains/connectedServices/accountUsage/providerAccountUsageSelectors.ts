import {
    resolveAgentIdFromFlavor,
    isAgentId,
} from '@/agents/catalog/catalog';

import {
    ProviderAccountUsageRecordIdSchema,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
    type ProviderAccountUsageStateV1,
} from '@happier-dev/protocol';

import {
    computeConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeLabelFormatter,
    type ConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeWindowMode,
} from '../connectedServiceQuotaGauge';

export type ProviderAccountUsageSnapshotsByRecordId = Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null>>;

export type ProviderUsageDisplaySnapshotSource =
    | Readonly<{
        kind: 'connected_service_quota_view';
        snapshot: ConnectedServiceQuotaSnapshotV1;
    }>
    | Readonly<{
        kind: 'account_usage';
        snapshot: ProviderAccountUsageSnapshotV1;
    }>;

export type ProviderUsageDisplayConnectedServiceProfileRef = Readonly<{
    serviceId: string;
    profileId: string;
}>;

function isDisplayableProviderAccountUsageSnapshot(snapshot: ProviderAccountUsageSnapshotV1): boolean {
    if (snapshot.state === 'not_loaded' || snapshot.state === 'loaded_empty') return false;
    return snapshot.meters.length > 0;
}

function providerAccountUsageSnapshotMatchesRequestedProvider(params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    providerId: string | null | undefined;
}>): boolean {
    const requestedProviderId = String(params.providerId ?? '').trim();
    if (!requestedProviderId) return true;
    if (params.snapshot.providerId === requestedProviderId) return true;
    const agentId = isAgentId(requestedProviderId)
        ? requestedProviderId
        : resolveAgentIdFromFlavor(requestedProviderId);
    return agentId === params.snapshot.providerId;
}

function compareProviderAccountUsageCandidates(
    left: ProviderAccountUsageSnapshotV1,
    right: ProviderAccountUsageSnapshotV1,
): number {
    const leftStable = left.accountSubject.kind === 'providerSubject' ? 0 : 1;
    const rightStable = right.accountSubject.kind === 'providerSubject' ? 0 : 1;
    if (leftStable !== rightStable) return leftStable - rightStable;

    const leftKnownSubject = left.recordKey.subjectKind === 'unknown' ? 1 : 0;
    const rightKnownSubject = right.recordKey.subjectKind === 'unknown' ? 1 : 0;
    if (leftKnownSubject !== rightKnownSubject) return leftKnownSubject - rightKnownSubject;

    if (left.fetchedAtMs !== right.fetchedAtMs) return right.fetchedAtMs - left.fetchedAtMs;
    if (left.observedAtMs !== right.observedAtMs) return right.observedAtMs - left.observedAtMs;
    return left.recordId.localeCompare(right.recordId);
}

function selectCandidateAccountUsageSnapshots(params: Readonly<{
    providerId: string | null;
    metadataRecordIds: ReadonlyArray<string>;
    accountUsageSnapshotsByRecordId: Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null | undefined>>;
}>): ProviderAccountUsageSnapshotV1[] {
    const candidates: ProviderAccountUsageSnapshotV1[] = [];
    const seenRecordIds = new Set<string>();
    for (const rawRecordId of params.metadataRecordIds) {
        const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(rawRecordId.trim());
        if (!parsedRecordId.success || seenRecordIds.has(parsedRecordId.data)) continue;
        seenRecordIds.add(parsedRecordId.data);
        const snapshot = params.accountUsageSnapshotsByRecordId[parsedRecordId.data] ?? null;
        if (!snapshot) continue;
        if (!isDisplayableProviderAccountUsageSnapshot(snapshot)) continue;
        if (!providerAccountUsageSnapshotMatchesRequestedProvider({ snapshot, providerId: params.providerId })) continue;
        candidates.push(snapshot);
    }
    return candidates.sort(compareProviderAccountUsageCandidates);
}

export function selectProviderUsageDisplaySource(params: Readonly<{
    providerId: string | null;
    metadataRecordIds: ReadonlyArray<string>;
    accountUsageSnapshotsByRecordId: Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null | undefined>>;
    connectedServiceProfileRef: ProviderUsageDisplayConnectedServiceProfileRef | null;
    connectedServiceQuotaView: ConnectedServiceQuotaSnapshotV1 | null;
}>): ProviderUsageDisplaySnapshotSource | null {
    if (params.connectedServiceProfileRef) {
        return params.connectedServiceQuotaView
            ? {
                kind: 'connected_service_quota_view',
                snapshot: params.connectedServiceQuotaView,
            }
            : null;
    }

    const nativeSnapshot = selectCandidateAccountUsageSnapshots(params)[0] ?? null;
    if (nativeSnapshot) {
        return {
            kind: 'account_usage',
            snapshot: nativeSnapshot,
        };
    }

    return params.connectedServiceQuotaView
        ? {
            kind: 'connected_service_quota_view',
            snapshot: params.connectedServiceQuotaView,
        }
        : null;
}

export function resolveProviderAccountUsageSnapshotState(params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    loading: boolean;
    hadError: boolean;
    nowMs: number;
}>): ProviderAccountUsageStateV1 {
    if (!params.snapshot) return 'not_loaded';
    if (params.hadError) return 'error_last_known_good';
    if (params.snapshot.state === 'error_last_known_good') return 'error_last_known_good';
    if (params.snapshot.state === 'not_loaded') return 'not_loaded';
    if (params.snapshot.state === 'loaded_empty') return 'loaded_empty';
    if (params.snapshot.state === 'stale_data') return 'stale_data';
    if (params.snapshot.meters.length === 0) return 'loaded_empty';
    if (params.nowMs > params.snapshot.fetchedAtMs + params.snapshot.staleAfterMs) return 'stale_data';
    return 'loaded_data';
}

function toGaugeQuotaSnapshot(snapshot: ProviderAccountUsageSnapshotV1): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: snapshot.providerId as ConnectedServiceQuotaSnapshotV1['serviceId'],
        profileId: snapshot.recordId,
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        planLabel: snapshot.planLabel ?? null,
        accountLabel: snapshot.accountLabel ?? null,
        providerId: snapshot.providerId,
        activeAccountId: snapshot.recordKey.accountSubjectId,
        fetchedAtMs: snapshot.fetchedAtMs,
        staleAtMs: snapshot.fetchedAtMs + snapshot.staleAfterMs,
        ...(snapshot.recoveryCredits ? { recoveryCredits: snapshot.recoveryCredits } : {}),
        meters: snapshot.meters,
    };
}

export function computeProviderAccountUsageGaugeViewModel(params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
    nowMs: number;
    formatter: ConnectedServiceQuotaGaugeLabelFormatter;
    providerDisplayName?: string | null;
    activeAccountDisplayLabel?: string | null;
}>): ConnectedServiceQuotaGaugeViewModel | null {
    if (!params.snapshot) return null;
    const state = resolveProviderAccountUsageSnapshotState({
        snapshot: params.snapshot,
        loading: false,
        hadError: false,
        nowMs: params.nowMs,
    });
    if (state === 'not_loaded' || state === 'loaded_empty') return null;
    return computeConnectedServiceQuotaGaugeViewModel({
        snapshot: toGaugeQuotaSnapshot(params.snapshot),
        windowMode: params.windowMode,
        nowMs: params.nowMs,
        formatter: params.formatter,
        providerDisplayName: params.providerDisplayName,
        activeAccountDisplayLabel: params.activeAccountDisplayLabel,
    });
}

export function normalizeProviderAccountUsageRecordIds(
    recordIds: ReadonlyArray<string>,
): ProviderAccountUsageRecordId[] {
    const next: ProviderAccountUsageRecordId[] = [];
    const seen = new Set<string>();
    for (const rawRecordId of recordIds) {
        const parsed = ProviderAccountUsageRecordIdSchema.safeParse(rawRecordId.trim());
        if (!parsed.success || seen.has(parsed.data)) continue;
        seen.add(parsed.data);
        next.push(parsed.data);
    }
    return next;
}
