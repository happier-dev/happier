import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

type SessionMessagesValue = StorageState['sessionMessages'][string] | undefined;

/**
 * Change ledgers for the always-mounted, account-wide attention selectors.
 *
 * Such a selector asks the same question of the whole account — "did anything
 * that could move my value change?" — on every store notification. Answering it
 * by rebuilding a joined signature string over every session costs one string
 * per session plus an account-sized join per pass, on an account that can hold
 * thousands of sessions, several times per sync wave.
 *
 * A ledger answers the same question with a revision counter: an unchanged
 * session costs one identity comparison and allocates nothing, and the revision
 * only moves when some session's signature actually moved. Equality of the
 * revision is exactly equality of the joined signature it replaces.
 *
 * Runtime freshness is time-derived, so it cannot be cached on value identity
 * alone. `isFreshTimestamp` is monotone in `nowMs` — a stale timestamp never
 * becomes fresh again without the timestamp itself changing — so each entry also
 * records the first instant one of its freshness bits can flip. Below that
 * instant the entry is reused; at or past it the entry is re-derived. No
 * freshness transition can be missed, and the common wave costs nothing.
 */
export type SessionSignatureLedger<TValue> = Readonly<{
    sync: <TAnchor>(
        anchor: Readonly<Record<string, TAnchor>>,
        readValue: (id: string) => TValue,
    ) => number;
    readSignature: (id: string) => string;
}>;

type SignatureLedgerEntry<TValue> = {
    value: TValue;
    signature: string;
};

export function createSessionSignatureLedger<TValue>(
    buildSignature: (value: TValue, id: string) => string,
): SessionSignatureLedger<TValue> {
    const entries = new Map<string, SignatureLedgerEntry<TValue>>();
    let revision = 0;

    return {
        sync: (anchor, readValue) => {
            let anchoredCount = 0;
            for (const id in anchor) {
                if (!Object.prototype.hasOwnProperty.call(anchor, id)) continue;
                anchoredCount += 1;
                const value = readValue(id);
                const entry = entries.get(id);
                if (entry !== undefined && entry.value === value) continue;
                const signature = buildSignature(value, id);
                if (entry === undefined || entry.signature !== signature) {
                    revision += 1;
                }
                entries.set(id, { value, signature });
            }
            if (entries.size !== anchoredCount) {
                for (const id of [...entries.keys()]) {
                    if (Object.prototype.hasOwnProperty.call(anchor, id)) continue;
                    entries.delete(id);
                    revision += 1;
                }
            }
            return revision;
        },
        readSignature: (id) => entries.get(id)?.signature ?? '',
    };
}

/**
 * True while every recorded freshness boundary is still in the future, i.e.
 * while no freshness bit can have flipped since the ledgers last synced. A
 * caller may reuse a cached derivation only while this holds.
 */
export function isBeforeFreshnessBoundary(
    nowMs: number,
    boundaries: ReadonlyArray<number | null>,
): boolean {
    for (const boundaryAtMs of boundaries) {
        if (boundaryAtMs !== null && nowMs >= boundaryAtMs) return false;
    }
    return true;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

type FreshnessProbe = Readonly<{
    signature: string;
    nextBoundaryAtMs: number | null;
}>;

function probeFreshness(
    timestamps: ReadonlyArray<number | null | undefined>,
    nowMs: number,
): FreshnessProbe {
    let signature = '';
    let nextBoundaryAtMs: number | null = null;
    for (const value of timestamps) {
        const timestamp = readNumber(value);
        if (timestamp === null || !isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) {
            signature += '0';
            continue;
        }
        signature += '1';
        const boundaryAtMs = timestamp + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS;
        nextBoundaryAtMs = nextBoundaryAtMs === null
            ? boundaryAtMs
            : Math.min(nextBoundaryAtMs, boundaryAtMs);
    }
    return { signature, nextBoundaryAtMs };
}

export type SessionRuntimeFreshnessLedger = Readonly<{
    sync: (input: Readonly<{
        sessions: Readonly<Record<string, Session>>;
        sessionMessages: StorageState['sessionMessages'];
        nowMs: number;
        readSessionSignature: (id: string) => string;
        readSessionMessagesSignature: (id: string) => string;
    }>) => number;
    /**
     * Earliest instant at which some entry's freshness bits can flip, or `null`
     * when no entry has a live signal. Until then the ledger's revision cannot
     * move for time alone, so a caller whose inputs are otherwise unchanged can
     * skip the sync entirely.
     */
    readNextBoundaryAtMs: () => number | null;
}>;

type SessionFreshnessLedgerEntry = {
    session: Session;
    sessionMessages: SessionMessagesValue;
    signature: string;
    nextBoundaryAtMs: number | null;
};

export function createSessionRuntimeFreshnessLedger(): SessionRuntimeFreshnessLedger {
    const entries = new Map<string, SessionFreshnessLedgerEntry>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let revision = 0;
    let nextBoundaryAtMs: number | null = null;

    return {
        readNextBoundaryAtMs: () => nextBoundaryAtMs,
        sync: (input) => {
            let sessionCount = 0;
            let earliestBoundaryAtMs: number | null = null;
            const observeBoundary = (boundaryAtMs: number | null) => {
                if (boundaryAtMs === null) return;
                earliestBoundaryAtMs = earliestBoundaryAtMs === null
                    ? boundaryAtMs
                    : Math.min(earliestBoundaryAtMs, boundaryAtMs);
            };
            for (const id in input.sessions) {
                if (!Object.prototype.hasOwnProperty.call(input.sessions, id)) continue;
                sessionCount += 1;
                const session = input.sessions[id];
                const sessionMessages = input.sessionMessages?.[id];
                const entry = entries.get(id);
                if (
                    entry !== undefined
                    && entry.session === session
                    && entry.sessionMessages === sessionMessages
                    && (entry.nextBoundaryAtMs === null || input.nowMs < entry.nextBoundaryAtMs)
                ) {
                    observeBoundary(entry.nextBoundaryAtMs);
                    continue;
                }

                const pendingRequestObservedAt = readCachedPendingRequestObservedAt({
                    cache: pendingRequestObservedAtCache,
                    session,
                    sessionMessages,
                    sessionSignature: input.readSessionSignature(id),
                    sessionMessagesSignature: input.readSessionMessagesSignature(id),
                });
                const probe = probeFreshness([
                    session.activeAt,
                    session.thinkingAt,
                    session.latestTurnStatusObservedAt,
                    pendingRequestObservedAt,
                ], input.nowMs);

                if (entry === undefined || entry.signature !== probe.signature) {
                    revision += 1;
                }
                observeBoundary(probe.nextBoundaryAtMs);
                entries.set(id, {
                    session,
                    sessionMessages,
                    signature: probe.signature,
                    nextBoundaryAtMs: probe.nextBoundaryAtMs,
                });
            }

            nextBoundaryAtMs = earliestBoundaryAtMs;
            if (entries.size !== sessionCount) {
                const activeSessionIds = new Set<string>();
                for (const id in input.sessions) {
                    if (Object.prototype.hasOwnProperty.call(input.sessions, id)) activeSessionIds.add(id);
                }
                for (const id of [...entries.keys()]) {
                    if (activeSessionIds.has(id)) continue;
                    entries.delete(id);
                    revision += 1;
                }
                prunePendingRequestObservedAtCache(pendingRequestObservedAtCache, activeSessionIds);
            }
            return revision;
        },
    };
}
