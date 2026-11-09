import type {
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaSnapshotV1,
    ConnectedServiceQuotaLimitSelectionV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
import { isConnectedServiceCredentialHealthStatusUsable, normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';

import { selectConnectedServiceQuotaSummaryMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { selectComparableConnectedServiceQuotaMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountHealth, type AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import { projectConnectedServiceQuotaSnapshotForLimitSelection } from '@/sync/domains/connectedServices/projectConnectedServiceQuotaSnapshotForLimitSelection';

export type PoolQuotaSnapshot = Pick<ConnectedServiceQuotaSnapshotV1, 'meters' | 'fetchedAt' | 'staleAfterMs'>;
export type PoolUsageFreshness = Readonly<{
    asOf: number | null;
    isStale: boolean;
    notAnswering: boolean;
    staleMemberIds: readonly string[];
}>;

/** Pool policy and retained-reading freshness are projected once for detail, index and chooser. */
export function projectPoolUsage(input: Readonly<{
    members: ReadonlyArray<Omit<PoolMemberUsageInput, 'meters' | 'isStale'> & Readonly<{ snapshot: PoolQuotaSnapshot | null; failed?: boolean }>>;
    quotaLimitSelection?: ConnectedServiceQuotaLimitSelectionV1;
    now: number;
}>): Readonly<{ usage: PoolUsage; freshness: PoolUsageFreshness }> {
    let asOf: number | null = null;
    let readingCount = 0;
    let failed = false;
    const staleMemberIds: string[] = [];
    const members = input.members.map((member) => {
        const snapshot = projectConnectedServiceQuotaSnapshotForLimitSelection(member.snapshot, input.quotaLimitSelection);
        const isStale = snapshot !== null && input.now > snapshot.fetchedAt + snapshot.staleAfterMs;
        if (member.enabled) {
            failed ||= member.failed === true;
            if (snapshot) {
                readingCount += 1;
                asOf = asOf === null ? snapshot.fetchedAt : Math.min(asOf, snapshot.fetchedAt);
                if (isStale) staleMemberIds.push(member.accountId);
            }
        }
        return { ...member, meters: snapshot?.meters ?? null, isStale };
    });
    return {
        usage: derivePoolUsage({ members, now: input.now }),
        freshness: { asOf, isStale: staleMemberIds.length > 0, staleMemberIds,
            notAnswering: readingCount > 0 && staleMemberIds.length === readingCount && failed },
    };
}

/** Capacity from the member's last reported limits; freshness is carried separately. */
export type PoolMemberRoom = 'room' | 'waiting' | 'unknown';

export type PoolMemberUsageInput = Readonly<{
    accountId: string;
    enabled: boolean;
    credentialStatus: unknown;
    isStale?: boolean;
    /** The member's current meters, or null while nothing has been read for it. */
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1> | null;
}>;

/** Last reported capacity, freshness and readings, decided together for every pool consumer. */
export type PoolMemberUsageState = Readonly<{
    credentialStatus: ReturnType<typeof parseDisplayableCredentialHealthStatus>;
    health: AccountHealth;
    isStale: boolean;
    room: PoolMemberRoom;
    lowestRemainingPct: number | null;
    meters: readonly ComparableReading[];
    /** Provider amounts after the pool's existing limit selection, including uncapped readings. */
    reportedMeters: readonly ConnectedServiceQuotaMeterV1[];
}>;

/** One window of "Left across the pool": the members' average, the earliest reset. */
export type PoolUsageWindow = Readonly<{
    /** A meter id may be reused for different provider-reported windows. */
    key: string;
    meterId: string;
    label: string;
    remainingPct: number;
    resetsAt: number | null;
    reportingCount: number;
    estimated: boolean;
}>;

export type PoolUsage = Readonly<{
    windows: readonly PoolUsageWindow[];
    /** "N of M have room": M is every member; only usable enabled accounts contribute reported room. */
    room: Readonly<{ withRoom: number; total: number; reporting: number; unreported: number }>;
    memberByAccountId: Readonly<Record<string, PoolMemberUsageState>>;
    /** The member that has room again first, when every usable enabled member is currently waiting. */
    firstBack: Readonly<{ accountId: string; atMs: number }> | null;
}>;

type ComparableReading = Readonly<{
    meterId: string;
    label: string;
    windowDurationMs: number | null;
    remainingPct: number;
    resetsAt: number | null;
    exhausted: boolean;
    estimated: boolean;
    status: ConnectedServiceQuotaMeterV1['status'];
}>;

/**
 * The member's comparable limits (the account's main limit family, from the one comparable-meter owner)
 * with a known "left". A window with nothing reported is not a reading: missing quota is never zero.
 */
function readComparable(meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>, now: number): ComparableReading[] {
    const comparable = selectComparableConnectedServiceQuotaMeters(meters);
    const selected = selectConnectedServiceQuotaSummaryMeters({
        meters: comparable,
        meterIds: comparable.map((meter) => meter.meterId),
        strategy: 'primary',
    });
    return selected.flatMap((entry) => {
        if (!entry.meter || entry.remainingPct === null) return [];
        const resetsAt = entry.meter.resetsAt ?? null;
        // A window whose reset has already passed no longer says the member is out.
        const resetPassed = resetsAt !== null && resetsAt <= now;
        const exhausted = !resetPassed && (entry.remainingPct <= 0 || entry.meter.isExhausted === true);
        return [{
            meterId: entry.meterId,
            label: entry.label,
            windowDurationMs: entry.meter.windowDurationMs ?? null,
            remainingPct: entry.remainingPct,
            resetsAt: resetPassed ? null : resetsAt,
            exhausted,
            estimated: entry.meter.status === 'estimated',
            status: entry.meter.status,
        }];
    });
}

/**
 * "Left across the pool" (lab `csvc` PL): per window, the average of the members that are on and
 * report it, with the earliest reset; "N of M have room"; and who is back first when all are waiting.
 * Derived in the UI from members' own snapshots — percentages of different plans are averaged, never
 * summed, and a member that reports nothing is left out rather than read as empty.
 */
export function derivePoolUsage(input: Readonly<{
    members: readonly PoolMemberUsageInput[];
    now: number;
}>): PoolUsage {
    const windows = new Map<string, { meterId: string; label: string; sum: number; count: number; resetsAt: number | null; estimated: boolean }>();
    const memberByAccountId: Record<string, PoolMemberUsageState> = {};
    let withRoom = 0;
    let reporting = 0;
    let unreported = 0;
    let allWaiting = true;
    let firstBack: { accountId: string; atMs: number } | null = null;

    for (const member of input.members) {
        const readings = member.meters ? readComparable(member.meters, input.now) : [];
        const lowestRemainingPct = readings.length > 0
            ? Math.min(...readings.map((reading) => reading.remainingPct))
            : null;
        const credentialUsable = isConnectedServiceCredentialHealthStatusUsable(
            normalizeConnectedServiceCredentialHealthStatus(member.credentialStatus),
        );
        // A freshness deadline does not withdraw a settled reading during revalidation.
        const room: PoolMemberRoom = readings.length === 0 || !credentialUsable
            ? 'unknown'
            : readings.some((reading) => reading.exhausted) ? 'waiting' : 'room';
        const credentialStatus = parseDisplayableCredentialHealthStatus(member.credentialStatus);
        const state: PoolMemberUsageState = {
            credentialStatus,
            health: deriveAccountHealth({
                status: credentialStatus,
                capacityPct: lowestRemainingPct,
                isStale: member.isStale,
            }),
            isStale: member.isStale === true,
            room,
            lowestRemainingPct: room === 'unknown' ? null : lowestRemainingPct,
            meters: readings,
            reportedMeters: member.meters ?? [],
        };
        memberByAccountId[member.accountId] = state;
        if (!member.enabled || !credentialUsable) continue;
        // Missing or stale usage cannot establish that this member is currently waiting.
        if (state.room !== 'waiting' || state.isStale) allWaiting = false;
        if (state.room === 'unknown') {
            unreported += 1;
        } else {
            reporting += 1;
        }
        // Capacity and windows retain the same settled facts; freshness qualifies their presentation.
        if (state.room === 'room') withRoom += 1;
        if (state.room === 'waiting') {
            // Back when its last exhausted window resets.
            const backAt = readings
                .filter((reading) => reading.exhausted)
                .reduce<number | null>((latest, reading) => (
                    reading.resetsAt === null || latest === null ? null : Math.max(latest, reading.resetsAt)
                ), 0);
            if (backAt !== null && (firstBack === null || backAt < firstBack.atMs)) {
                firstBack = { accountId: member.accountId, atMs: backAt };
            }
        }
        for (const reading of readings) {
            // `primary` describes the provider's slot, not its period. Average only the same reported window.
            const key = JSON.stringify([reading.meterId, reading.label, reading.windowDurationMs]);
            const current = windows.get(key) ?? { meterId: reading.meterId, label: reading.label, sum: 0, count: 0, resetsAt: null, estimated: false };
            current.sum += reading.remainingPct;
            current.count += 1;
            current.estimated ||= reading.estimated;
            if (reading.resetsAt !== null && (current.resetsAt === null || reading.resetsAt < current.resetsAt)) {
                current.resetsAt = reading.resetsAt;
            }
            windows.set(key, current);
        }
    }

    return {
        windows: Array.from(windows, ([key, window]) => ({
            key,
            meterId: window.meterId,
            label: window.label,
            remainingPct: Math.round(window.sum / window.count),
            resetsAt: window.resetsAt,
            reportingCount: window.count,
            estimated: window.estimated,
        })),
        room: { withRoom, total: input.members.length, reporting, unreported },
        memberByAccountId,
        firstBack: allWaiting ? firstBack : null,
    };
}

/**
 * Suggest a target for the user's explicit "Switch to" action, in the user's member order.
 * This does not predict automatic selection: the daemon owns that decision with fresh runtime evidence.
 */
export function resolvePoolManualSwitchSuggestion(input: Readonly<{
    activeAccountId: string | null;
    members: ReadonlyArray<Readonly<{ accountId: string; enabled: boolean; priority: number }>>;
    memberByAccountId: Readonly<Record<string, Pick<PoolMemberUsageState, 'room'>>>;
}>): string | null {
    const candidates = [...input.members]
        .filter((member) => member.enabled && member.accountId !== input.activeAccountId
            && input.memberByAccountId[member.accountId]?.room !== 'waiting')
        .sort((left, right) => left.priority - right.priority || left.accountId.localeCompare(right.accountId));
    return candidates[0]?.accountId ?? null;
}
