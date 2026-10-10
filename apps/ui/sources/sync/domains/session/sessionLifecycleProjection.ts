import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveMergedSessionRuntimeActivityProjectionFields } from '@/sync/engine/sessions/sessionRuntimeActivityProjection';
import { hasTerminalPrimaryTurnStatus } from './attention/runtimePresentation';

type SessionLifecycleProjection = Pick<Session,
    | 'seq' | 'updatedAt' | 'meaningfulActivityAt' | 'lastTurnCompletedAt'
    | 'active' | 'activeAt' | 'thinking' | 'thinkingAt'
    | 'latestTurnId' | 'latestTurnStatus' | 'latestTurnStatusObservedAt'
    | 'pendingVersion' | 'pendingCount' | 'pendingBlockedCount' | 'pendingActivationAuthorization'
    | 'latestReadyEventSeq' | 'latestReadyEventAt'
    | 'runtimeActivityState' | 'runtimeActivityActiveCount' | 'runtimeActivityObservedAt' | 'runtimeActivityRevision'
>;

export function normalizeSessionOrderingNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function normalizeSessionReadyEventSeq(value: unknown): number | null {
    const number = normalizeSessionOrderingNumber(value);
    return number === null ? null : Math.max(0, number);
}

function normalizeSessionReadyEventAt(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveMergedSessionReadyEvent(params: Readonly<{
    previousSession: SessionLifecycleProjection | undefined;
    incomingSession: Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'>;
}>): Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'> {
    const previousSeq = normalizeSessionReadyEventSeq(params.previousSession?.latestReadyEventSeq);
    const previousAt = normalizeSessionReadyEventAt(params.previousSession?.latestReadyEventAt);
    const incomingSeq = normalizeSessionReadyEventSeq(params.incomingSession.latestReadyEventSeq);
    const incomingAt = normalizeSessionReadyEventAt(params.incomingSession.latestReadyEventAt);

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

    for (const key of ['seq', 'updatedAt', 'meaningfulActivityAt', 'lastTurnCompletedAt'] as const) {
        const previousNumber = normalizeSessionOrderingNumber(previous[key]);
        const incomingNumber = normalizeSessionOrderingNumber(incoming[key]);
        if (previousNumber !== null && (incomingNumber === null || incomingNumber < previousNumber)) {
            applyPatch({ [key]: previousNumber });
        }
    }
    if (isOlder(incoming.activeAt, previous.activeAt)) {
        applyPatch({ active: previous.active, activeAt: previous.activeAt });
    }
    if (isOlder(incoming.thinkingAt, previous.thinkingAt)) {
        applyPatch({ thinking: previous.thinking, thinkingAt: previous.thinkingAt });
    }

    const incomingOrderingAt = normalizeSessionOrderingNumber(incoming.latestTurnStatusObservedAt) ?? normalizeSessionOrderingNumber(incoming.updatedAt);
    const previousObservedAt = normalizeSessionOrderingNumber(previous.latestTurnStatusObservedAt);
    if (incomingOrderingAt !== null && previousObservedAt !== null && (
        incomingOrderingAt < previousObservedAt
        || (incomingOrderingAt === previousObservedAt
            && hasTerminalPrimaryTurnStatus(previous.latestTurnStatus ?? null)
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
