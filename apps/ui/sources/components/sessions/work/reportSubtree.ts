import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const EMPTY_SESSIONS: readonly Session[] = Object.freeze([]);

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
): readonly Session[] {
    if (!serverId?.trim()) return EMPTY_SESSIONS;
    let childrenByLead: Map<string, Session[]> | null = null;
    for (const session of Object.values(sessions)) {
        if (!session.serverId || !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) continue;
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
