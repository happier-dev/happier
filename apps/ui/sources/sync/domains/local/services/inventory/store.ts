export type LocalServiceInventoryRow = Readonly<{
    id: string;
    machineId: string;
    address: Readonly<{
        kind: 'loopback' | 'wildcard' | 'lan' | 'unknown';
        host: string;
        family: 'ipv4' | 'ipv6' | 'unknown';
    }>;
    port: number;
    protocol: 'tcp';
    detectedAt: number;
    lastSeenAt: number;
    state: 'listening' | 'stale' | 'gone' | 'unknown';
    source: 'detected' | 'managed' | 'registered' | 'system';
    labels: readonly unknown[];
    confidence: 'high' | 'medium' | 'low';
    processOwnershipConfidence: 'high' | 'medium' | 'low';
    workspaceAssociationConfidence: 'high' | 'medium' | 'low';
    diagnostics: readonly unknown[];
    provenance?: unknown;
    classification?: unknown;
    presentation?: unknown;
}>;

export type LocalServiceInventorySnapshot = Readonly<{
    v: 1;
    machineId: string;
    generatedAt: number;
    refreshState: 'idle' | 'refreshing' | 'error';
    entries: readonly LocalServiceInventoryRow[];
    diagnostics: readonly unknown[];
}>;

export type LocalServiceInventoryState = Readonly<{
    machineId: string | null;
    generatedAt: number | null;
    refreshState: 'idle' | 'refreshing' | 'error';
    rowIds: readonly string[];
    rowsById: ReadonlyMap<string, LocalServiceInventoryRow>;
    diagnostics: readonly unknown[];
}>;

function rowKey(row: LocalServiceInventoryRow): string {
    return JSON.stringify(row);
}

function areRowsEquivalent(a: LocalServiceInventoryRow | undefined, b: LocalServiceInventoryRow): boolean {
    return Boolean(a) && rowKey(a as LocalServiceInventoryRow) === rowKey(b);
}

export function createLocalServiceInventoryState(): LocalServiceInventoryState {
    return {
        machineId: null,
        generatedAt: null,
        refreshState: 'idle',
        rowIds: [],
        rowsById: new Map(),
        diagnostics: [],
    };
}

export function applyLocalServiceInventoryRefreshStarted(
    state: LocalServiceInventoryState,
    machineId: string,
    generatedAt: number,
): LocalServiceInventoryState {
    if (state.machineId !== null && state.machineId !== machineId) {
        return {
            machineId,
            generatedAt,
            refreshState: 'refreshing',
            rowIds: [],
            rowsById: new Map(),
            diagnostics: [],
        };
    }

    return {
        ...state,
        machineId,
        generatedAt,
        refreshState: 'refreshing',
    };
}

export function applyLocalServiceInventorySnapshot(
    state: LocalServiceInventoryState,
    snapshot: LocalServiceInventorySnapshot,
): LocalServiceInventoryState {
    const rowsById = new Map<string, LocalServiceInventoryRow>();
    const rowIds: string[] = [];
    for (const row of snapshot.entries) {
        rowIds.push(row.id);
        const previous = state.rowsById.get(row.id);
        rowsById.set(row.id, areRowsEquivalent(previous, row) ? previous as LocalServiceInventoryRow : row);
    }
    return {
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        rowIds,
        rowsById,
        diagnostics: snapshot.diagnostics,
    };
}

export function selectLocalServiceInventoryRows(state: LocalServiceInventoryState): readonly LocalServiceInventoryRow[] {
    return state.rowIds.map((id) => state.rowsById.get(id)).filter((row): row is LocalServiceInventoryRow => Boolean(row));
}
