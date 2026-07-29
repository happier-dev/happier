import type { LocalServiceActionKindV1 } from '@happier-dev/protocol';

export type ManagedLocalServiceRow = Readonly<{
    id: string;
    ownerLabel?: string;
    phase: 'starting' | 'detecting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
    launchMode: 'detectAfterLaunch' | 'assignAndInject' | 'externalRegistered';
    routeName?: string;
    inventoryId?: string;
    port?: number;
    url?: string;
    supportedActions: readonly LocalServiceActionKindV1[];
    diagnostics: readonly unknown[];
    updatedAt: number;
}>;

export type ManagedLocalServicesSnapshot = Readonly<{
    machineId?: string;
    generatedAt: number;
    refreshState: 'idle' | 'refreshing' | 'error';
    rows: readonly ManagedLocalServiceRow[];
    diagnostics: readonly unknown[];
}>;

export type ManagedLocalServicesState = Readonly<{
    generatedAt: number | null;
    refreshState: 'idle' | 'refreshing' | 'error';
    rowIds: readonly string[];
    rowsById: ReadonlyMap<string, ManagedLocalServiceRow>;
    diagnostics: readonly unknown[];
}>;

function rowKey(row: ManagedLocalServiceRow): string {
    return JSON.stringify(row);
}

function areRowsEquivalent(a: ManagedLocalServiceRow | undefined, b: ManagedLocalServiceRow): boolean {
    return Boolean(a) && rowKey(a as ManagedLocalServiceRow) === rowKey(b);
}

function normalizeManagedLocalServiceRow(row: ManagedLocalServiceRow): ManagedLocalServiceRow {
    return {
        ...row,
        supportedActions: [...new Set(row.supportedActions ?? [])],
    };
}

export function createManagedLocalServicesState(): ManagedLocalServicesState {
    return {
        generatedAt: null,
        refreshState: 'idle',
        rowIds: [],
        rowsById: new Map(),
        diagnostics: [],
    };
}

export function applyManagedLocalServicesRefreshStarted(
    state: ManagedLocalServicesState,
    generatedAt: number,
): ManagedLocalServicesState {
    return {
        ...state,
        generatedAt,
        refreshState: 'refreshing',
    };
}

export function applyManagedLocalServicesSnapshot(
    state: ManagedLocalServicesState,
    snapshot: ManagedLocalServicesSnapshot,
): ManagedLocalServicesState {
    const rowsById = new Map<string, ManagedLocalServiceRow>();
    const rowIds: string[] = [];
    for (const rawRow of snapshot.rows) {
        const row = normalizeManagedLocalServiceRow(rawRow);
        rowIds.push(row.id);
        const previous = state.rowsById.get(row.id);
        rowsById.set(row.id, areRowsEquivalent(previous, row) ? previous as ManagedLocalServiceRow : row);
    }
    return {
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        rowIds,
        rowsById,
        diagnostics: snapshot.diagnostics,
    };
}

export function failManagedLocalServicesRefresh(
    state: ManagedLocalServicesState,
    input: Readonly<{ generatedAt: number; reasonCode: string }>,
): ManagedLocalServicesState {
    return {
        ...state,
        generatedAt: input.generatedAt,
        refreshState: 'error',
        diagnostics: [{
            code: input.reasonCode,
            severity: 'warning',
        }],
    };
}

export function selectManagedLocalServiceRows(state: ManagedLocalServicesState): readonly ManagedLocalServiceRow[] {
    return state.rowIds.map((id) => state.rowsById.get(id)).filter((row): row is ManagedLocalServiceRow => Boolean(row));
}
