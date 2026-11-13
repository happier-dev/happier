import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import type { AgentActivityLocalEntry } from '../types';

function resolveChildSessionActivityState(session: SessionListRenderableSession): Readonly<{
    status: AgentActivityLocalEntry['status'];
    isActive: boolean;
    observedAt: number | null;
    endedAt: number | null;
}> {
    const observedAt = typeof session.latestTurnStatusObservedAt === 'number'
        ? session.latestTurnStatusObservedAt
        : null;
    switch (session.latestTurnStatus) {
        case 'in_progress':
            return { status: 'running', isActive: true, observedAt, endedAt: null };
        case 'completed':
            return { status: 'succeeded', isActive: false, observedAt, endedAt: observedAt };
        case 'failed':
            return { status: 'failed', isActive: false, observedAt, endedAt: observedAt };
        case 'cancelled':
            return { status: 'cancelled', isActive: false, observedAt, endedAt: observedAt };
        case null:
        case undefined:
            return session.thinking
                ? { status: 'running', isActive: true, observedAt: null, endedAt: null }
                : { status: 'unknown', isActive: false, observedAt: null, endedAt: null };
    }
}

export function deriveChildSessionActivityEntries(params: Readonly<{
    parentSessionId: string;
    items: readonly SessionListViewItem[] | null;
    resolveRoleLabel: (role: string, storedName: string | null) => string | null;
}>): readonly AgentActivityLocalEntry[] {
    const parentSessionId = params.parentSessionId.trim();
    if (!parentSessionId || !params.items) return [];
    const seen = new Set<string>();
    const entries: AgentActivityLocalEntry[] = [];
    for (const item of params.items) {
        if (item.type !== 'session') continue;
        const session = item.session;
        if (session.id === parentSessionId || seen.has(session.id)) continue;
        if (session.metadata?.sessionOriginV1?.creatorSessionId !== parentSessionId) continue;
        seen.add(session.id);
        const activityState = resolveChildSessionActivityState(session);
        const role = session.metadata?.sessionRole ?? null;
        const storedRoleName = session.metadata?.sessionRoleName?.trim() || null;
        const roleLabel = role ? params.resolveRoleLabel(role, storedRoleName) : null;
        const title = session.metadata?.name?.trim()
            || session.metadata?.summaryText?.trim()
            || session.id;
        entries.push({
            id: `child_session:${session.id}`,
            kind: 'child_session',
            handle: null,
            status: activityState.status,
            isActive: activityState.isActive,
            title,
            metaDetail: roleLabel,
            startedAtMs: null,
            updatedAtMs: activityState.observedAt,
            endedAtMs: activityState.endedAt,
            runId: null,
            sidechainId: null,
            subagentId: null,
            sessionId: session.id,
        });
    }
    return entries;
}
