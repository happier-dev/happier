import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';
import type { StorageState } from '@/sync/store/types';

type SessionMessagesValue = StorageState['sessionMessages'][string] | undefined;

/**
 * Change ledgers for the always-mounted attention selectors (activity badge,
 * inbox dot).
 *
 * Both selectors ask the same question of the whole account — "did anything
 * that could move my value change?" — on every store notification. They used to
 * answer it by rebuilding a joined signature string over every session, which
 * costs one string per session plus one account-sized join per pass, on an
 * account with thousands of sessions, several times per wave.
 *
 * A ledger answers the same question with a revision counter: unchanged
 * sessions cost one identity comparison and allocate nothing, and the revision
 * only moves when some session's signature actually moved. Equality of the
 * revision is exactly equality of the joined signature it replaced.
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
    /**
     * Ids whose signature moved (added, changed, or removed) during the most
     * recent `sync`. This is the per-wave change set a consumer needs to update
     * a derived cache incrementally instead of rebuilding it.
     */
    readChangedIds: () => readonly string[];
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
    let changedIds: string[] = [];

    return {
        sync: (anchor, readValue) => {
            changedIds = [];
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
                    changedIds.push(id);
                }
                entries.set(id, { value, signature });
            }
            if (entries.size !== anchoredCount) {
                for (const id of [...entries.keys()]) {
                    if (Object.prototype.hasOwnProperty.call(anchor, id)) continue;
                    entries.delete(id);
                    revision += 1;
                    changedIds.push(id);
                }
            }
            return revision;
        },
        readSignature: (id) => entries.get(id)?.signature ?? '',
        readChangedIds: () => changedIds,
    };
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
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
        if (!isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS) || timestamp === null) {
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

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    const requests = session.agentState?.requests;
    if (!requests || typeof requests !== 'object') return false;
    for (const requestId in requests) {
        if (Object.prototype.hasOwnProperty.call(requests, requestId)) return true;
    }
    return false;
}

function hasCompletedRequest(completedValue: unknown, requestId: string): boolean {
    if (!completedValue || typeof completedValue !== 'object') return false;
    const completed = completedValue as Record<string, { completedAt?: unknown } | undefined>;
    return completed[requestId]?.completedAt != null;
}

