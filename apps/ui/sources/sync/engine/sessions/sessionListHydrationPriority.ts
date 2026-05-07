export type SessionListHydrationPriorityReason = 'required' | 'route' | 'active' | 'eager' | 'background';

export type SessionListHydrationPriorityCounts = Record<SessionListHydrationPriorityReason, number>;

type SessionListHydrationPriorityRow = Readonly<{
    id: string;
    active?: boolean;
}>;

type SessionListHydrationPriorityParams<Row extends SessionListHydrationPriorityRow> = Readonly<{
    rows: readonly Row[];
    requiredSessionIds?: ReadonlySet<string> | readonly string[];
    routeSessionIds?: readonly string[];
    activeSessionIds?: ReadonlySet<string> | readonly string[];
    eagerHydrationCount?: number;
}>;

export type OrderedSessionListHydrationRows<Row extends SessionListHydrationPriorityRow> = Readonly<{
    rows: Row[];
    counts: SessionListHydrationPriorityCounts;
}>;

function normalizeSessionIds(values: ReadonlySet<string> | readonly string[] | undefined): string[] {
    if (!values) return [];
    const rawValues = Array.isArray(values) ? values : Array.from(values);
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of rawValues) {
        const id = String(value ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function appendRowsById<Row extends SessionListHydrationPriorityRow>(params: Readonly<{
    ids: readonly string[];
    rowById: ReadonlyMap<string, Row>;
    assignedIds: Set<string>;
    out: Row[];
}>): number {
    let added = 0;
    for (const id of params.ids) {
        if (params.assignedIds.has(id)) continue;
        const row = params.rowById.get(id);
        if (!row) continue;
        params.assignedIds.add(id);
        params.out.push(row);
        added += 1;
    }
    return added;
}

export function orderRowsForSessionListHydration<Row extends SessionListHydrationPriorityRow>(
    params: SessionListHydrationPriorityParams<Row>,
): OrderedSessionListHydrationRows<Row> {
    const counts: SessionListHydrationPriorityCounts = {
        required: 0,
        route: 0,
        active: 0,
        eager: 0,
        background: 0,
    };
    const rowById = new Map(params.rows.map((row) => [row.id, row]));
    const assignedIds = new Set<string>();
    const orderedRows: Row[] = [];
    counts.required = appendRowsById({
        ids: normalizeSessionIds(params.requiredSessionIds),
        rowById,
        assignedIds,
        out: orderedRows,
    });
    counts.route = appendRowsById({
        ids: normalizeSessionIds(params.routeSessionIds),
        rowById,
        assignedIds,
        out: orderedRows,
    });
    counts.active = appendRowsById({
        ids: normalizeSessionIds(params.activeSessionIds),
        rowById,
        assignedIds,
        out: orderedRows,
    });

    for (const row of params.rows) {
        if (!row.active || assignedIds.has(row.id)) continue;
        assignedIds.add(row.id);
        orderedRows.push(row);
        counts.active += 1;
    }

    const eagerHydrationCount = Math.max(0, Math.trunc(params.eagerHydrationCount ?? 0));
    for (const row of params.rows) {
        if (assignedIds.has(row.id)) continue;
        assignedIds.add(row.id);
        orderedRows.push(row);
        if (counts.eager < eagerHydrationCount) {
            counts.eager += 1;
        } else {
            counts.background += 1;
        }
    }

    return { rows: orderedRows, counts };
}
