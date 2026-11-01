import {
    SESSION_PUBLISHER_LEGACY_ALIVE_EVENT,
    SESSION_PUBLISHER_LEGACY_END_EVENT,
    SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SessionPublisherLegacyAliveSchema,
    SessionPublisherLegacyEndSchema,
    SessionRuntimeActivityCloseAckSchema,
    SessionRuntimeActivityCloseRequestSchema,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
    type PrimaryTurnStatusV1,
    type SessionRuntimeActivityProjection,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import type { SessionParticipantCursor } from '@/app/session/changeTracking/markSessionParticipantsChanged';
import type { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { resolvePresenceTimeoutConfig } from '@/app/presence/timeout';
import { describeLoggableError } from '@/utils/logging/describeLoggableError';
import { warn } from '@/utils/logging/log';

type RuntimeActivitySnapshotEventSocket = Readonly<{
    on: (event: string, handler: (value: unknown, acknowledge?: (value: unknown) => void) => void) => unknown;
}>;

type RuntimeActivitySnapshotPresence = ReturnType<typeof createSessionPublisherPresence>;

const releasedAliveOperationTails = new WeakMap<object, Promise<void>>();
const RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS = 60_000;
/**
 * Backoff after an attempt that did not persist. The first unproductive attempt retries on the very
 * next heartbeat so a one-off transient failure recovers immediately; consecutive ones back off
 * exponentially up to the normal persistence interval.
 *
 * Arming only on success let a saturated database be answered with *more* write attempts: released
 * heartbeats arrive every 2s while thinking and every 15s idle, so a failing session retried 6-30x
 * more often than a healthy one, exactly while the contended resource was exhausted. A permanently
 * unproductive attempt (a superseded socket) behaved the same way.
 */
const RELEASED_ALIVE_RETRY_BACKOFF_BASE_MS = 1_000;

function resolveReleasedAliveRetryBackoffMs(consecutiveUnproductiveAttempts: number, maxBackoffMs: number): number {
    if (consecutiveUnproductiveAttempts <= 1) return 0;
    const exponential = RELEASED_ALIVE_RETRY_BACKOFF_BASE_MS * 2 ** (consecutiveUnproductiveAttempts - 2);
    return Math.min(maxBackoffMs, exponential);
}

async function serializeReleasedAliveOperation<T>(
    presence: RuntimeActivitySnapshotPresence,
    operation: () => Promise<T>,
): Promise<T> {
    const prior = releasedAliveOperationTails.get(presence) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation);
    releasedAliveOperationTails.set(presence, result.then(() => {}, () => {}));
    return await result;
}

export type PublishRuntimeActivitySnapshotProjection = (params: Readonly<{
    sessionId: string;
    projection?: SessionRuntimeActivityProjection;
    active?: boolean;
    activeAt?: number;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    badgeAttentionChanged?: boolean;
    participantCursor: SessionParticipantCursor;
}>) => Promise<void>;

export function registerSessionRuntimeActivitySnapshotSocketEvent(params: Readonly<{
    socket: RuntimeActivitySnapshotEventSocket;
    presence: RuntimeActivitySnapshotPresence;
    binding: Readonly<{ accountId: string; machineId: string; sessionId: string }>;
    publish: PublishRuntimeActivitySnapshotProjection;
    /** Clock for the released-heartbeat persistence window (mirrors `createSessionPublisherPresence`). */
    nowMs?: () => number;
}>): void {
    const nowMs = params.nowMs ?? (() => Date.now());
    // Bound retained observations by expiry without changing the default settled-write cadence.
    const observationRefreshWindowMs = resolvePresenceTimeoutConfig().sessionTimeoutMs / 2;
    const publishParticipants = async (published: Readonly<{
        participantCursors: readonly SessionParticipantCursor[];
        projection?: SessionRuntimeActivityProjection;
        active?: boolean;
        activeAt?: Date;
        latestTurnId?: string | null;
        latestTurnStatus?: PrimaryTurnStatusV1 | null;
        latestTurnStatusObservedAt?: number | null;
        lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
        badgeAttentionChanged?: boolean;
    }>): Promise<void> => {
        await Promise.all(published.participantCursors.map(async (participantCursor) => {
            await params.publish({
                sessionId: params.binding.sessionId,
                participantCursor,
                ...(published.projection ? { projection: published.projection } : {}),
                ...(typeof published.active === 'boolean' ? { active: published.active } : {}),
                ...(published.activeAt ? { activeAt: published.activeAt.getTime() } : {}),
                ...('latestTurnId' in published ? { latestTurnId: published.latestTurnId } : {}),
                ...('latestTurnStatus' in published ? { latestTurnStatus: published.latestTurnStatus } : {}),
                ...('latestTurnStatusObservedAt' in published
                    ? { latestTurnStatusObservedAt: published.latestTurnStatusObservedAt }
                    : {}),
                ...('lastRuntimeIssue' in published ? { lastRuntimeIssue: published.lastRuntimeIssue } : {}),
                ...(typeof published.badgeAttentionChanged === 'boolean'
                    ? { badgeAttentionChanged: published.badgeAttentionChanged }
                    : {}),
            });
        }));
    };
    const registrationFanouts = new Map<string, Promise<void>>();
    let closeFanout: Promise<void> | null = null;
    const publishTransitionOnce = async (
        transition: 'registration' | 'close',
        published: Parameters<typeof publishParticipants>[0],
    ): Promise<void> => {
        const registrationKey = published.activeAt
            ? `${published.activeAt.getTime()}:${published.projection?.revision ?? 'reachability'}`
            : null;
        const current = transition === 'registration' && registrationKey !== null
            ? registrationFanouts.get(registrationKey)
            : closeFanout;
        if (current) {
            await current;
            return;
        }

        const attempt = publishParticipants(published);
        if (transition === 'registration' && registrationKey !== null) registrationFanouts.set(registrationKey, attempt);
        else closeFanout = attempt;
        try {
            await attempt;
        } catch (error) {
            if (transition === 'registration' && registrationKey !== null && registrationFanouts.get(registrationKey) === attempt) {
                registrationFanouts.delete(registrationKey);
            }
            if (transition === 'close' && closeFanout === attempt) closeFanout = null;
            throw error;
        }
    };
    let legacyAliveInFlight = false;
    let nextLegacyAliveAttemptAtMs: number | null = null;
    let consecutiveUnproductiveLegacyAliveAttempts = 0;
    let pendingLegacyAliveAtMs: number | null = null;
    let legacyAliveTimer: ReturnType<typeof setTimeout> | null = null;
    let legacyAliveStopped = false;

    const clearPendingLegacyAlive = (): void => {
        pendingLegacyAliveAtMs = null;
        if (legacyAliveTimer !== null) clearTimeout(legacyAliveTimer);
        legacyAliveTimer = null;
    };
    const stopLegacyAlive = (): void => {
        legacyAliveStopped = true;
        clearPendingLegacyAlive();
    };
    params.socket.on('disconnect', stopLegacyAlive);

    /** Arm the next allowed attempt from the outcome of the one that just settled. */
    const armLegacyAliveAttemptWindow = (persisted: boolean, observedAtMs: number): void => {
        if (persisted) {
            consecutiveUnproductiveLegacyAliveAttempts = 0;
            nextLegacyAliveAttemptAtMs = Math.min(
                nowMs() + RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS,
                observedAtMs + observationRefreshWindowMs,
            );
            return;
        }
        consecutiveUnproductiveLegacyAliveAttempts += 1;
        nextLegacyAliveAttemptAtMs = nowMs()
            + resolveReleasedAliveRetryBackoffMs(
                consecutiveUnproductiveLegacyAliveAttempts,
                Math.min(RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS, observationRefreshWindowMs),
            );
    };

    params.socket.on(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, async (value, acknowledge) => {
        const request = SessionRuntimeActivitySnapshotRequestSchema.safeParse(value);
        if (!request.success || request.data.sessionId !== params.binding.sessionId) {
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: 'rejected',
                reason: 'invalid_request',
            }));
            return;
        }

        try {
            const result = await params.presence.publishSnapshot({
                socket: params.socket,
                binding: params.binding,
                completeSnapshot: request.data.snapshot,
            });
            if (result.status === 'applied' || ('activeAt' in result && result.status === 'unchanged')) {
                const published = {
                    participantCursors: result.participantCursors,
                    ...(result.status === 'applied' ? { projection: result.projection } : {}),
                    ...('activeAt' in result ? { active: true, activeAt: result.activeAt } : {}),
                };
                if ('activeAt' in result) await publishTransitionOnce('registration', published);
                else await publishParticipants(published);
            }
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: result.status,
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                ...(result.status === 'applied' || result.status === 'unchanged'
                    ? { projection: result.projection }
                    : { reason: result.reason }),
            }));
        } catch {
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: 'retryable',
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                reason: 'internal',
            }));
        }
    });

    params.socket.on(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, async (value, acknowledge) => {
        const request = SessionRuntimeActivityCloseRequestSchema.safeParse(value);
        if (!request.success || request.data.sessionId !== params.binding.sessionId) {
            acknowledge?.({ status: 'rejected', reason: 'invalid_request' });
            return;
        }
        clearPendingLegacyAlive();
        try {
            const result = await serializeReleasedAliveOperation(
                params.presence,
                async () => await params.presence.closePublisher({ socket: params.socket }),
            );
            if (result.status === 'closed') {
                stopLegacyAlive();
                await publishTransitionOnce('close', {
                    participantCursors: result.participantCursors,
                    active: false,
                    activeAt: result.activeAt,
                    ...(result.projection ? { projection: result.projection } : {}),
                    ...(result.turnProjection ?? {}),
                    badgeAttentionChanged: result.badgeAttentionChanged,
                });
            }
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: result.status === 'superseded' ? 'rejected' : result.status,
                sessionId: request.data.sessionId,
                ...(result.status === 'rejected' || result.status === 'superseded'
                    ? { reason: result.status === 'superseded' ? 'superseded' : result.reason }
                    : {}),
            }));
        } catch {
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: 'retryable',
                sessionId: request.data.sessionId,
                reason: 'internal',
            }));
        }
    });

    const flushLegacyAlive = async (): Promise<void> => {
        if (legacyAliveStopped || legacyAliveInFlight || pendingLegacyAliveAtMs === null) return;
        if (nextLegacyAliveAttemptAtMs !== null && nowMs() < nextLegacyAliveAttemptAtMs) {
            if (legacyAliveTimer === null) {
                legacyAliveTimer = setTimeout(async () => {
                    legacyAliveTimer = null;
                    await flushLegacyAlive();
                }, nextLegacyAliveAttemptAtMs - nowMs());
                legacyAliveTimer.unref();
            }
            return;
        }
        let observedAtMs = pendingLegacyAliveAtMs;
        legacyAliveInFlight = true;
        try {
            const persisted = await serializeReleasedAliveOperation(params.presence, async () => {
                if (legacyAliveStopped) return { status: 'unchanged' as const };
                // Coalesce until shared admission. A queued close may clear pending observations,
                // but the accepted alive still precedes that close using its genuine receipt time.
                observedAtMs = pendingLegacyAliveAtMs ?? observedAtMs;
                clearPendingLegacyAlive();
                const observedAt = new Date(observedAtMs);
                const touched = await params.presence.touchPublisher({ socket: params.socket, observedAt });
                if (touched.status === 'touched') {
                    return { status: 'touched' as const, touched };
                }
                if (touched.status !== 'unregistered' || legacyAliveStopped) return { status: 'unchanged' as const };
                const registered = await params.presence.registerPublisher({
                    socket: params.socket,
                    binding: params.binding,
                    completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
                    observedAt,
                });
                if (registered.status !== 'registered') return { status: 'unchanged' as const };
                return { status: 'registered' as const, registered };
            });
            armLegacyAliveAttemptWindow(persisted.status !== 'unchanged', observedAtMs);
            if (persisted.status === 'touched') {
                await publishParticipants({
                    participantCursors: persisted.touched.participantCursors,
                    active: true,
                    activeAt: persisted.touched.activeAt,
                });
            } else if (persisted.status === 'registered') {
                await publishTransitionOnce('registration', {
                    participantCursors: persisted.registered.participantCursors,
                    active: true,
                    activeAt: persisted.registered.activeAt,
                    ...(persisted.registered.activity.status === 'applied'
                        ? { projection: persisted.registered.activity.projection }
                        : {}),
                });
            }
        } catch (error) {
            armLegacyAliveAttemptWindow(false, observedAtMs);
            warn(
                { module: 'session-publisher-presence', error: describeLoggableError(error) },
                'Failed to adapt released session-alive event',
            );
            // Released heartbeat events have no acknowledgement channel; the next heartbeat retries
            // once the backoff armed above elapses.
        } finally {
            legacyAliveInFlight = false;
            await flushLegacyAlive();
        }
    };

    params.socket.on(SESSION_PUBLISHER_LEGACY_ALIVE_EVENT, async (value) => {
        const alive = SessionPublisherLegacyAliveSchema.safeParse(value);
        if (!alive.success || alive.data.sid !== params.binding.sessionId || legacyAliveStopped) return;
        pendingLegacyAliveAtMs = nowMs();
        await flushLegacyAlive();
    });

    params.socket.on(SESSION_PUBLISHER_LEGACY_END_EVENT, async (value) => {
        const ended = SessionPublisherLegacyEndSchema.safeParse(value);
        if (!ended.success || ended.data.sid !== params.binding.sessionId) return;
        clearPendingLegacyAlive();
        try {
            const result = await serializeReleasedAliveOperation(
                params.presence,
                async () => await params.presence.closePublisher({ socket: params.socket }),
            );
            if (result.status !== 'closed') return;
            stopLegacyAlive();
            await publishTransitionOnce('close', {
                participantCursors: result.participantCursors,
                active: false,
                activeAt: result.activeAt,
                ...(result.projection ? { projection: result.projection } : {}),
                ...(result.turnProjection ?? {}),
                badgeAttentionChanged: result.badgeAttentionChanged,
            });
        } catch (error) {
            warn(
                { module: 'session-publisher-presence', error: describeLoggableError(error) },
                'Failed to adapt released session-end event',
            );
            // Released end events have no required acknowledgement; timeout remains authoritative.
        }
    });
}
