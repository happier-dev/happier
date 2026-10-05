import type {
    ConnectedServiceQuotaMeterV1,
} from '@happier-dev/protocol';

import { selectConnectedServiceQuotaSummaryMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { selectComparableConnectedServiceQuotaMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

/** Whether a member can take a turn now, from its own reported limits. */
export type PoolMemberRoom = 'room' | 'waiting' | 'unknown';

export type PoolMemberUsageInput = Readonly<{
    accountId: string;
    enabled: boolean;
    /** The member's current meters, or null while nothing has been read for it. */
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1> | null;
}>;

/** One window of "Left across the pool": the members' average, the earliest reset. */
export type PoolUsageWindow = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number;
    resetsAt: number | null;
    reportingCount: number;
    estimated: boolean;
}>;

export type PoolUsage = Readonly<{
    windows: readonly PoolUsageWindow[];
    /** "N of M have room": over members that are on and report comparable limits; the rest are not reported. */
    room: Readonly<{ withRoom: number; reporting: number; unreported: number }>;
    roomByAccountId: Readonly<Record<string, PoolMemberRoom>>;
    /** Each member's lowest window, for "the one with the most left"; null when it reports nothing. */
    lowestRemainingByAccountId: Readonly<Record<string, number | null>>;
    /** The member that has room again first, when every reporting member is waiting. */
    firstBack: Readonly<{ accountId: string; atMs: number }> | null;
}>;

type ComparableReading = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number;
    resetsAt: number | null;
    exhausted: boolean;
    estimated: boolean;
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
            remainingPct: entry.remainingPct,
            resetsAt: resetPassed ? null : resetsAt,
            exhausted,
            estimated: entry.meter.status === 'estimated',
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
    const windows = new Map<string, { label: string; sum: number; count: number; resetsAt: number | null; estimated: boolean }>();
    const roomByAccountId: Record<string, PoolMemberRoom> = {};
    const lowestRemainingByAccountId: Record<string, number | null> = {};
    let withRoom = 0;
    let reporting = 0;
    let unreported = 0;
    let firstBack: { accountId: string; atMs: number } | null = null;

    for (const member of input.members) {
        const readings = member.meters ? readComparable(member.meters, input.now) : [];
        lowestRemainingByAccountId[member.accountId] = readings.length > 0
            ? Math.min(...readings.map((reading) => reading.remainingPct))
            : null;
        const room: PoolMemberRoom = readings.length === 0
            ? 'unknown'
            : readings.some((reading) => reading.exhausted) ? 'waiting' : 'room';
        roomByAccountId[member.accountId] = room;
        if (!member.enabled) continue;
        if (room === 'unknown') {
            unreported += 1;
            continue;
        }
        reporting += 1;
        if (room === 'room') withRoom += 1;
        if (room === 'waiting') {
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
            const current = windows.get(reading.meterId) ?? { label: reading.label, sum: 0, count: 0, resetsAt: null, estimated: false };
            current.sum += reading.remainingPct;
            current.count += 1;
            current.estimated ||= reading.estimated;
            if (reading.resetsAt !== null && (current.resetsAt === null || reading.resetsAt < current.resetsAt)) {
                current.resetsAt = reading.resetsAt;
            }
            windows.set(reading.meterId, current);
        }
    }

    return {
        windows: Array.from(windows, ([meterId, window]) => ({
            meterId,
            label: window.label,
            remainingPct: Math.round(window.sum / window.count),
            resetsAt: window.resetsAt,
            reportingCount: window.count,
            estimated: window.estimated,
        })),
        room: { withRoom, reporting, unreported },
        roomByAccountId,
        lowestRemainingByAccountId,
        firstBack: withRoom === 0 && reporting > 0 ? firstBack : null,
    };
}

/**
 * Suggest a target for the user's explicit "Switch to" action, in the user's member order.
 * This does not predict automatic selection: the daemon owns that decision with fresh runtime evidence.
 */
export function resolvePoolManualSwitchSuggestion(input: Readonly<{
    activeAccountId: string | null;
    members: ReadonlyArray<Readonly<{ accountId: string; enabled: boolean; priority: number }>>;
    roomByAccountId: Readonly<Record<string, PoolMemberRoom>>;
}>): string | null {
    const candidates = [...input.members]
        .filter((member) => member.enabled && member.accountId !== input.activeAccountId
            && input.roomByAccountId[member.accountId] !== 'waiting')
        .sort((left, right) => left.priority - right.priority || left.accountId.localeCompare(right.accountId));
    return candidates[0]?.accountId ?? null;
}
