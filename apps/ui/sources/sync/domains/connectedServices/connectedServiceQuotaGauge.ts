import type {
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaSnapshotV1,
    SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import {
    parseQualifiedPluginContributionKey,
    readBuiltInLegacyConnectedAccountServiceKeyIngress,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    readConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol';

import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { clampQuotaPct, deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';
import {
    resolveQuotaTone,
} from './resolveQuotaTone';
import { formatResetCountdown } from './formatResetCountdown';
import { isConnectedServiceQuotaMeterVisible } from './connectedServiceQuotaMeterVisibility';

export type ConnectedServiceQuotaGaugeWindowMode =
    | 'most_constrained'
    | 'daily'
    | 'weekly'
    | 'primary'
    | 'secondary'
    | 'session';

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

export type ConnectedServiceQuotaRecoveryCreditSummary = Readonly<{
    availableCount: number;
    nextExpiresAtMs: number | null;
    providerCreditId: string | null;
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
    /** When the window resets (epoch ms), when the provider reports it. */
    resetsAt: number | null;
    tone: ConnectedServiceQuotaGaugeTone;
}>;

export type ConnectedServiceQuotaGaugeLabelFormatter = Readonly<{
    remaining: (params: Readonly<{ percent: string }>) => string;
    remainingWithReset: (params: Readonly<{ percent: string; reset: string }>) => string;
    used: (params: Readonly<{ used: string; limit: string }>) => string;
    durationNow: () => string;
    durationOutdated: () => string;
    durationDaysHours: (params: Readonly<{ days: number; hours: number }>) => string;
    durationHoursMinutes: (params: Readonly<{ hours: number; minutes: number }>) => string;
    durationHours: (params: Readonly<{ hours: number }>) => string;
    durationMinutes: (params: Readonly<{ minutes: number }>) => string;
}>;

export type ConnectedServiceQuotaGaugeViewModel = Readonly<{
    /** Legacy service identity when the snapshot carried one; null for qualified (V4) snapshots. */
    serviceId: string | null;
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
    effectiveMeter: ConnectedServiceQuotaMeterV1;
    allMeterRows: readonly ConnectedServiceQuotaGaugeMeterRow[];
    /** The main meter, followed by the account's pinned meters that the snapshot reports. */
    usageRings: readonly ConnectedServiceQuotaGaugeRing[];
    recoveryCreditSummary: ConnectedServiceQuotaRecoveryCreditSummary | null;
}>;

// Tone boundaries come from the single canonical owner (`resolveQuotaTone`); the
// gauge maps them onto its own `neutral | warning | critical` vocabulary below.
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

function readPublicLimitCategory(meter: ConnectedServiceQuotaMeterV1): ReturnType<typeof readConnectedServiceLimitCategoryV1> {
    return readConnectedServiceLimitCategoryV1(
        readMetadataString(meter, 'limitCategory')
        ?? readMetadataString(meter, 'category')
        ?? readMetadataString(meter, 'stateFamily'),
    );
}

function meterNameTokens(meter: Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label'>): ReadonlySet<string> {
    return new Set(`${meter.meterId} ${meter.label}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
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

export function summarizeConnectedServiceQuotaRecoveryCredits(
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
    nowMs: number,
): ConnectedServiceQuotaRecoveryCreditSummary | null {
    if (!recoveryCredits) return null;

    const credits = recoveryCredits.credits ?? [];
    if (credits.length > 0) {
        const availableCount = recoveryCredits.availableCount;
        let nextExpiresAtMs: number | null = null;
        let providerCreditId: string | null = null;
        for (const credit of credits) {
            if (credit.status !== 'available') continue;
            const expiresAtMs = credit.expiresAtMs;
            if (typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
                continue;
            }
            if (providerCreditId === null && credit.id) {
                providerCreditId = credit.id;
            }
            if (typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs)) {
                nextExpiresAtMs = nextExpiresAtMs === null ? expiresAtMs : Math.min(nextExpiresAtMs, expiresAtMs);
            }
        }
        return availableCount > 0 ? { availableCount, nextExpiresAtMs, providerCreditId } : null;
    }

    return recoveryCredits.availableCount > 0
        ? { availableCount: recoveryCredits.availableCount, nextExpiresAtMs: null, providerCreditId: null }
        : null;
}

/** The gauge's vocabulary for the one quota tone owner's answer; a healthy gauge stays quiet. */
function resolveTone(remainingPct: number | null): ConnectedServiceQuotaGaugeTone {
    const tone = resolveQuotaTone(remainingPct);
    if (tone === 'danger') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

function buildMeterRow(
    meter: ConnectedServiceQuotaMeterV1,
    nowMs: number,
    formatter: ConnectedServiceQuotaGaugeLabelFormatter,
): ConnectedServiceQuotaGaugeMeterRow | null {
    const usedPct = deriveQuotaUtilizationPct(meter);

    const remainingPct = typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
        ? clampQuotaPct(meter.remainingPct)
        : usedPct === null ? null : clampQuotaPct(100 - usedPct);
    const remainingLabel = remainingPct === null ? '—' : `${Math.round(remainingPct)}%`;
    const resetLabel = formatResetCountdown(nowMs, meter.resetAtMs ?? meter.resetsAt, formatter);
    return {
        meterId: meter.meterId,
        label: meter.label,
        remainingPct,
        usedPct,
        detailRightSemantics: 'remaining',
        detailRightLabel: resetLabel
            ? formatter.remainingWithReset({ percent: remainingLabel, reset: resetLabel })
            : formatter.remaining({ percent: remainingLabel }),
        usedLimitSemantics: typeof meter.used === 'number' && typeof meter.limit === 'number'
            ? 'used'
            : null,
        usedLimitLabel: typeof meter.used === 'number' && typeof meter.limit === 'number'
            ? formatter.used({ used: formatNumber(meter.used), limit: formatNumber(meter.limit) })
            : null,
        resetLabel,
        resetsAt: meter.resetAtMs ?? meter.resetsAt ?? null,
        tone: resolveTone(remainingPct),
    };
}

/**
 * The snapshot fields the gauge actually reads: everything except the legacy
 * `serviceId`/`profileId` identity, which it only echoes back out.
 *
 * Accepting that identity as OPTIONAL lets the qualified (V4) snapshot — declared
 * as `ConnectedServiceQuotaSnapshotV1.omit({ serviceId, profileId }).extend({ ref })`
 * — flow through this one gauge owner instead of forking a parallel one.
 */
export type ConnectedServiceQuotaGaugeSnapshotInput =
    Omit<ConnectedServiceQuotaSnapshotV1, 'serviceId' | 'profileId'>
    & Partial<Pick<ConnectedServiceQuotaSnapshotV1, 'serviceId' | 'profileId'>>;

export function computeConnectedServiceQuotaGaugeViewModel(_params: Readonly<{
    snapshot: ConnectedServiceQuotaGaugeSnapshotInput | null;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
    /** Pinned meters of the session's connected account, shown as extra rings. */
    additionalMeterIds?: readonly string[];
    nowMs: number;
    formatter: ConnectedServiceQuotaGaugeLabelFormatter;
    providerDisplayName?: string | null;
    activeAccountDisplayLabel?: string | null;
}>): ConnectedServiceQuotaGaugeViewModel | null {
    const params = _params;
    if (!params.snapshot) return null;

    const rankableMeters = selectComparableConnectedServiceQuotaMeters(params.snapshot.meters);
    const allMeterRows = rankableMeters
        .map((meter) => buildMeterRow(meter, params.nowMs, params.formatter))
        .filter((row): row is ConnectedServiceQuotaGaugeMeterRow => row !== null);
    if (allMeterRows.length === 0) return null;

    const selectedCandidates = rankableMeters.filter((meter) => meterMatchesWindowMode(meter, params.windowMode));
    const candidates = selectedCandidates.length > 0 ? selectedCandidates : rankableMeters;
    let effectiveMeter: ConnectedServiceQuotaMeterV1 | null = null;
    let effectiveRemainingPct = Number.POSITIVE_INFINITY;
    for (const meter of candidates) {
        const usedPct = deriveQuotaUtilizationPct(meter);
        if (usedPct === null) continue;
        const remainingPct = typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)
            ? clampQuotaPct(meter.remainingPct)
            : clampQuotaPct(100 - usedPct);
        if (remainingPct < effectiveRemainingPct) {
            effectiveRemainingPct = remainingPct;
            effectiveMeter = meter;
        }
    }
    if (!effectiveMeter || !Number.isFinite(effectiveRemainingPct)) return null;

    const selectedRow = buildMeterRow(effectiveMeter, params.nowMs, params.formatter);
    if (!selectedRow || selectedRow.usedPct === null) return null;

    const snapshotMeters = params.snapshot.meters;
    const displayedMeterRows = [...new Set([effectiveMeter.meterId, ...(params.additionalMeterIds ?? [])])].flatMap((meterId) => {
        // Pinned extras may cross comparison families, but still share the reliability gate.
        const meter = snapshotMeters.find((candidate) => candidate.meterId === meterId
            && isConnectedServiceQuotaMeterPercentRankable(candidate));
        const row = meter ? buildMeterRow(meter, params.nowMs, params.formatter) : null;
        return row && row.usedPct !== null && row.remainingPct !== null
            ? [{ ...row, usedPct: row.usedPct, remainingPct: row.remainingPct }] : [];
    });
    // Details retain useful usage/rate windows and explicitly pinned placeholders.
    // The comparable numeric family alone selects the main composer ring.
    for (const meter of snapshotMeters) {
        const category = readPublicLimitCategory(meter);
        if ((category && !['usage_limit', 'rate_limit'].includes(category))
            || allMeterRows.some((existing) => existing.meterId === meter.meterId)) continue;
        const row = buildMeterRow(meter, params.nowMs, params.formatter);
        if (row && isConnectedServiceQuotaMeterVisible(meter, params.nowMs, params.additionalMeterIds)) allMeterRows.push(row);
    }

    const selectedWindowPrefix = params.windowMode === 'most_constrained'
        ? null
        : resolveConnectedServiceQuotaMeterScopePrefix(effectiveMeter);
    const roundedRemaining = Math.round(effectiveRemainingPct);
    const remainingValueLabel = params.formatter.remaining({ percent: `${roundedRemaining}%` });
    const staleAt = params.snapshot.fetchedAt + params.snapshot.staleAfterMs;
    const isStale = params.nowMs > staleAt;
    return {
        serviceId: params.snapshot.serviceId ?? null,
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
        effectiveMeter,
        allMeterRows,
        usageRings: displayedMeterRows.map((row) => {
            const ringRemaining = Math.round(row.remainingPct);
            return {
                meterId: row.meterId,
                label: row.label,
                usedPct: row.usedPct,
                ringValueLabel: String(ringRemaining),
                valueLabel: params.formatter.remaining({ percent: `${ringRemaining}%` }),
                tone: row.tone,
            };
        }),
        recoveryCreditSummary: summarizeConnectedServiceQuotaRecoveryCredits(params.snapshot.recoveryCredits, params.nowMs),
    };
}

/**
 * The released scalar quota identity behind a runtime-issue service reference.
 *
 * Runtime issues carry canonical qualified Connected Account service keys (the
 * ingress upgrades released bare ids), while `ConnectedServiceQuotaSnapshotV1`
 * is a released scalar union. Translate through the provenance-named Protocol
 * mapping and return `null` for a novel external service that has no released
 * scalar member — never emit a qualified key as a scalar snapshot identity.
 */
function readReleasedQuotaServiceId(
    serviceId: string | undefined,
): ConnectedServiceQuotaSnapshotV1['serviceId'] | null {
    if (!serviceId) return null;
    const qualifiedKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
    const service = qualifiedKey ? parseQualifiedPluginContributionKey(qualifiedKey) : null;
    return service ? readBuiltInLegacyConnectedServiceIdForQualifiedService(service) : null;
}

function resolveRuntimeIssueQuotaServiceId(issue: SessionRuntimeIssueV1): ConnectedServiceQuotaSnapshotV1['serviceId'] | null {
    // A present reference names the exact service. Without a released scalar
    // identity this corridor cannot represent it, and substituting the Agent's
    // default service would credit the wrong account (fail closed).
    const refServiceId = issue.usageLimit?.quotaSnapshotRef?.serviceId;
    if (refServiceId) return readReleasedQuotaServiceId(refServiceId);
    const connectedServiceId = issue.usageLimit?.connectedService?.serviceId;
    if (connectedServiceId) return readReleasedQuotaServiceId(connectedServiceId);

    const agentId = resolveAgentIdFromFlavor(issue.agentId);
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

    const providerId = issue.agentId?.trim() || null;
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
        accountLabel: null,
        ...(providerId ? { providerId } : {}),
        source: 'runtime_event',
        confidence: 'exact',
        evidence,
        meters,
    };
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

export function selectConnectedServiceSessionProviderUsageSnapshot(params: Readonly<{
    connectedServiceSnapshot: ConnectedServiceQuotaSnapshotV1 | null;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    runtimeIssue: SessionRuntimeIssueV1 | null | undefined;
}>): ConnectedServiceQuotaSnapshotV1 | null {
    const runtimeIssueQuotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(params.runtimeIssue);
    if (!runtimeIssueQuotaSnapshot) return params.connectedServiceSnapshot;
    if (!shouldPreferRuntimeIssueQuotaSnapshot({
        runtimeSnapshot: runtimeIssueQuotaSnapshot,
        connectedSnapshot: params.connectedServiceSnapshot,
    })) {
        return params.connectedServiceSnapshot;
    }
    const recoveryCredits = params.connectedServiceSnapshot
        && snapshotsIdentifySameQuotaProfile(runtimeIssueQuotaSnapshot, params.connectedServiceSnapshot)
        ? params.connectedServiceSnapshot.recoveryCredits ?? null
        : params.recoveryCredits ?? null;
    return withRecoveryCredits(runtimeIssueQuotaSnapshot, recoveryCredits);
}
