export type SessionListHydrationPriorityReason = 'required' | 'route' | 'active' | 'priority' | 'eager' | 'background';

export type SessionListHydrationPriorityCounts = Record<SessionListHydrationPriorityReason, number> & {
    skippedBackground: number;
};

export type SessionListHydrationPriorityResult<T> = Readonly<{
    rows: T[];
    reasonCounts: SessionListHydrationPriorityCounts;
    reasonById: ReadonlyMap<string, SessionListHydrationPriorityReason>;
}>;

type HydrationPriorityRow = Readonly<{
    id: string;
    active?: boolean;
}>;

function normalizeSessionIds(sessionIds?: Iterable<string> | null): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawSessionId of sessionIds ?? []) {
        const sessionId = String(rawSessionId ?? '').trim();
        if (!sessionId || seen.has(sessionId)) continue;
        seen.add(sessionId);
        normalized.push(sessionId);
    }
    return normalized;
}

function appendRowsById<T extends HydrationPriorityRow>(params: {
    output: T[];
    reason: SessionListHydrationPriorityReason;
    reasonById: Map<string, SessionListHydrationPriorityReason>;
    usedSessionIds: Set<string>;
    rowsById: Map<string, T>;
    sessionIds: readonly string[];
}): number {
    let appended = 0;
    for (const sessionId of params.sessionIds) {
        if (params.usedSessionIds.has(sessionId)) continue;
        const row = params.rowsById.get(sessionId);
        if (!row) continue;
        params.usedSessionIds.add(sessionId);
        params.reasonById.set(row.id, params.reason);
        params.output.push(row);
        appended += 1;
    }
    return appended;
}

export function orderRowsForSessionListHydration<T extends HydrationPriorityRow>(params: {
    rows: readonly T[];
    requiredSessionIds?: Iterable<string> | null;
    routeSessionIds?: Iterable<string> | null;
    activeSessionIds?: Iterable<string> | null;
    prioritySessionIds?: Iterable<string> | null;
    eagerHydrationCount?: number;
    maxBackgroundHydrationRows?: number;
}): SessionListHydrationPriorityResult<T> {
    const rowsById = new Map(params.rows.map((row) => [row.id, row]));
    const usedSessionIds = new Set<string>();
    const reasonById = new Map<string, SessionListHydrationPriorityReason>();
    const rows: T[] = [];
    const reasonCounts: SessionListHydrationPriorityCounts = {
        required: 0,
        route: 0,
        active: 0,
        priority: 0,
        eager: 0,
        background: 0,
        skippedBackground: 0,
    };

    reasonCounts.required = appendRowsById({
        output: rows,
        reason: 'required',
        reasonById,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.requiredSessionIds),
    });
    reasonCounts.route = appendRowsById({
        output: rows,
        reason: 'route',
        reasonById,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.routeSessionIds),
    });
    reasonCounts.active = appendRowsById({
        output: rows,
        reason: 'active',
        reasonById,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.activeSessionIds),
    });
    reasonCounts.priority = appendRowsById({
        output: rows,
        reason: 'priority',
        reasonById,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.prioritySessionIds),
    });

    for (const row of params.rows) {
        if (row.active !== true || usedSessionIds.has(row.id)) continue;
        usedSessionIds.add(row.id);
        reasonById.set(row.id, 'active');
        rows.push(row);
        reasonCounts.active += 1;
    }

    const remainingRows = params.rows.filter((row) => !usedSessionIds.has(row.id));
    const eagerHydrationCount = Math.max(0, Math.trunc(params.eagerHydrationCount ?? 0));
    const maxBackgroundHydrationRows = params.maxBackgroundHydrationRows === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.trunc(params.maxBackgroundHydrationRows));
    const eagerRows = remainingRows.slice(0, eagerHydrationCount);
    const backgroundCandidates = remainingRows.slice(eagerHydrationCount);
    const backgroundRows = backgroundCandidates.slice(0, maxBackgroundHydrationRows);

    for (const row of eagerRows) {
        reasonById.set(row.id, 'eager');
    }
    for (const row of backgroundRows) {
        reasonById.set(row.id, 'background');
    }
    rows.push(...eagerRows, ...backgroundRows);
    reasonCounts.eager = eagerRows.length;
    reasonCounts.background = backgroundRows.length;
    reasonCounts.skippedBackground = backgroundCandidates.length - backgroundRows.length;

    return { rows, reasonCounts, reasonById };
}
