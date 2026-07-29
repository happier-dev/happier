/**
 * Module-scoped registry of mounted surfaces that render live transcript content for a session
 * without going through the main `SessionView` surface-visibility tracking.
 *
 * Some session sub-routes (e.g. the message/tool detail route and the execution-run detail route on
 * mobile) display transcript-derived content for a session but are separate navigation screens that
 * do not mark the session surface visible. When realtime projection routing is enabled, hidden
 * durable messages are deferred (projection-only) and these panes would show stale transcript content
 * while the session is streaming. Registering them here marks the session as an explicit full-content
 * transcript consumer so durable realtime routing keeps materializing transcript content.
 *
 * The registry also owns mount-lifetime transcript RETENTION holds (see
 * `registerSessionTranscriptRetentionConsumer`): surfaces that render a transcript anywhere in the
 * navigation stack keep the materialized transcript resident without widening realtime routing.
 *
 * This mirrors `sessionRealtimeScmConsumers.ts` (refcount-style registry) but is keyed purely by
 * session id because the consumer simply needs the session's own transcript, not project-scope
 * mutation transcripts.
 */

import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

let nextConsumerId = 1;
const mountedTranscriptConsumerIdentitiesByConsumerId = new Map<number, Readonly<{
    sessionId: string;
    serverId: string | null;
    /**
     * Retention-only holds keep a session's materialized transcript resident in memory
     * (see `sync/engine/sessions/sessionTranscriptRetention.ts`) but intentionally do NOT
     * make the session a realtime full-content consumer: hidden-but-mounted surfaces stay
     * on the projection-only routing path.
     */
    retentionOnly: boolean;
}>>();

type TranscriptConsumerReleaseListener = (sessionId: string) => void;

// Hoisted-function + globalThis-keyed storage (same pattern as sessionSurfaceVisibility.ts):
// sync.ts subscribes during its own module evaluation and this module can sit inside an
// import cycle with it, so a module-scoped `const` Set would hit the TDZ.
function getTranscriptConsumerReleaseListeners(): Set<TranscriptConsumerReleaseListener> {
    // Key inlined (not a module-scoped const) so this hoisted function is TDZ-safe.
    const host = globalThis as typeof globalThis & {
        __HAPPIER_TRANSCRIPT_CONSUMER_RELEASE_LISTENERS__?: Set<TranscriptConsumerReleaseListener>;
    };
    host.__HAPPIER_TRANSCRIPT_CONSUMER_RELEASE_LISTENERS__ ??= new Set<TranscriptConsumerReleaseListener>();
    return host.__HAPPIER_TRANSCRIPT_CONSUMER_RELEASE_LISTENERS__;
}

function notifyTranscriptConsumerReleased(sessionId: string): void {
    for (const listener of getTranscriptConsumerReleaseListeners()) {
        listener(sessionId);
    }
}

function normalizeSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveRegisteredServerId(sessionId: string, serverId?: string | null): string | null {
    return normalizeServerId(serverId) ?? resolveServerIdForSessionIdFromLocalCache(sessionId) ?? null;
}

function resolveMountedConsumerServerId(
    consumerId: number,
    sessionId: string,
    serverId: string | null,
    retentionOnly: boolean,
): string | null {
    if (serverId) return serverId;
    const resolvedServerId = resolveRegisteredServerId(sessionId);
    if (!resolvedServerId) return null;
    mountedTranscriptConsumerIdentitiesByConsumerId.set(consumerId, {
        sessionId,
        serverId: resolvedServerId,
        retentionOnly,
    });
    return resolvedServerId;
}

function registerMountedTranscriptConsumer(
    sessionId: string,
    serverId: string | null | undefined,
    retentionOnly: boolean,
): () => void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
        return () => {};
    }
    const consumerId = nextConsumerId;
    nextConsumerId += 1;
    mountedTranscriptConsumerIdentitiesByConsumerId.set(consumerId, {
        sessionId: normalizedSessionId,
        serverId: resolveRegisteredServerId(normalizedSessionId, serverId),
        retentionOnly,
    });
    return () => {
        if (mountedTranscriptConsumerIdentitiesByConsumerId.delete(consumerId)) {
            notifyTranscriptConsumerReleased(normalizedSessionId);
        }
    };
}

export function registerSessionRealtimeTranscriptConsumer(sessionId: string, serverId?: string | null): () => void {
    return registerMountedTranscriptConsumer(sessionId, serverId, false);
}

/**
 * Registers a mount-lifetime transcript retention hold for `sessionId`.
 *
 * Used by transcript-rendering surfaces (`SessionView` via `useSessionSurfaceActivation`)
 * for their FULL mounted lifetime — including hidden-but-mounted back-stack screens — so
 * the transcript eviction sweep can never free a transcript that is still rendered
 * somewhere in the navigation stack. Unlike `registerSessionRealtimeTranscriptConsumer`,
 * this does NOT opt the session into realtime full-content routing.
 */
export function registerSessionTranscriptRetentionConsumer(sessionId: string, serverId?: string | null): () => void {
    return registerMountedTranscriptConsumer(sessionId, serverId, true);
}

export function readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId?: string | null): string[] {
    if (mountedTranscriptConsumerIdentitiesByConsumerId.size === 0) return [];
    const normalizedServerId = normalizeServerId(serverId);
    const sessionIds = new Set<string>();

    for (const [consumerId, entry] of mountedTranscriptConsumerIdentitiesByConsumerId.entries()) {
        if (entry.retentionOnly) continue;
        const resolvedServerId = resolveMountedConsumerServerId(consumerId, entry.sessionId, entry.serverId, entry.retentionOnly);
        if (normalizedServerId && !areServerProfileIdentifiersEquivalent(resolvedServerId, normalizedServerId)) {
            continue;
        }
        sessionIds.add(entry.sessionId);
    }

    return Array.from(sessionIds);
}

/**
 * All sessions with at least one mounted transcript consumer of ANY kind (realtime
 * full-content consumers and retention-only holds). This is the eviction-eligibility
 * read: a session listed here must never have its transcript evicted.
 */
export function readMountedSessionTranscriptConsumerSessionIdsForRetention(): string[] {
    if (mountedTranscriptConsumerIdentitiesByConsumerId.size === 0) return [];
    const sessionIds = new Set<string>();
    for (const entry of mountedTranscriptConsumerIdentitiesByConsumerId.values()) {
        sessionIds.add(entry.sessionId);
    }
    return Array.from(sessionIds);
}

/**
 * Notifies when a mounted transcript consumer unregisters (a transcript surface
 * unmounted). The transcript retention sweep uses this as its trigger.
 */
export function subscribeSessionTranscriptConsumerReleases(listener: TranscriptConsumerReleaseListener): () => void {
    const listeners = getTranscriptConsumerReleaseListeners();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function clearMountedSessionRealtimeTranscriptConsumers(): void {
    mountedTranscriptConsumerIdentitiesByConsumerId.clear();
}
