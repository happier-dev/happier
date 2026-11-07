import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    didSessionRuntimeObservationRecover,
    sessionRuntimeObservations,
} from '@/sync/domains/session/sessionRuntimeObservation';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';

type RuntimePublication = Readonly<{
    id: string;
    serverId?: string;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
    thinkingAt?: number;
    presence?: 'online' | number;
    archivedAt?: number | null;
}>;

/** All top-level producer facts, with deep session-shaped plain values. */
export function areSessionPublicationFactsEqual(previous: object | undefined, next: object): boolean {
    if (previous === next) return true;
    if (!previous) return false;
    const keys = new Set([...Reflect.ownKeys(previous), ...Reflect.ownKeys(next)]);
    for (const key of keys) {
        if (Object.hasOwn(previous, key) !== Object.hasOwn(next, key)) return false;
        if (!areSessionValuesDeepEqual(Reflect.get(previous, key), Reflect.get(next, key))) return false;
    }
    return true;
}

/** Separate admitted liveness carriers from Session content at its publication owner. */
export function resolveSessionRuntimePublication<T extends RuntimePublication>(
    previous: T | undefined,
    next: T,
    carrier: Pick<RuntimePublication, 'activeAt' | 'updatedAt'>,
    fullPublicationUpdatedAt?: number,
): T {
    const address = normalizeSessionAddress(next.serverId, next.id);
    if (!address) return next;
    const sameSession = previous?.serverId === address.serverId && previous.id === next.id;

    // Capture the actual witness before admitting a durable observation. Presence
    // is deliberately omitted: attachment alone cannot establish device presence.
    const before = sessionRuntimeObservations.read(address);
    if (sameSession && (carrier.activeAt !== previous.activeAt || next.active !== previous.active || next.thinking !== previous.thinking)) {
        sessionRuntimeObservations.observe(address, {
            active: next.active, activeAt: carrier.activeAt,
            ...(next.thinking !== undefined ? { thinking: next.thinking } : {}),
        });
    }

    // Only full Session ingress supplies this clock. Compact-list carriers and
    // merged lifecycle clocks prove no newer full documents.
    if (fullPublicationUpdatedAt !== undefined) {
        sessionRuntimeObservations.recordFullPublication(address, fullPublicationUpdatedAt, next);
    }
    if (!sameSession) return next;

    // A clock-only carrier is not content. Keep the retained Session identity.
    if (next.activeAt === previous.activeAt && areSessionPublicationFactsEqual(previous, {
        ...next, updatedAt: previous.updatedAt,
    })) {
        return previous;
    }

    // Preserve the admitted clock pair before lifecycle ordering clamps a late
    // sample to a newer runtime row.
    const activityClockChanged = carrier.activeAt > previous.activeAt
        || (carrier.activeAt < previous.activeAt && next.activeAt === previous.activeAt);
    if (next.active !== true || !activityClockChanged
        || !(carrier.updatedAt > previous.updatedAt && next.updatedAt > previous.updatedAt)) return next;
    if (!areSessionPublicationFactsEqual(previous, {
        ...next, updatedAt: previous.updatedAt, activeAt: previous.activeAt,
    })) return next;

    const after = sessionRuntimeObservations.read(address);
    return didSessionRuntimeObservationRecover(
        before ? { ...before, archivedAt: previous.archivedAt } : undefined,
        after ? { ...after, archivedAt: next.archivedAt } : undefined,
        Date.now(),
    )
        ? { ...previous, activeAt: next.activeAt }
        : previous;
}
