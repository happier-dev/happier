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
    return {
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        rowIds,
        rowsById,
        diagnostics: snapshot.diagnostics,
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
    return state.rowIds
        .map((id) => state.rowsById.get(id))
        .filter((row): row is LocalServiceInventoryRow => Boolean(row));
}
