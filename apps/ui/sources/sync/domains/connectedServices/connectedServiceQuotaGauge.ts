import {
    readConnectedServiceLimitCategoryV1,
    type ConnectedServiceAuthGroupQuotaLimitSelectionV1,
    type ConnectedServiceQuotaMeterV1,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type ConnectedServiceQuotaSnapshotV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { getAgentCore, resolveAgentIdFromFlavor, resolveAgentIdFromConnectedServiceId } from '@/agents/registry/registryCore';

import type { MeterTone } from '@/components/ui/lists/MeterBar';

import { clampQuotaPct, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';
import {
    summarizeConnectedServiceQuotaRecoveryCredits,
    type ConnectedServiceQuotaRecoveryCreditSummary,
} from './connectedServiceQuotaRecoveryCreditSummary';
import { formatResetCountdown, isResetCountdownOutdated } from './formatResetCountdown';
import { resolveQuotaTone } from './resolveQuotaTone';
import { resolveSubscriptionEndTime } from './resolveSubscriptionEndTime';

import { resolveQuotaGaugeWindowModes, type ConnectedServiceQuotaGaugeWindowMode } from './quotaGaugeWindows';
import { projectConnectedServiceQuotaSnapshotForLimitSelection } from './projectConnectedServiceQuotaSnapshotForLimitSelection';

export type { ConnectedServiceQuotaGaugeWindowMode } from './quotaGaugeWindows';

export type ConnectedServiceQuotaGaugeTone = 'neutral' | 'warning' | 'critical';

type ConnectedServiceQuotaGaugeWindow = 'session' | 'daily' | 'weekly';

/** One composer ring. Its number is the remaining percent, like the main gauge. */
export type ConnectedServiceQuotaGaugeRing = Readonly<{
    meterId: string;
    label: string;
    usedPct: number;
    ringValueLabel: string;
    /** Remaining-first value text, e.g. "18% left". */
    valueLabel: string;
    tone: ConnectedServiceQuotaGaugeTone;
}>;

export type ConnectedServiceQuotaGaugeMeterRow = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    usedPct: number | null;
    detailRightSemantics: 'remaining';
    detailRightLabel: string;
    usedLimitSemantics: 'used' | null;
    usedLimitLabel: string | null;
    resetLabel: string | null;
    tone: ConnectedServiceQuotaGaugeTone;
}>;

export type ConnectedServiceQuotaGaugeLabelFormatter = Readonly<{
    unavailable: () => string;
    remaining: (params: Readonly<{ percent: string }>) => string;
    remainingWithReset: (params: Readonly<{ percent: string; reset: string }>) => string;
    used: (params: Readonly<{ used: string; limit: string }>) => string;
    durationNow: () => string;
    durationOutdated: () => string;
    durationDaysHours: (params: Readonly<{ days: number; hours: number }>) => string;
    durationHoursMinutes: (params: Readonly<{ hours: number; minutes: number }>) => string;
    durationHours: (params: Readonly<{ hours: number }>) => string;
    durationMinutes: (params: Readonly<{ minutes: number }>) => string;
    subscriptionEnds: (params: Readonly<{ date: string }>) => string;
    subscriptionEndsInDays: (params: Readonly<{ days: number }>) => string;
    subscriptionRenews: (params: Readonly<{ date: string }>) => string;
    subscriptionRenewsInDays: (params: Readonly<{ days: number }>) => string;
}>;

export type ConnectedServiceQuotaGaugeViewModel = Readonly<{
    subscription?: Readonly<{
        summary: string;
        period: string | null;
        renewal: 'on' | 'off' | 'unknown';
        renewalLabel: string;
        checkedLabel: string;
        notice: string | null;
        accessUntilLabel: string | null;
        isLastKnown: boolean;
    }>;
    serviceId: string;
    providerDisplayName: string | null;
    activeAccountDisplayLabel: string | null;
    remainingPct: number;
    usedPct: number;
    primaryValueSemantics: 'remaining';
    valueLabel: string;
    ringValueLabel: string;
    badgeLabel: string;
    scopePrefix: string | null;
    detailRightLabel: string;
    usedLimitLabel: string | null;
    resetLabel: string | null;
    tone: ConnectedServiceQuotaGaugeTone;
    isStale: boolean;
    recoveryCreditSummary: ConnectedServiceQuotaRecoveryCreditSummary | null;
    effectiveMeter: ConnectedServiceQuotaMeterV1;
    allMeterRows: readonly ConnectedServiceQuotaGaugeMeterRow[];
    /** Global windows followed by reliable favorites of the active account. */
    usageRings: readonly ConnectedServiceQuotaGaugeRing[];
}>;

export type ConnectedServiceQuotaGaugeSourceKind =
    | 'connected_service_group'
    | 'connected_service_profile'
    | 'codex_app_server_native'
    | 'native_runtime_evidence'
    | 'native_auth'
    | 'unsupported';

export type ConnectedServiceQuotaGaugeSource = Readonly<{
    providerId: string;
    sourceKind: ConnectedServiceQuotaGaugeSourceKind;
    snapshot: ConnectedServiceQuotaSnapshotV1;
    checkNowSupported: boolean;
}>;

const RUNTIME_ISSUE_QUOTA_PROJECTION_STALE_AFTER_MS = 30_000;
const RUNTIME_ISSUE_NATIVE_PROFILE_ID = 'native';
const RUNTIME_ISSUE_PROJECTION_PROFILE_ID = 'runtime';

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readMetadataString(meter: ConnectedServiceQuotaMeterV1, key: string): string | null {
    const topLevel = readRecord(meter)?.[key];
    if (typeof topLevel === 'string') return topLevel;
    const details = readRecord(meter.details);
    const detailValue = details?.[key];
    return typeof detailValue === 'string' ? detailValue : null;
}

function readMetadataNumber(meter: ConnectedServiceQuotaMeterV1, key: string): number | null {
    const topLevel = readRecord(meter)?.[key];
    if (typeof topLevel === 'number' && Number.isFinite(topLevel)) return topLevel;
    const details = readRecord(meter.details);
    const detailValue = details?.[key];
    return typeof detailValue === 'number' && Number.isFinite(detailValue) ? detailValue : null;
}

function meterNameTokens(meter: Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label'>): ReadonlySet<string> {
    return new Set(`${meter.meterId} ${meter.label}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function readPublicLimitCategory(meter: ConnectedServiceQuotaMeterV1): ReturnType<typeof readConnectedServiceLimitCategoryV1> {
    return readConnectedServiceLimitCategoryV1(
        readMetadataString(meter, 'limitCategory')
        ?? readMetadataString(meter, 'category')
        ?? readMetadataString(meter, 'stateFamily'),
    );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The usage window a meter measures: from its reported duration when present (Codex), otherwise
 * from its name (Claude `five_hour` / `seven_day_*`). Weekly names are checked before daily ones
 * because `seven_day` also carries a `day` token.
 */
function resolveConnectedServiceQuotaMeterWindow(
    meter: Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label' | 'windowDurationMs'>,
): ConnectedServiceQuotaGaugeWindow | null {
    const durationMs = meter.windowDurationMs;
    if (typeof durationMs === 'number' && durationMs > 0) {
        if (durationMs < DAY_MS) return 'session';
        if (durationMs < 2 * DAY_MS) return 'daily';
        if (durationMs < 8 * DAY_MS) return 'weekly';
        return null;
    }
    const tokens = meterNameTokens(meter);
    if (tokens.has('weekly') || tokens.has('week') || tokens.has('seven')) return 'weekly';
    if (tokens.has('daily') || tokens.has('day')) return 'daily';
    if (tokens.has('session') || tokens.has('hour') || tokens.has('5h')) return 'session';
    return null;
}

export function resolveConnectedServiceQuotaMeterScopePrefix(
    meter: Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label' | 'windowDurationMs'>,
): string | null {
    const window = resolveConnectedServiceQuotaMeterWindow(meter);
    if (window === 'daily') return 'd.';
    if (window === 'weekly') return 'w.';
    return null;
}

function meterMatchesWindowMode(
    meter: ConnectedServiceQuotaMeterV1,
    windowMode: ConnectedServiceQuotaGaugeWindowMode,
): boolean {
    if (windowMode === 'most_constrained') return true;
    if (windowMode === 'daily' || windowMode === 'weekly' || windowMode === 'session') {
        return resolveConnectedServiceQuotaMeterWindow(meter) === windowMode;
    }
    return meterNameTokens(meter).has(windowMode) || meter.meterId.toLowerCase() === windowMode;
}

export function isConnectedServiceQuotaMeterPercentRankable(meter: ConnectedServiceQuotaMeterV1): boolean {
    if (meter.status === 'unavailable') return false;

    const category = readPublicLimitCategory(meter);
    if (category && !['usage_limit', 'rate_limit'].includes(category)) {
        return false;
    }

    const confidence = readMetadataString(meter, 'confidence')
        ?? readMetadataString(meter, 'evidenceConfidence')
        ?? readMetadataString(meter, 'sourceConfidence');
    if (confidence && !['exact', 'derived', 'estimated', 'high', 'medium', 'reliable', 'confirmed'].includes(confidence)) {
        return false;
    }

    const reliability = readMetadataString(meter, 'reliability');
    if (reliability && !['reliable', 'confirmed'].includes(reliability)) {
        return false;
    }

    return deriveQuotaUtilizationPct(meter) !== null;
}

type ConnectedServiceQuotaComparableFamily = Readonly<{
    key: string;
    category: 'usage_limit' | 'rate_limit';
}>;

function resolveComparableFamily(meter: ConnectedServiceQuotaMeterV1): ConnectedServiceQuotaComparableFamily | null {
    const categoryRaw = readPublicLimitCategory(meter) ?? 'usage_limit';
    if (categoryRaw !== 'usage_limit' && categoryRaw !== 'rate_limit') return null;

    const unit = typeof meter.unit === 'string' && meter.unit.trim().length > 0 ? meter.unit.trim() : 'unknown';
    const familyId = readMetadataString(meter, 'quotaFamily')
        ?? readMetadataString(meter, 'limitFamily')
        ?? readMetadataString(meter, 'family')
        ?? readMetadataString(meter, 'providerLimitFamily')
        ?? '';
    return {
        category: categoryRaw,
        key: `${categoryRaw}:${unit}:${familyId}`,
    };
}

export function selectComparableConnectedServiceQuotaMeters(
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>,
): ConnectedServiceQuotaMeterV1[] {
    const rankable = meters.filter(isConnectedServiceQuotaMeterPercentRankable);
    const groups = new Map<string, {
        category: 'usage_limit' | 'rate_limit';
        firstIndex: number;
        meters: ConnectedServiceQuotaMeterV1[];
    }>();

    rankable.forEach((meter, index) => {
        const family = resolveComparableFamily(meter);
        if (!family) return;
        const existing = groups.get(family.key);
        if (existing) {
            existing.meters.push(meter);
        } else {
            groups.set(family.key, {
                category: family.category,
                firstIndex: index,
                meters: [meter],
            });
        }
    });

    const orderedGroups = Array.from(groups.values()).sort((a, b) => {
        if (a.category !== b.category) return a.category === 'usage_limit' ? -1 : 1;
        if (a.meters.length !== b.meters.length) return b.meters.length - a.meters.length;
        return a.firstIndex - b.firstIndex;
    });
    return orderedGroups[0]?.meters ?? [];
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

/**
 * Map the canonical `MeterTone` (owned by `resolveQuotaTone`) onto the gauge's
 * legacy tone vocabulary: danger ⇒ critical; warning ⇒ warning; success/neutral
 * ⇒ the gauge's healthy `neutral`. (`resolveQuotaTone` only emits the grey
 * `neutral` for the null/no-data case, which the gauge never feeds here.)
 */
function mapMeterToneToGaugeTone(tone: MeterTone): ConnectedServiceQuotaGaugeTone {
    if (tone === 'danger') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

function resolveTone(remainingPct: number | null): ConnectedServiceQuotaGaugeTone {
    return mapMeterToneToGaugeTone(resolveQuotaTone(remainingPct));
}

function buildMeterRow(
    meter: ConnectedServiceQuotaMeterV1,
    nowMs: number,
    formatter: ConnectedServiceQuotaGaugeLabelFormatter,
): ConnectedServiceQuotaGaugeMeterRow {
    const usedPct = deriveQuotaUtilizationPct(meter);

    const remainingPct = typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
        ? clampQuotaPct(meter.remainingPct)
        : usedPct === null ? null : clampQuotaPct(100 - usedPct);
    const remainingLabel = remainingPct === null ? '—' : `${Math.round(remainingPct)}%`;
    // An elapsed reset boundary means the snapshot predates its own reset — fall back to the plain
    // remaining label instead of composing the nonsense phrase "resets in outdated".
    const resetLabel = isResetCountdownOutdated(nowMs, meter.resetAtMs ?? meter.resetsAt)
        ? null
        : formatResetCountdown(nowMs, meter.resetAtMs ?? meter.resetsAt, formatter);
    return {
        meterId: meter.meterId,
        label: meter.label,
        remainingPct,
        usedPct,
        detailRightSemantics: 'remaining',
        detailRightLabel: remainingPct === null && resetLabel === null
            ? formatter.unavailable()
            : resetLabel
            ? formatter.remainingWithReset({ percent: remainingLabel, reset: resetLabel })
            : formatter.remaining({ percent: remainingLabel }),
        usedLimitSemantics: typeof meter.used === 'number' && typeof meter.limit === 'number'
            ? 'used'
            : null,
        usedLimitLabel: typeof meter.used === 'number' && typeof meter.limit === 'number'
            ? formatter.used({ used: formatNumber(meter.used), limit: formatNumber(meter.limit) })
            : null,
        resetLabel,
        tone: resolveTone(remainingPct),
    };
}

export function buildConnectedServiceQuotaGaugeMeterRows(
    meters: readonly ConnectedServiceQuotaMeterV1[],
    nowMs: number,
    formatter: ConnectedServiceQuotaGaugeLabelFormatter,
    pinnedMeterIds: readonly string[] = [],
): ConnectedServiceQuotaGaugeMeterRow[] {
    const rows: ConnectedServiceQuotaGaugeMeterRow[] = [];
    for (const meter of meters) {
        const category = readPublicLimitCategory(meter);
        if ((category && !['usage_limit', 'rate_limit'].includes(category))
            || rows.some((row) => row.meterId === meter.meterId)) continue;
        const row = buildMeterRow(meter, nowMs, formatter);
        // Provider adapters may emit empty placeholders for known windows. Keep
        // useful facts and user-pinned windows, without changing the snapshot.
        if (row.remainingPct !== null || row.usedLimitLabel !== null || row.resetLabel !== null
            || pinnedMeterIds.includes(row.meterId)) rows.push(row);
    }
    return rows;
}

export function computeConnectedServiceQuotaGaugeViewModel(_params: Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
    windowModes?: readonly ConnectedServiceQuotaGaugeWindowMode[] | null;
    /** Extra favorites from the account currently used by the session. */
    additionalMeterIds?: readonly string[];
    /** Null means the bound pool policy has not been read yet. */
    quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1 | null;
    nowMs: number;
    formatter: ConnectedServiceQuotaGaugeLabelFormatter;
    providerDisplayName?: string | null;
    activeAccountDisplayLabel?: string | null;
    activeModelId?: string | null;
}>): ConnectedServiceQuotaGaugeViewModel | null {
    if (_params.quotaLimitSelection === null) return null;
    const selectedSnapshot = projectConnectedServiceQuotaSnapshotForLimitSelection(_params.snapshot, _params.quotaLimitSelection);
    if (!selectedSnapshot) return null;
    const agentId = resolveAgentIdFromConnectedServiceId(selectedSnapshot.serviceId);
    const projectForModel = agentId ? getAgentCore(agentId).projectQuotaSnapshotForModel : undefined;
    const snapshot = projectForModel ? projectForModel(selectedSnapshot, _params.activeModelId) : selectedSnapshot;
    if (!snapshot) return null;
    const params = { ..._params, snapshot };

    const rankableMeters = selectComparableConnectedServiceQuotaMeters(params.snapshot.meters);
    const allMeterRows = buildConnectedServiceQuotaGaugeMeterRows(
        [...rankableMeters, ...params.snapshot.meters], params.nowMs, params.formatter, params.additionalMeterIds,
    );
    if (allMeterRows.length === 0) return null;

    const windowModes = resolveQuotaGaugeWindowModes(params.windowModes, params.windowMode);
    const selectedMeters = windowModes.flatMap((mode) => {
        const matching = rankableMeters.filter((meter) => meterMatchesWindowMode(meter, mode));
        // Preserve the predecessor single-window fallback; explicit multi-selections omit missing windows.
        const candidates = matching.length || params.windowModes?.length ? matching : rankableMeters;
        let selected: ConnectedServiceQuotaMeterV1 | null = null;
        let leastRemaining = Number.POSITIVE_INFINITY;
        for (const meter of candidates) {
            const usedPct = deriveQuotaUtilizationPct(meter);
            if (usedPct === null) continue;
            const remaining = typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
                ? clampQuotaPct(meter.remainingPct) : clampQuotaPct(100 - usedPct);
            if (remaining < leastRemaining) {
                selected = meter;
                leastRemaining = remaining;
            }
        }
        return selected ? [{ meter: selected, remainingPct: leastRemaining }] : [];
    });
    // Favorites append to global windows after Pool filtering; dedupe shared meters.
    for (const meterId of params.additionalMeterIds ?? []) {
        if (selectedMeters.some(({ meter }) => meter.meterId === meterId)) continue;
        const meter = params.snapshot.meters.find((candidate) => candidate.meterId === meterId
            && isConnectedServiceQuotaMeterPercentRankable(candidate));
        const row = meter ? buildMeterRow(meter, params.nowMs, params.formatter) : null;
        if (meter && row?.usedPct !== null && row?.remainingPct != null) {
            selectedMeters.push({ meter, remainingPct: row.remainingPct });
        }
    }
    const effectiveMeter = selectedMeters[0]?.meter;
    const effectiveRemainingPct = selectedMeters[0]?.remainingPct;
    if (!effectiveMeter || effectiveRemainingPct === undefined) return null;

    const selectedRow = buildMeterRow(effectiveMeter, params.nowMs, params.formatter);
    if (selectedRow.usedPct === null) return null;

    const displayedMeterRows = [...new Set(selectedMeters.map(({ meter }) => meter.meterId))].flatMap((meterId) => {
        const meter = params.snapshot?.meters.find((candidate) => candidate.meterId === meterId
            && isConnectedServiceQuotaMeterPercentRankable(candidate));
        const row = meter ? buildMeterRow(meter, params.nowMs, params.formatter) : null;
        return row && meter && row.usedPct !== null && row.remainingPct !== null
            ? [{ meter, row: { ...row, usedPct: row.usedPct, remainingPct: row.remainingPct } }] : [];
    });
    const selectedWindowPrefix = windowModes[0] === 'most_constrained'
        ? null
        : resolveConnectedServiceQuotaMeterScopePrefix(effectiveMeter);
    const roundedRemaining = Math.round(effectiveRemainingPct);
    const remainingValueLabel = params.formatter.remaining({ percent: `${roundedRemaining}%` });
    const staleAt = params.snapshot.fetchedAt + params.snapshot.staleAfterMs;
    const isStale = params.nowMs > staleAt;
    const sourceSubscription = params.snapshot.subscription;
    const subscriptionEndTime = sourceSubscription && typeof sourceSubscription.currentPeriodEndAtMs === 'number'
        ? resolveSubscriptionEndTime({
            nowMs: params.nowMs,
            endAtMs: sourceSubscription.currentPeriodEndAtMs,
            formatDate: (endAtMs) => new Date(endAtMs).toLocaleDateString(),
        })
        : null;
    const subscription = sourceSubscription ? {
        summary: sourceSubscription.status === 'none' ? 'No subscription'
            : sourceSubscription.status === 'unavailable' ? 'Subscription details unavailable'
                : subscriptionEndTime
                    ? sourceSubscription.renewal === 'on'
                        ? subscriptionEndTime.kind === 'relativeDays'
                            ? params.formatter.subscriptionRenewsInDays({ days: subscriptionEndTime.days })
                            : params.formatter.subscriptionRenews({ date: subscriptionEndTime.date })
                        : subscriptionEndTime.kind === 'relativeDays'
                            ? params.formatter.subscriptionEndsInDays({ days: subscriptionEndTime.days })
                            : params.formatter.subscriptionEnds({ date: subscriptionEndTime.date })
                    : 'Subscription active',
        period: sourceSubscription.currentPeriodStartAtMs && sourceSubscription.currentPeriodEndAtMs
            ? `${new Date(sourceSubscription.currentPeriodStartAtMs).toLocaleDateString()} – ${new Date(sourceSubscription.currentPeriodEndAtMs).toLocaleDateString()}` : null,
        renewal: sourceSubscription.renewal,
        renewalLabel: sourceSubscription.renewal === 'on' ? 'On' : sourceSubscription.renewal === 'off' ? 'Off' : 'Unknown',
        checkedLabel: `Checked ${new Date(sourceSubscription.observedAtMs).toLocaleString()}`,
        notice: sourceSubscription.lastRefreshError ? 'Subscription details may be out of date.' : null,
        accessUntilLabel: sourceSubscription.currentPeriodEndAtMs ? `Access continues until ${new Date(sourceSubscription.currentPeriodEndAtMs).toLocaleDateString()}` : null,
        isLastKnown: sourceSubscription.status === 'unavailable',
    } : undefined;
    return {
        subscription,
        serviceId: params.snapshot.serviceId,
        providerDisplayName: params.providerDisplayName ?? null,
        activeAccountDisplayLabel: params.activeAccountDisplayLabel ?? params.snapshot.accountLabel ?? null,
        remainingPct: effectiveRemainingPct,
        usedPct: selectedRow.usedPct,
        primaryValueSemantics: 'remaining',
        valueLabel: remainingValueLabel,
        ringValueLabel: String(roundedRemaining),
        badgeLabel: selectedWindowPrefix ? `${selectedWindowPrefix} ${remainingValueLabel}` : remainingValueLabel,
        scopePrefix: selectedWindowPrefix,
        detailRightLabel: selectedRow.detailRightLabel,
        usedLimitLabel: selectedRow.usedLimitLabel,
        resetLabel: selectedRow.resetLabel,
        tone: selectedRow.tone,
        isStale,
        recoveryCreditSummary: summarizeConnectedServiceQuotaRecoveryCredits(params.snapshot.recoveryCredits, params.nowMs),
        effectiveMeter,
        allMeterRows,
        usageRings: displayedMeterRows.map(({ meter, row }) => {
            const ringRemaining = Math.round(row.remainingPct);
            return {
                meterId: meter.meterId,
                label: row.label,
                usedPct: row.usedPct,
                ringValueLabel: String(ringRemaining),
                valueLabel: params.formatter.remaining({ percent: `${ringRemaining}%` }),
                tone: row.tone,
            };
        }),
    };
}

export function resolveConnectedServiceQuotaGaugeSource(_params: Readonly<{
    providerId: string;
    sourceKind: ConnectedServiceQuotaGaugeSourceKind;
    reason?: string;
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
}>): ConnectedServiceQuotaGaugeSource | null {
    const params = _params;
    if (!params.snapshot) return null;
    if (params.sourceKind === 'unsupported') return null;

    const checkNowSupported =
        params.sourceKind === 'connected_service_group'
        || params.sourceKind === 'connected_service_profile'
        || params.sourceKind === 'codex_app_server_native';

    return {
        providerId: params.providerId,
        sourceKind: params.sourceKind,
        snapshot: params.snapshot,
        checkNowSupported,
    };
}

function resolveRuntimeIssueQuotaServiceId(issue: SessionRuntimeIssueV1): ConnectedServiceQuotaSnapshotV1['serviceId'] | null {
    const refServiceId = issue.usageLimit?.quotaSnapshotRef?.serviceId;
    if (refServiceId) return refServiceId;
    const connectedServiceId = issue.usageLimit?.connectedService?.serviceId;
    if (connectedServiceId) return connectedServiceId;

    // Last-resort fallback: resolve through the agents registry so provider
    // facts stay catalog-owned. The first supported connected service id is the
    // provider's canonical native default (mirrors the CLI adapters'
    // defaultNativeServiceId); providers without connected-services support
    // stay gauge-less.
    const agentId = resolveAgentIdFromFlavor(issue.provider);
    if (!agentId) return null;
    return getAgentCore(agentId).connectedServices?.supportedServiceIds[0] ?? null;
}

function resolveRuntimeIssueQuotaProfileId(issue: SessionRuntimeIssueV1): string {
    const profileId = issue.usageLimit?.quotaSnapshotRef?.profileId?.trim();
    if (profileId) return profileId;
    const connectedProfileId = issue.usageLimit?.connectedService?.profileId?.trim();
    if (connectedProfileId) return connectedProfileId;
    const connectedGroupId = issue.usageLimit?.connectedService?.groupId?.trim();
    if (connectedGroupId) return connectedGroupId;
    return issue.usageLimit?.quotaSnapshotRef || issue.usageLimit?.connectedService
        ? RUNTIME_ISSUE_PROJECTION_PROFILE_ID
        : RUNTIME_ISSUE_NATIVE_PROFILE_ID;
}

function resolveRuntimeIssueQuotaAccountLabel(issue: SessionRuntimeIssueV1): string | null {
    const refGroupId = issue.usageLimit?.quotaSnapshotRef?.groupId?.trim();
    if (refGroupId) return refGroupId;
    const connectedGroupId = issue.usageLimit?.connectedService?.groupId?.trim();
    if (connectedGroupId) return connectedGroupId;
    return null;
}

export function deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(
    issue: SessionRuntimeIssueV1 | null | undefined,
): ConnectedServiceQuotaSnapshotV1 | null {
    const usageLimit = issue?.usageLimit;
    if (!usageLimit) return null;
    const runtimeLimitCategory = readConnectedServiceLimitCategoryV1(usageLimit.limitCategory);
    if (runtimeLimitCategory && !['usage_limit', 'rate_limit'].includes(runtimeLimitCategory)) return null;

    const serviceId = resolveRuntimeIssueQuotaServiceId(issue);
    if (!serviceId) return null;

    const windows = usageLimit.allWindows && usageLimit.allWindows.length > 0
        ? usageLimit.allWindows
        : usageLimit.effectiveMeterId && typeof usageLimit.effectiveRemainingPct === 'number'
            ? [{
                meterId: usageLimit.effectiveMeterId,
                scope: usageLimit.effectiveMeterId,
                remainingPct: usageLimit.effectiveRemainingPct,
                resetAtMs: usageLimit.resetAtMs ?? undefined,
                status: 'ok',
            }]
            : typeof usageLimit.utilization === 'number' && Number.isFinite(usageLimit.utilization)
                ? [{
                    meterId: usageLimit.providerLimitId ?? usageLimit.effectiveMeterId ?? 'usage_limit',
                    scope: usageLimit.providerLimitId ?? usageLimit.effectiveMeterId ?? usageLimit.quotaScope,
                    remainingPct: clampQuotaPct(100 - usageLimit.utilization),
                    resetAtMs: usageLimit.resetAtMs ?? undefined,
                    status: 'ok',
                }]
            : [];
    const meters: ConnectedServiceQuotaMeterV1[] = windows
        .map((window): ConnectedServiceQuotaMeterV1 | null => {
            if (typeof window.remainingPct !== 'number' || !Number.isFinite(window.remainingPct)) return null;
            const remainingPct = clampQuotaPct(window.remainingPct);
            return {
                meterId: window.meterId,
                label: window.scope ?? window.meterId,
                used: null,
                limit: null,
                remainingPct,
                resetAtMs: typeof window.resetAtMs === 'number' ? window.resetAtMs : null,
                unit: 'unknown',
                utilizationPct: clampQuotaPct(100 - remainingPct),
                resetsAt: typeof window.resetAtMs === 'number' ? window.resetAtMs : null,
                status: window.status === 'ok' || window.status === undefined ? 'ok' : 'unavailable',
                confidence: 'exact',
                details: {
                    limitCategory: runtimeLimitCategory ?? 'usage_limit',
                },
            };
        })
        .filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null);

    if (meters.length === 0) return null;

    const providerId = issue.provider?.trim() || null;
    const evidence = usageLimit.providerLimitId
        ? {
            kind: 'runtime_usage_limit',
            observedAtMs: issue.occurredAt,
            providerLimitId: usageLimit.providerLimitId,
        }
        : {
            kind: 'runtime_usage_limit',
            observedAtMs: issue.occurredAt,
        };

    return {
        v: 1,
        serviceId,
        profileId: resolveRuntimeIssueQuotaProfileId(issue),
        fetchedAt: usageLimit.quotaSnapshotRef?.fetchedAtMs ?? issue.occurredAt,
        staleAfterMs: RUNTIME_ISSUE_QUOTA_PROJECTION_STALE_AFTER_MS,
        planLabel: usageLimit.planType ?? null,
        accountLabel: resolveRuntimeIssueQuotaAccountLabel(issue),
        ...(providerId ? { providerId } : {}),
        source: 'runtime_event',
        confidence: 'exact',
        evidence,
        meters,
    };
}

/**
 * Provenance of the session's connected-service quota snapshot ref, reported by
 * `resolveConnectedServiceQuotaProfileRefForSession`.
 */
export type ConnectedServiceQuotaProfileRefProvenance =
    | 'connected_binding_group'
    | 'connected_binding_profile'
    | 'published_quota_ref';

// Mirrors native provider account-usage alias profile ids (`acct:<hash>` /
// `native:<hash>`) used when a runtime publishes native-auth usage refs.
const NATIVE_QUOTA_PROFILE_ID_PATTERN = /^(?:acct|native):/;

function classifyConnectedServiceGaugeSourceKind(params: Readonly<{
    provenance: ConnectedServiceQuotaProfileRefProvenance | null | undefined;
    profileId: string;
    sessionCheckNowSupported: boolean;
}>): ConnectedServiceQuotaGaugeSourceKind {
    switch (params.provenance) {
        case 'connected_binding_group':
            return 'connected_service_group';
        case 'connected_binding_profile':
            return 'connected_service_profile';
        case 'published_quota_ref':
            if (!NATIVE_QUOTA_PROFILE_ID_PATTERN.test(params.profileId)) {
                return 'connected_service_profile';
            }
            // Native-auth published snapshots: only runtimes whose session
            // surface owns live quota control (registry-resolved check-now
            // support, e.g. the Codex app-server) keep an actionable source.
            return params.sessionCheckNowSupported ? 'codex_app_server_native' : 'native_auth';
        default:
            return 'unsupported';
    }
}

function snapshotsIdentifySameQuotaProfile(
    left: ConnectedServiceQuotaSnapshotV1,
    right: ConnectedServiceQuotaSnapshotV1,
): boolean {
    return left.serviceId === right.serviceId && left.profileId === right.profileId;
}

function withRecoveryCredits(
    snapshot: ConnectedServiceQuotaSnapshotV1,
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
): ConnectedServiceQuotaSnapshotV1 {
    if (!recoveryCredits || snapshot.recoveryCredits) return snapshot;
    return { ...snapshot, recoveryCredits };
}

function quotaSnapshotFetchedAtMs(snapshot: ConnectedServiceQuotaSnapshotV1): number {
    return snapshot.fetchedAtMs ?? snapshot.fetchedAt;
}

function shouldPreferRuntimeIssueQuotaSnapshot(params: Readonly<{
    runtimeSnapshot: ConnectedServiceQuotaSnapshotV1;
    connectedSnapshot: ConnectedServiceQuotaSnapshotV1 | null;
}>): boolean {
    if (!params.connectedSnapshot) return true;
    const runtimeFetchedAtMs = quotaSnapshotFetchedAtMs(params.runtimeSnapshot);
    const runtimeStaleAtMs = runtimeFetchedAtMs + params.runtimeSnapshot.staleAfterMs;
    const connectedFetchedAtMs = quotaSnapshotFetchedAtMs(params.connectedSnapshot);
    return runtimeFetchedAtMs >= connectedFetchedAtMs || runtimeStaleAtMs >= connectedFetchedAtMs;
}

/**
 * Production owner of the session provider-usage gauge source: routes both the
 * runtime-evidence projection and the polled connected-service snapshot
 * through the explicit gauge-source matrix so suppression ("no fake gauges")
 * and check-now derivation have one owner.
 */
export function selectConnectedServiceSessionProviderUsageGaugeSource(params: Readonly<{
    providerId: string | null;
    connectedServiceSnapshot: ConnectedServiceQuotaSnapshotV1 | null;
    connectedServiceRefProvenance: ConnectedServiceQuotaProfileRefProvenance | null | undefined;
    sessionCheckNowSupported?: boolean;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    runtimeIssue: SessionRuntimeIssueV1 | null | undefined;
}>): ConnectedServiceQuotaGaugeSource | null {
    const runtimeIssueQuotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(params.runtimeIssue);
    if (runtimeIssueQuotaSnapshot && shouldPreferRuntimeIssueQuotaSnapshot({
        runtimeSnapshot: runtimeIssueQuotaSnapshot,
        connectedSnapshot: params.connectedServiceSnapshot,
    })) {
        const recoveryCredits = params.connectedServiceSnapshot
            && snapshotsIdentifySameQuotaProfile(runtimeIssueQuotaSnapshot, params.connectedServiceSnapshot)
            ? params.connectedServiceSnapshot.recoveryCredits ?? null
            : params.recoveryCredits ?? null;
        return resolveConnectedServiceQuotaGaugeSource({
            providerId: params.providerId ?? runtimeIssueQuotaSnapshot.providerId ?? runtimeIssueQuotaSnapshot.serviceId,
            sourceKind: 'native_runtime_evidence',
            snapshot: withRecoveryCredits(runtimeIssueQuotaSnapshot, recoveryCredits),
        });
    }
    if (!params.connectedServiceSnapshot) return null;
    return resolveConnectedServiceQuotaGaugeSource({
        providerId: params.providerId ?? params.connectedServiceSnapshot.serviceId,
        sourceKind: classifyConnectedServiceGaugeSourceKind({
            provenance: params.connectedServiceRefProvenance,
            profileId: params.connectedServiceSnapshot.profileId,
            sessionCheckNowSupported: params.sessionCheckNowSupported === true,
        }),
        snapshot: params.connectedServiceSnapshot,
    });
}
