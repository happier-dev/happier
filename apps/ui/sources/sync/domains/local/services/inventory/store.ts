export type LocalServiceInventoryRow = Readonly<{
    id: string;
    machineId: string;
    address: Readonly<{
        kind: 'loopback' | 'wildcard' | 'lan' | 'unknown';
        host: string;
        family: 'ipv4' | 'ipv6' | 'unknown';
    }>;
    endpoint?: Readonly<{
        scheme: 'http' | 'https' | 'unknown';
        host: string;
        port: number;
        probeState: 'ready' | 'unknown';
        probedAt: number;
        reasonCode?: string;
    }>;
    port: number;
    protocol: 'tcp';
    detectedAt: number;
    lastSeenAt: number;
    state: 'listening' | 'stale' | 'gone' | 'unknown';
    source: 'detected';
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

/** Scan observations stay in raw state; rows render only these material service facts. */
export type LocalServiceInventoryPresentationRow = Omit<LocalServiceInventoryRow, 'lastSeenAt' | 'endpoint'> & {
    endpoint?: Omit<NonNullable<LocalServiceInventoryRow['endpoint']>, 'probedAt'>;
};
const selectedRows = new WeakMap<LocalServiceInventoryState['rowsById'], readonly LocalServiceInventoryRow[]>();
const presentationRows = new WeakMap<LocalServiceInventoryState['rowsById'], readonly LocalServiceInventoryPresentationRow[]>();

function presentationRow(row: LocalServiceInventoryRow): LocalServiceInventoryPresentationRow {
    const { lastSeenAt: _lastSeenAt, endpoint, ...material } = row;
    if (!endpoint) return material;
    const { probedAt: _probedAt, ...materialEndpoint } = endpoint;
    return { ...material, endpoint: materialEndpoint };
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

/**
 * A refresh is in flight; the rows on screen are still the previous generation's.
 *
 * `generatedAt` is the daemon generation these rows came from, so starting a refresh must not
 * write one: no generation has been produced yet. It deliberately takes no clock. Stamping the
 * local clock here fabricated a generation change on every mount — `LocalServicesSurfaceHost`
 * re-read the launcher feed for a scan that never happened, and the inventory watch's
 * `sinceGeneratedAt` cursor became a client clock reading rather than the daemon's own.
 */
export function applyLocalServiceInventoryRefreshStarted(
    state: LocalServiceInventoryState,
    machineId: string,
): LocalServiceInventoryState {
    if (state.machineId !== null && state.machineId !== machineId) {
        return {
            machineId,
            generatedAt: null,
            refreshState: 'refreshing',
            rowIds: [],
            rowsById: new Map(),
            diagnostics: [],
        };
    }

    if (state.machineId === machineId && state.refreshState === 'refreshing') return state;
    return {
        ...state,
        machineId,
        refreshState: 'refreshing',
    };
}

/**
 * A refresh failed; keep the last good rows and the generation they actually came from.
 *
 * Same contract as `applyLocalServiceInventoryRefreshStarted`, and it takes no clock for the same
 * reason: a failed read produces no daemon generation. This previously went through a synthetic
 * "fail-closed snapshot" carrying `Date.now()`, which re-created the fabricated-generation defect on
 * the error path — a phantom rescan for `LocalServicesSurfaceHost` and a client clock in the watch's
 * `sinceGeneratedAt` cursor. `refreshState: 'error'` is the honest signal for the failure.
 */
export function applyLocalServiceInventoryRefreshFailed(
    state: LocalServiceInventoryState,
    machineId: string,
): LocalServiceInventoryState {
    if (state.machineId !== null && state.machineId !== machineId) {
        return {
            machineId,
            generatedAt: null,
            refreshState: 'error',
            rowIds: [],
            rowsById: new Map(),
            diagnostics: [],
        };
    }

    if (state.machineId === machineId && state.refreshState === 'error') return state;
    return {
        ...state,
        machineId,
        refreshState: 'error',
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
    const sameIds = state.rowIds.length === rowIds.length && rowIds.every((id, index) => id === state.rowIds[index]);
    const sameRows = sameIds && rowIds.every(id => rowsById.get(id) === state.rowsById.get(id));
    const nextMap = sameRows ? state.rowsById : rowsById;
    const diagnostics = JSON.stringify(state.diagnostics) === JSON.stringify(snapshot.diagnostics) ? state.diagnostics : snapshot.diagnostics;
    if (state.machineId === snapshot.machineId && state.generatedAt === snapshot.generatedAt
        && state.refreshState === snapshot.refreshState && sameRows && diagnostics === state.diagnostics) return state;
    if (!sameRows) {
        const previousPresentation = selectLocalServiceInventoryPresentationRows(state);
        const previousById = new Map(previousPresentation.map(row => [row.id, row]));
        const nextPresentation = snapshot.entries.map(row => {
            const material = presentationRow(row);
            const previous = previousById.get(row.id);
            return previous && JSON.stringify(previous) === JSON.stringify(material) ? previous : material;
        });
        presentationRows.set(nextMap, sameIds && nextPresentation.every((row, index) => row === previousPresentation[index])
            ? previousPresentation : nextPresentation);
    }
    return {
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        rowIds: sameIds ? state.rowIds : rowIds,
        rowsById: nextMap,
        diagnostics,
    };
}

/**
 * Dev-only invariant (L0-4): `rowsById` must be a real `Map` produced by
 * `createLocalServiceInventoryState` / `applyLocalServiceInventorySnapshot`. A rehydrated or
 * injected plain-object state would make `state.rowsById.get` throw mid-render and crash the
 * Local Services tab. We assert the contract instead of silently coercing, so the wrong
 * constructor is caught at its source rather than masked.
 */
function assertInventoryStateShape(state: LocalServiceInventoryState): void {
    if (typeof state.rowsById?.get === 'function') return;
    throw new TypeError(
        'LocalServiceInventoryState.rowsById must be a Map built by createLocalServiceInventoryState; '
        + `received ${Object.prototype.toString.call(state.rowsById)}`,
    );
}

export function selectLocalServiceInventoryRows(state: LocalServiceInventoryState): readonly LocalServiceInventoryRow[] {
    assertInventoryStateShape(state);
    const previous = selectedRows.get(state.rowsById);
    if (previous) return previous;
    const rows = state.rowIds
        .map((id) => state.rowsById.get(id))
        .filter((row): row is LocalServiceInventoryRow => Boolean(row));
    selectedRows.set(state.rowsById, rows);
    return rows;
}

export function selectLocalServiceInventoryPresentationRows(state: LocalServiceInventoryState): readonly LocalServiceInventoryPresentationRow[] {
    const previous = presentationRows.get(state.rowsById);
    if (previous) return previous;
    const rows = selectLocalServiceInventoryRows(state).map(presentationRow);
    presentationRows.set(state.rowsById, rows);
    return rows;
}
