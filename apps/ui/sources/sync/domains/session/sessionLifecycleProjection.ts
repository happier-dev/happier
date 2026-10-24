import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveMergedSessionRuntimeActivityProjectionFields } from '@/sync/engine/sessions/sessionRuntimeActivityProjection';
import { isTerminalPrimaryTurnStatus } from './attention/deriveSessionRuntimePresentationState';

type SessionLifecycleProjection = Pick<Session,
    | 'seq' | 'updatedAt' | 'meaningfulActivityAt'
    | 'active' | 'activeAt' | 'thinking' | 'thinkingAt'
    | 'latestTurnId' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'
    | 'pendingVersion' | 'pendingCount' | 'pendingBlockedCount' | 'pendingActivationAuthorization'
    | 'latestReadyEventSeq' | 'latestReadyEventAt'
    | 'runtimeActivityState' | 'runtimeActivityActiveCount' | 'runtimeActivityObservedAt' | 'runtimeActivityRevision'
> & Partial<Pick<Session, 'presence'>>;

export function normalizeSessionOrderingNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

type SessionRequestProjection = Partial<Pick<Session,
    | 'agentState' | 'agentStateVersion'
    | 'pendingPermissionRequestCount' | 'pendingUserActionRequestCount' | 'pendingRequestObservedAt'
>> & {
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
};

export function shouldPreserveSessionRequestProjection(
    previous: SessionRequestProjection | undefined,
    incoming: SessionRequestProjection,
): boolean {
    if (!previous) return false;
    const previousVersion = normalizeSessionOrderingNumber(previous.agentStateVersion);
    const incomingVersion = normalizeSessionOrderingNumber(incoming.agentStateVersion);
    if (previousVersion !== null && incomingVersion !== null && previousVersion !== incomingVersion) {
        return incomingVersion < previousVersion;
    }
    return isOlder(incoming.pendingRequestObservedAt, previous.pendingRequestObservedAt);
}

/** Keep request content and its public pending projection on the same accepted observation. */
export function reconcileSessionRequestProjection<T extends SessionRequestProjection>(
    previous: SessionRequestProjection | undefined,
    incoming: T,
): T {
    if (!previous || !shouldPreserveSessionRequestProjection(previous, incoming)) return incoming;
    const hasOlderVersion = isOlder(incoming.agentStateVersion, previous.agentStateVersion);
    let next = incoming;
    const preserve = (key: keyof SessionRequestProjection): void => {
        if ((key in previous || key in next) && next[key] !== previous[key]) {
            next = { ...next, [key]: previous[key] };
        }
    };
    if (hasOlderVersion) {
        preserve('agentState');
        preserve('agentStateVersion');
    }
    for (const key of [
        'pendingPermissionRequestCount', 'pendingUserActionRequestCount',
        'hasPendingPermissionRequests', 'hasPendingUserActionRequests', 'pendingRequestObservedAt',
    ] as const) preserve(key);
    return next;
}

/**
 * Single owner of a session's presence: "online" while the runtime reports it active, otherwise the
 * last-seen timestamp. Every path that changes `active` must derive presence here, or a row that
 * comes back online keeps its last-seen value and its live-runtime signals stay hidden.
 */
export function resolveSessionPresence(session: Readonly<{ active: boolean; activeAt: number }>): 'online' | number {
    return session.active ? 'online' : session.activeAt;
}

function resolveMergedSessionReadyEvent(params: Readonly<{
    previousSession: SessionLifecycleProjection | undefined;
    incomingSession: Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'>;
}>): Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'> {
    const previousSeq = normalizeSessionOrderingNumber(params.previousSession?.latestReadyEventSeq);
    const previousAt = normalizeSessionOrderingNumber(params.previousSession?.latestReadyEventAt);
    const incomingSeq = normalizeSessionOrderingNumber(params.incomingSession.latestReadyEventSeq);
    const incomingAt = normalizeSessionOrderingNumber(params.incomingSession.latestReadyEventAt);

    if (incomingSeq === null) {
        return {
            latestReadyEventSeq: previousSeq,
            latestReadyEventAt: previousAt,
        };
    }

    if (previousSeq === null || incomingSeq > previousSeq) {
        return {
            latestReadyEventSeq: incomingSeq,
            latestReadyEventAt: incomingAt,
        };
    }

    if (incomingSeq < previousSeq) {
        return {
            latestReadyEventSeq: previousSeq,
            latestReadyEventAt: previousAt,
        };
    }

    return {
        latestReadyEventSeq: incomingSeq,
        latestReadyEventAt: incomingAt ?? previousAt,
    };
}

