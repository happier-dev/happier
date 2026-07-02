import {
    projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
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
import { connectedServiceProfileKey } from '../connectedServiceProfilePreferences';

export type ProviderAccountUsageSnapshotsByRecordId = Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null>>;

export function projectProviderAccountUsageSnapshotForConnectedServiceAlias(params: Readonly<{
    snapshotsByRecordId: ProviderAccountUsageSnapshotsByRecordId;
    serviceId: string;
    profileId: string;
}>): ConnectedServiceQuotaSnapshotV1 | null {
    const candidates = Object.values(params.snapshotsByRecordId)
        .filter((snapshot): snapshot is ProviderAccountUsageSnapshotV1 => Boolean(snapshot));
    let selected: Readonly<{
        snapshot: ProviderAccountUsageSnapshotV1;
        projection: ConnectedServiceQuotaSnapshotV1;
    }> | null = null;
    for (const snapshot of candidates) {
        const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
            snapshot,
            serviceId: params.serviceId,
            profileId: params.profileId,
        });
        if (!projected) continue;
        const candidate = { snapshot, projection: projected };
        if (!selected || compareProjectedProviderAccountUsageCandidate(candidate, selected) < 0) {
            selected = candidate;
        }
    }
    return selected?.projection ?? null;
}

function compareProjectedProviderAccountUsageCandidate(
    left: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; projection: ConnectedServiceQuotaSnapshotV1 }>,
    right: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; projection: ConnectedServiceQuotaSnapshotV1 }>,
): number {
    const leftStable = left.snapshot.accountSubject.kind === 'providerSubject' ? 0 : 1;
    const rightStable = right.snapshot.accountSubject.kind === 'providerSubject' ? 0 : 1;
    if (leftStable !== rightStable) return leftStable - rightStable;

    const leftKnownSubject = left.snapshot.recordKey.subjectKind === 'unknown' ? 1 : 0;
    const rightKnownSubject = right.snapshot.recordKey.subjectKind === 'unknown' ? 1 : 0;
    if (leftKnownSubject !== rightKnownSubject) return leftKnownSubject - rightKnownSubject;

    const leftFetched = left.snapshot.fetchedAtMs;
    const rightFetched = right.snapshot.fetchedAtMs;
    if (leftFetched !== rightFetched) return rightFetched - leftFetched;

    const leftObserved = left.snapshot.observedAtMs;
    const rightObserved = right.snapshot.observedAtMs;
    if (leftObserved !== rightObserved) return rightObserved - leftObserved;

    return left.snapshot.recordId.localeCompare(right.snapshot.recordId);
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
    const connectedAlias = snapshot.aliases.find((alias) => (
        (alias.kind === 'connectedServiceProfile' || alias.kind === 'connectedServiceGroupMember')
        && alias.serviceId
        && alias.profileId
    ));
    return {
        v: 1,
        serviceId: (connectedAlias?.serviceId ?? snapshot.providerId) as ConnectedServiceQuotaSnapshotV1['serviceId'],
        profileId: connectedAlias?.profileId ?? snapshot.recordId,
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        planLabel: snapshot.planLabel ?? null,
        accountLabel: snapshot.accountLabel ?? null,
        providerId: snapshot.providerId,
        activeAccountId: snapshot.recordKey.accountSubjectId,
        fetchedAtMs: snapshot.fetchedAtMs,
        staleAtMs: snapshot.fetchedAtMs + snapshot.staleAfterMs,
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

export function selectProviderAccountUsageSnapshotsByAlias(params: Readonly<{
    snapshotsByRecordId: ProviderAccountUsageSnapshotsByRecordId;
    aliases: ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>;
}>): Record<string, ConnectedServiceQuotaSnapshotV1 | null> {
    const projectedByKey: Record<string, ConnectedServiceQuotaSnapshotV1 | null> = {};
    for (const alias of params.aliases) {
        const key = connectedServiceProfileKey(alias);
        projectedByKey[key] = projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: params.snapshotsByRecordId,
            serviceId: alias.serviceId,
            profileId: alias.profileId,
        });
    }
    return projectedByKey;
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
