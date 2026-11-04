import {
    compareSessionListSessionOrderingKeys,
    readSessionListUpdatedOrderingKey,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import { buildVisibleSessionNavigationEntries, moveSessionMruEntryToFront } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

type OrderingCandidate = Readonly<{
    id: string;
    serverId?: string | null;
    meaningfulActivityAt?: number | null;
    updatedAt?: number | null;
    createdAt?: number | null;
}>;

export function sortSessionSelectionCandidates<T extends OrderingCandidate>(sessions: ReadonlyArray<T>, navigation?: Readonly<{
    focusedSession?: SessionAddress | null;
    mruOrder?: readonly string[];
}>): T[] {
    const orderingKey = (session: T) => ({
        updated: readSessionListUpdatedOrderingKey(session),
        createdAt: typeof session.createdAt === 'number' && Number.isFinite(session.createdAt) ? session.createdAt : 0,
        stableId: session.id.trim(),
    });
    const ordered = [...sessions].sort((left, right) => compareSessionListSessionOrderingKeys(
        orderingKey(left), orderingKey(right), 'updated',
    ));
    if (!navigation) return ordered;
    const entries = buildVisibleSessionNavigationEntries(ordered.map(session => ({
        type: 'session', sessionId: session.id, serverId: session.serverId,
    })));
    const recentKeys = moveSessionMruEntryToFront({
        order: navigation.mruOrder ?? [],
        activeSessionKey: navigation.focusedSession ? sessionAddressKey(navigation.focusedSession) : null,
        knownSessionEntries: entries, maxEntries: ordered.length,
    });
    const rank = new Map(recentKeys.map((key, index) => [key, index]));
    const key = (session: T) => session.serverId ? sessionAddressKey({ serverId: session.serverId, sessionId: session.id }) : session.id;
    return ordered.sort((left, right) => (rank.get(key(left)) ?? recentKeys.length) - (rank.get(key(right)) ?? recentKeys.length));
}
