import { areSameAgentRoutingIdentity } from '@happier-dev/agents';

import { ProviderAccountUsageRecordIdSchema, type ProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1, type ProviderAccountUsageStateV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedServiceUsageSourceV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import {
    computeConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeLabelFormatter,
    type ConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeWindowMode,
} from '../connectedServiceQuotaGauge';

import type { ConnectedAccountIdentityPresenter } from '../maskAccountEmail';
import type { SessionUsageAccount } from '../resolveSessionUsageAccount';

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

type ProviderUsageCandidates = Readonly<{
    agentId: string | null;
    catalogProviderIds?: readonly string[];
    usageAccount: SessionUsageAccount;
    sourcesByRecordId: Readonly<Record<string, readonly QualifiedConnectedServiceUsageSourceV4[]>>;
    metadataRecordIds: ReadonlyArray<string>;
    accountUsageSnapshotsByRecordId: Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null | undefined>>;
}>;

function selectAccountUsageSnapshot(params: ProviderUsageCandidates): ProviderAccountUsageSnapshotV1 | null {
    const { usageAccount, agentId } = params;
    if (usageAccount.status === 'unknown') return null;

    const candidates: ProviderAccountUsageSnapshotV1[] = [];
    for (const recordId of normalizeProviderAccountUsageRecordIds(params.metadataRecordIds)) {
        const sources = params.sourcesByRecordId[recordId];
        const snapshot = params.accountUsageSnapshotsByRecordId[recordId];
        if (usageAccount.status === 'known') {
            if (snapshot && isDisplayableProviderAccountUsageSnapshot(snapshot)
                && sources?.some(source => sameQualifiedConnectedAccountRef(source.ref, usageAccount.account))) {
                candidates.push(snapshot);
            }
            continue;
        }

        // Only the Session's admitted references can establish native membership. A
        // missing source list cannot establish that a retained record is native.
        if (!sources) return null;
        if (sources.length > 0 || !snapshot || !agentId) continue;
        // Released native observations may use the Agent or the declared Provider spelling.
        if (params.catalogProviderIds?.includes(snapshot.providerId)
            || areSameAgentRoutingIdentity(agentId, snapshot.providerId)) {
            candidates.push(snapshot);
        }
    }

    if (usageAccount.status === 'known') return candidates.sort(compareProviderAccountUsageCandidates)[0] ?? null;
    const [native] = candidates;
    return candidates.length === 1 && native && isDisplayableProviderAccountUsageSnapshot(native) ? native : null;
}

export function selectProviderUsageDisplaySource(params: ProviderUsageCandidates & Readonly<{
    connectedServiceProfileRef: ProviderUsageDisplayConnectedServiceProfileRef | null;
    connectedServiceQuotaView: ConnectedServiceQuotaSnapshotV1 | null;
}>): ProviderUsageDisplaySnapshotSource | null {
    if (params.usageAccount.status === 'known' && params.connectedServiceProfileRef) {
        const snapshot = params.connectedServiceQuotaView;
        return snapshot ? { kind: 'connected_service_quota_view', snapshot } : null;
    }

    const snapshot = selectAccountUsageSnapshot(params);
    return snapshot ? { kind: 'account_usage', snapshot } : null;
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

export type ProviderAccountUsageEmptyRead = 'missing' | 'denied';
export type ProviderAccountUsageReadState = ProviderAccountUsageStateV1 | ProviderAccountUsageEmptyRead | 'failed';

export function resolveProviderAccountUsageReadState(params: Readonly<
    Parameters<typeof resolveProviderAccountUsageSnapshotState>[0] & { emptyRead?: ProviderAccountUsageEmptyRead }
>): ProviderAccountUsageReadState {
    if (!params.snapshot) return params.emptyRead ?? (params.hadError ? 'failed' : 'not_loaded');
    return resolveProviderAccountUsageSnapshotState(params);
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
    /**
     * The state its owner already resolved through
     * `resolveProviderAccountUsageReadState`. Recomputing it here would have to
     * invent a `hadError` value, and inventing `false` silently discards the
     * `error_last_known_good` the caller knows about.
     */
    state: ProviderAccountUsageReadState;
    activeModelId?: string | null;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
    windowModes?: readonly ConnectedServiceQuotaGaugeWindowMode[] | null;
    nowMs: number;
    formatter: ConnectedServiceQuotaGaugeLabelFormatter;
    providerDisplayName?: string | null;
    activeAccountDisplayLabel?: string | null;
    presentIdentity?: ConnectedAccountIdentityPresenter;
}>): ConnectedServiceQuotaGaugeViewModel | null {
    if (!params.snapshot) return null;
    if (params.state === 'not_loaded' || params.state === 'loaded_empty') return null;
    const viewModel = computeConnectedServiceQuotaGaugeViewModel({
        snapshot: toGaugeQuotaSnapshot(params.snapshot),
        activeModelId: params.activeModelId,
        windowMode: params.windowMode,
        windowModes: params.windowModes,
        nowMs: params.nowMs,
        formatter: params.formatter,
        providerDisplayName: params.providerDisplayName,
        activeAccountDisplayLabel: params.activeAccountDisplayLabel,
        presentIdentity: params.presentIdentity,
    });
    if (!viewModel) return null;
    // `error_last_known_good` means the retained snapshot is the newest good one and
    // the latest fetch failed. Its `fetchedAtMs` can still be inside the stale window,
    // so freshness derived from the snapshot alone would present failed data as current.
    return params.state === 'error_last_known_good' && !viewModel.isStale
        ? { ...viewModel, isStale: true }
        : viewModel;
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