function readLatestPendingAgentRequestCreatedAt(value: unknown, completedValue: unknown): number | null {
    if (!value || typeof value !== 'object') return null;
    const requests = value as Record<string, { createdAt?: unknown } | undefined>;
    let latest: number | null = null;
    for (const requestId in requests) {
        if (!Object.prototype.hasOwnProperty.call(requests, requestId)) continue;
        if (hasCompletedRequest(completedValue, requestId)) continue;
        const createdAt = readNumber(requests[requestId]?.createdAt);
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

/**
 * A session whose pending state is only visible in its loaded transcript: no
 * projected counts, no observed-at timestamp, no agent-state requests. Only
 * those pay the transcript probe.
 */
function needsTranscriptPendingFreshnessProbe(
    session: Session,
    sessionMessages: SessionMessagesValue,
): boolean {
    return session.active === true
        && session.presence === 'online'
        && sessionMessages?.isLoaded === true
        && readNumber(session.pendingRequestObservedAt) === null
        && !hasProjectedPendingRequestCounts(session)
        && !hasPendingAgentRequests(session);
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
    readChangedIds: () => readonly string[];
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
    let changedIds: string[] = [];

    return {
        readNextBoundaryAtMs: () => nextBoundaryAtMs,
        readChangedIds: () => changedIds,
        sync: (input) => {
            changedIds = [];
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
                const sessionMessages = input.sessionMessages[id];
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

                const agentState = session.agentState;
                const transcriptPendingRequestObservedAt = needsTranscriptPendingFreshnessProbe(session, sessionMessages)
                    ? readCachedPendingRequestObservedAt({
                        cache: pendingRequestObservedAtCache,
                        session,
                        sessionMessages,
                        sessionSignature: input.readSessionSignature(id),
                        sessionMessagesSignature: input.readSessionMessagesSignature(id),
                    })
                    : null;
                const pendingRequestObservedAt =
                    readLatestPendingAgentRequestCreatedAt(agentState?.requests, agentState?.completedRequests)
                    ?? readNumber(session.pendingRequestObservedAt)
                    ?? transcriptPendingRequestObservedAt;
                const probe = probeFreshness([
                    // `activeAt` is one of the in-progress runtime signals
                    // `deriveSessionRuntimePresentationState` reads, so its
                    // freshness boundary belongs here too: a session that stops
                    // heartbeating changes no store value, and without this
                    // boundary its attention would stay latched at the value it
                    // held while it was still live.
                    session.activeAt,
                    session.thinkingAt,
                    session.latestTurnStatusObservedAt,
                    session.meaningfulActivityAt,
                    pendingRequestObservedAt,
                ], input.nowMs);

                if (entry === undefined || entry.signature !== probe.signature) {
                    revision += 1;
                    changedIds.push(id);
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
                    changedIds.push(id);
                }
                prunePendingRequestObservedAtCache(pendingRequestObservedAtCache, activeSessionIds);
            }
            return revision;
        },
    };
}

export type RenderableRuntimeFreshnessLedger = Readonly<{
    sync: (
        renderables: Readonly<Record<string, SessionListRenderableSession>>,
        nowMs: number,
    ) => number;
    readNextBoundaryAtMs: () => number | null;
    readChangedIds: () => readonly string[];
}>;

type RenderableFreshnessLedgerEntry = {
    renderable: SessionListRenderableSession;
    signature: string;
    nextBoundaryAtMs: number | null;
};

export function createRenderableRuntimeFreshnessLedger(): RenderableRuntimeFreshnessLedger {
    const entries = new Map<string, RenderableFreshnessLedgerEntry>();
    let revision = 0;
    let nextBoundaryAtMs: number | null = null;
    let changedIds: string[] = [];

    return {
        readNextBoundaryAtMs: () => nextBoundaryAtMs,
        readChangedIds: () => changedIds,
        sync: (renderables, nowMs) => {
            changedIds = [];
            let renderableCount = 0;
            let earliestBoundaryAtMs: number | null = null;
            const observeBoundary = (boundaryAtMs: number | null) => {
                if (boundaryAtMs === null) return;
                earliestBoundaryAtMs = earliestBoundaryAtMs === null
                    ? boundaryAtMs
                    : Math.min(earliestBoundaryAtMs, boundaryAtMs);
            };
            for (const id in renderables) {
                if (!Object.prototype.hasOwnProperty.call(renderables, id)) continue;
                renderableCount += 1;
                const renderable = renderables[id];
                const entry = entries.get(id);
                if (
                    entry !== undefined
                    && entry.renderable === renderable
                    && (entry.nextBoundaryAtMs === null || nowMs < entry.nextBoundaryAtMs)
                ) {
                    observeBoundary(entry.nextBoundaryAtMs);
                    continue;
                }
                const probe = probeFreshness([
                    renderable.activeAt,
                    renderable.thinkingAt,
                    renderable.latestTurnStatusObservedAt,
                    renderable.meaningfulActivityAt,
                    renderable.pendingRequestObservedAt,
                ], nowMs);
                if (entry === undefined || entry.signature !== probe.signature) {
                    revision += 1;
                    changedIds.push(id);
                }
                observeBoundary(probe.nextBoundaryAtMs);
                entries.set(id, {
                    renderable,
                    signature: probe.signature,
                    nextBoundaryAtMs: probe.nextBoundaryAtMs,
                });
            }
            nextBoundaryAtMs = earliestBoundaryAtMs;
            if (entries.size !== renderableCount) {
                for (const id of [...entries.keys()]) {
                    if (Object.prototype.hasOwnProperty.call(renderables, id)) continue;
                    entries.delete(id);
                    revision += 1;
                    changedIds.push(id);
                }
            }
            return revision;
        },
    };
}
