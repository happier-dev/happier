export type SessionListHydrationPriorityReason = 'required' | 'route' | 'active' | 'eager' | 'background';

export type SessionListHydrationPriorityResult<T> = Readonly<{
    rows: T[];
    reasonCounts: Record<SessionListHydrationPriorityReason, number>;
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
    eagerHydrationCount?: number;
}): SessionListHydrationPriorityResult<T> {
    const rowsById = new Map(params.rows.map((row) => [row.id, row]));
    const usedSessionIds = new Set<string>();
    const rows: T[] = [];
    const reasonCounts: Record<SessionListHydrationPriorityReason, number> = {
        required: 0,
        route: 0,
        active: 0,
        eager: 0,
        background: 0,
    };

    reasonCounts.required = appendRowsById({
        output: rows,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.requiredSessionIds),
    });
    reasonCounts.route = appendRowsById({
        output: rows,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.routeSessionIds),
    });
    reasonCounts.active = appendRowsById({
        output: rows,
        usedSessionIds,
        rowsById,
        sessionIds: normalizeSessionIds(params.activeSessionIds),
    });

    for (const row of params.rows) {
        if (row.active !== true || usedSessionIds.has(row.id)) continue;
        usedSessionIds.add(row.id);
        rows.push(row);
        reasonCounts.active += 1;
    }

    const remainingRows = params.rows.filter((row) => !usedSessionIds.has(row.id));
    const eagerHydrationCount = Math.max(0, Math.trunc(params.eagerHydrationCount ?? 0));
    const eagerRows = remainingRows.slice(0, eagerHydrationCount);
    const backgroundRows = remainingRows.slice(eagerHydrationCount);

    rows.push(...eagerRows, ...backgroundRows);
    reasonCounts.eager = eagerRows.length;
    reasonCounts.background = backgroundRows.length;

    return { rows, reasonCounts };
}
