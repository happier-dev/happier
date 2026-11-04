import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

import { readSessionListRowsForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionRelationFact, type SessionRelationFact } from '@/sync/store/domains/sessionRelations';

const EMPTY_SESSIONS: readonly SessionRelationRecord[] = Object.freeze([]);

/** Read current admitted display/base records only for the requested relationship member. */
export function readSessionRelationRecord(
    sessions: Readonly<Record<string, Session>>,
    sessionId: string,
    serverId: string | null,
    rowsByServerId?: SessionListRowStateByServerId,
): SessionRelationRecord | undefined {
    if (!serverId?.trim()) return undefined;
    const operationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const candidate = sessions[sessionId];
    const base = candidate?.serverId && areServerProfileIdentifiersEquivalent(candidate.serverId, operationServerId) ? candidate : undefined;
    const row = readSessionListRowsForServerId(rowsByServerId, operationServerId)?.[sessionId];
    return row ? { record: row, baseSession: base, serverId: operationServerId } : base;
}

export function readSessionRelationFacts(records: Readonly<Record<string, SessionRelationRecord>>): Readonly<Record<string, SessionRelationFact>> {
    return Object.fromEntries(Object.entries(records).map(([id, input]) => [id, readSessionRelationFact(input)]));
}

/** Relationship readers need the qualified list too: opening a transcript is not membership. */
export function selectSessionRelationRecords(
    sessions: Readonly<Record<string, Session>>,
    serverId: string | null,
    rowsByServerId?: SessionListRowStateByServerId,
): Readonly<Record<string, SessionRelationRecord>> {
    if (!serverId?.trim()) return {};
    const operationServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const records: Record<string, SessionRelationRecord> = {};
    for (const session of Object.values(sessions)) {
        if (session.serverId && areServerProfileIdentifiersEquivalent(session.serverId, serverId)) records[session.id] = session;
    }
    for (const row of Object.values(readSessionListRowsForServerId(rowsByServerId, operationServerId) ?? {})) {
        records[row.id] = { record: row, baseSession: sessions[row.id]?.serverId
            && areServerProfileIdentifiersEquivalent(sessions[row.id].serverId, operationServerId) ? sessions[row.id] : undefined, serverId: operationServerId };
    }
    return records;
}

/**
 * The Sessions in this Session's `manager` subtree, as the store holds them.
 *
 * Inputs retain the admitted row and hydrated base independently. Mounted readers select their raw
 * references; an operation-local descriptor is never a second retained Session projection.
 */
export function selectSessionReportSubtree(
    sessions: Readonly<Record<string, Session>>,
    managerSessionId: string,
    serverId: string | null,
    rowsByServerId?: SessionListRowStateByServerId,
): readonly SessionRelationRecord[] {
    if (!serverId?.trim()) return EMPTY_SESSIONS;
    const records = selectSessionRelationRecords(sessions, serverId, rowsByServerId);
    return selectSessionReportIds(readSessionRelationFacts(records), managerSessionId).map(id => records[id]!);
}

/** Topology consumes only the Session/list producer's compact relationship facts. */
export function selectSessionReportIds(
    relations: Readonly<Record<string, SessionRelationFact>>,
    managerSessionId: string,
): readonly string[] {
    let childrenByLead: Map<string, string[]> | null = null;
    for (const [id, relation] of Object.entries(relations)) {
        const lead = relation.managerSessionId;
        if (!lead) continue;
        childrenByLead ??= new Map();
        const siblings = childrenByLead.get(lead);
        if (siblings) siblings.push(id);
        else childrenByLead.set(lead, [id]);
    }
    if (!childrenByLead) return [];
    const subtree: string[] = [];
    const visited = new Set<string>([managerSessionId]);
    const queue = [managerSessionId];
    while (queue.length > 0) {
        const lead = queue.shift() as string;
        for (const child of childrenByLead.get(lead) ?? []) {
            if (visited.has(child)) continue;
            visited.add(child);
            subtree.push(child);
            queue.push(child);
        }
    }
    // Siblings read oldest first, the order the lead started them in.
    subtree.sort((a, b) => relations[a]!.createdAt - relations[b]!.createdAt);
    return subtree;
}

export function selectSessionAncestorIds(relations: Readonly<Record<string, SessionRelationFact>>, sessionId: string): readonly string[] {
    const ancestors: string[] = [];
    const visited = new Set([sessionId]);
    let leadId = relations[sessionId]?.managerSessionId;
    while (leadId && !visited.has(leadId) && relations[leadId]) {
        visited.add(leadId);
        ancestors.unshift(leadId);
        leadId = relations[leadId]?.managerSessionId;
    }
    return ancestors;
}
