import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowsForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionPresentationRecord, readSessionPresentationInputRelations, type SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

export type SessionRelationFact = Readonly<{ managerSessionId: string | null; createdAt: number }>;
export type SessionRelationsByServerId = Readonly<Record<string, Readonly<Record<string, SessionRelationFact>>>>;
export const EMPTY_SESSION_RELATION_FACTS: Readonly<Record<string, SessionRelationFact>> = Object.freeze({});
export const EMPTY_SESSION_RELATIONS: SessionRelationsByServerId = Object.freeze({});

type RelationState = Readonly<{
    sessions: Readonly<Record<string, Session>>;
    sessionListRowsByServerId: SessionListRowStateByServerId;
    sessionRelationsByServerId?: SessionRelationsByServerId;
}>;

export function readSessionRelationFact(input: SessionRelationRecord): SessionRelationFact {
    const manager = readSessionManagerSessionIdV1(readSessionPresentationInputRelations(input));
    return { managerSessionId: manager?.trim() || null, createdAt: readSessionPresentationRecord(input).createdAt };
}

/**
 * Session/list ingress publishes only membership and manager facts. Message sequence, status and
 * private display updates keep these inputs stable; readers still select the current raw records.
 * Exact ingress deltas inspect changed ids only. A whole snapshot/reset without a delta admits the
 * structural replacement once through this same producer.
 */
export function publishSessionRelations(
    previous: RelationState,
    next: RelationState,
    changedIds?: readonly string[],
): SessionRelationsByServerId {
    const baseline = previous.sessionRelationsByServerId ?? EMPTY_SESSION_RELATIONS;
    if (previous.sessions === next.sessions && previous.sessionListRowsByServerId === next.sessionListRowsByServerId) return baseline;
    const ids = changedIds ? new Set(changedIds) : new Set(previous.sessions === next.sessions ? [] : [
        ...Object.keys(previous.sessions), ...Object.keys(next.sessions),
    ]);
    const homes = new Set([...Object.keys(previous.sessionListRowsByServerId), ...Object.keys(next.sessionListRowsByServerId),
        ...Object.keys(baseline)].map(resolveServerProfileScopeIdForIdentifier));
    for (const id of ids) {
        for (const session of [previous.sessions[id], next.sessions[id]]) {
            if (session?.serverId?.trim()) homes.add(resolveServerProfileScopeIdForIdentifier(session.serverId));
        }
    }
    let result = baseline;
    for (const serverId of homes) {
        if (!serverId) continue;
        const rows = readSessionListRowsForServerId(next.sessionListRowsByServerId, serverId);
        const previousRows = readSessionListRowsForServerId(previous.sessionListRowsByServerId, serverId);
        if (previous.sessions === next.sessions && rows === previousRows) continue;
        const before = baseline[serverId] ?? {};
        const candidates = changedIds ? ids : new Set([...ids, ...Object.keys(before),
            ...Object.keys(previousRows ?? {}),
            ...Object.keys(rows ?? {})]);
        // Removing a whole Home also retires row-only records omitted from ordinary membership.
        if (changedIds && !rows && previousRows) {
            for (const id of Object.keys(before)) candidates.add(id);
        }
        let facts: Record<string, SessionRelationFact> | undefined;
        for (const id of candidates) {
            const session = next.sessions[id];
            const base = session?.serverId && areServerProfileIdentifiersEquivalent(session.serverId, serverId) ? session : undefined;
            const row = rows?.[id];
            const record = row ?? base;
            const fact = record ? readSessionRelationFact(row ? { record: row, baseSession: base, serverId } : record) : null;
            const old = before[id];
            if (fact ? old && old.managerSessionId === fact.managerSessionId && old.createdAt === fact.createdAt : !old) continue;
            facts ??= { ...before };
            if (fact) facts[id] = fact;
            else delete facts[id];
        }
        if (facts) result = { ...result, [serverId]: facts };
    }
    return result;
}