function isOlder(incoming: unknown, previous: unknown): boolean {
    const incomingNumber = normalizeSessionOrderingNumber(incoming);
    const previousNumber = normalizeSessionOrderingNumber(previous);
    return incomingNumber !== null && previousNumber !== null && incomingNumber < previousNumber;
}

/** One ordering rule for the public lifecycle facts shared by detailed and list projections. */
export function reconcileSessionLifecycleProjection<T extends SessionLifecycleProjection>(
    previous: SessionLifecycleProjection | undefined,
    incoming: T,
): T {
    let next = incoming;
    const applyPatch = (patch: Partial<SessionLifecycleProjection>): void => {
        if (Object.entries(patch).some(([key, value]) => next[key as keyof SessionLifecycleProjection] !== value)) {
            next = { ...next, ...patch };
        }
    };

    applyPatch(resolveMergedSessionReadyEvent({ previousSession: previous, incomingSession: incoming }));
    if (!previous) return next;

    for (const key of ['seq', 'updatedAt', 'meaningfulActivityAt'] as const) {
        const previousNumber = normalizeSessionOrderingNumber(previous[key]);
        const incomingNumber = normalizeSessionOrderingNumber(incoming[key]);
        if (previousNumber !== null && (incomingNumber === null || incomingNumber < previousNumber)) {
            applyPatch({ [key]: previousNumber });
        }
    }
    if (isOlder(incoming.activeAt, previous.activeAt)) {
        applyPatch({ active: previous.active, activeAt: previous.activeAt, presence: resolveSessionPresence(previous) });
    }
    if (isOlder(incoming.thinkingAt, previous.thinkingAt)) {
        applyPatch({ thinking: previous.thinking, thinkingAt: previous.thinkingAt });
    }

    const incomingOrderingAt = normalizeSessionOrderingNumber(incoming.latestTurnStatusObservedAt) ?? normalizeSessionOrderingNumber(incoming.updatedAt);
    const previousObservedAt = normalizeSessionOrderingNumber(previous.latestTurnStatusObservedAt);
    if (incomingOrderingAt !== null && previousObservedAt !== null && (
        incomingOrderingAt < previousObservedAt
        || (incomingOrderingAt === previousObservedAt
            && isTerminalPrimaryTurnStatus(previous.latestTurnStatus ?? null)
            && incoming.latestTurnStatus === 'in_progress')
    )) {
        applyPatch({ latestTurnId: previous.latestTurnId, latestTurnStatus: previous.latestTurnStatus,
            latestTurnStatusObservedAt: previous.latestTurnStatusObservedAt });
    }

    if (isOlder(incoming.pendingVersion, previous.pendingVersion)) {
        applyPatch({ pendingVersion: previous.pendingVersion, pendingCount: previous.pendingCount,
            pendingBlockedCount: previous.pendingBlockedCount,
            pendingActivationAuthorization: previous.pendingActivationAuthorization });
    }
    const runtimeActivity = resolveMergedSessionRuntimeActivityProjectionFields(previous, incoming);
    if (runtimeActivity) applyPatch(runtimeActivity);
    return next;
}

type SessionSnapshotProjection = SessionLifecycleProjection & SessionRequestProjection & Pick<Session, 'metadata' | 'metadataVersion'>;

/** Apply the independent lifecycle, request, and metadata ordering rules to a whole snapshot. */
export function reconcileSessionSnapshot<T extends SessionSnapshotProjection>(
    previous: SessionSnapshotProjection | undefined,
    incoming: T,
): T {
    let next = reconcileSessionRequestProjection(previous, incoming);
    const previousMetadataVersion = normalizeSessionOrderingNumber(previous?.metadataVersion);
    const incomingMetadataVersion = normalizeSessionOrderingNumber(incoming.metadataVersion);
    if (previous && previousMetadataVersion !== null && incomingMetadataVersion !== null
        && incomingMetadataVersion < previousMetadataVersion) {
        next = { ...next, metadata: previous.metadata, metadataVersion: previous.metadataVersion };
    }
    return reconcileSessionLifecycleProjection(previous, next);
}
