import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowsForServerId, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

const EMPTY_SESSIONS: readonly Session[] = Object.freeze([]);
const projectedRows = new WeakMap<SessionListRenderableSession, Readonly<{
    base: Session | undefined;
    serverId: string;
    session: Session;
}>>();

/** Relationship readers need the qualified list too: opening a transcript is not membership. */
export function selectSessionRelationRecords(
    sessions: Readonly<Record<string, Session>>,
    serverId: string | null,
    rowsByServerId?: SessionListRowStateByServerId,
): Readonly<Record<string, Session>> {
    if (!serverId?.trim()) return {};
    const records: Record<string, Session> = {};
    for (const session of Object.values(sessions)) {
        if (session.serverId && areServerProfileIdentifiersEquivalent(session.serverId, serverId)) records[session.id] = session;
    }
    for (const row of Object.values(readSessionListRowsForServerId(rowsByServerId, serverId) ?? {})) {
        const base = records[row.id];
        if (base && base.seq > row.seq) continue;
        const cached = projectedRows.get(row);
        if (cached && cached.base === base && cached.serverId === serverId) {
            records[row.id] = cached.session;
            continue;
        }
        const session = buildSessionFromListRenderable(row, { baseSession: base, serverId });
        projectedRows.set(row, { base, serverId, session });
        records[row.id] = session;
    }
    return records;
}

function normalizeId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * The Sessions in this Session's `reportsTo` subtree, as the store holds them.
 *
 * Shallow-stable: the array keeps its identity until a Session in the subtree changes, joins or leaves,
 * so an unrelated Session's streamed update does not re-project the lead's Work.
 */
export function selectSessionReportSubtree(
    sessions: Readonly<Record<string, Session>>,
    leadSessionId: string,
    serverId: string | null,
    rowsByServerId?: SessionListRowStateByServerId,
): readonly Session[] {
    if (!serverId?.trim()) return EMPTY_SESSIONS;
    let childrenByLead: Map<string, Session[]> | null = null;
    for (const session of Object.values(selectSessionRelationRecords(sessions, serverId, rowsByServerId))) {
        const lead = normalizeId(session.reportsTo?.sessionId);
        if (!lead) continue;
        childrenByLead ??= new Map();
        const siblings = childrenByLead.get(lead);
        if (siblings) siblings.push(session);
        else childrenByLead.set(lead, [session]);
    }
    if (!childrenByLead) return EMPTY_SESSIONS;
    const subtree: Session[] = [];
    const visited = new Set<string>([leadSessionId]);
    const queue = [leadSessionId];
    while (queue.length > 0) {
        const lead = queue.shift() as string;
        for (const child of childrenByLead.get(lead) ?? []) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            subtree.push(child);
            queue.push(child.id);
        }
    }
    // Siblings read oldest first, the order the lead started them in.
    subtree.sort((a, b) => a.createdAt - b.createdAt);
    return subtree.length === 0 ? EMPTY_SESSIONS : subtree;
}
