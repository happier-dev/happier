import type {
    BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type {
    LocalServicePreviewDiagnosticV1} from '@happier-dev/protocol/local/services/preview/diagnostics/v1';
import type {
    LocalServicePreviewResourceV1,
} from '@happier-dev/protocol/local/services/preview/v1';
import type { LocalServicePreviewNativeDirectDescriptorV1 } from '@happier-dev/protocol/local/services/preview/v1';

import { readLocalServicePreviewDiagnostics } from './diagnostics';

export type LocalServicePreviewRow = Readonly<{
    previewId: string;
    resource: LocalServicePreviewResourceV1;
    accessUrl: string | null;
    expiresAt: number | null;
    accessUnavailableReasonCode?: 'preview_private_route_unavailable';
    nativeDirect?: LocalServicePreviewNativeDirectDescriptorV1;
    diagnostics: readonly LocalServicePreviewDiagnosticV1[];
}>;

export type LocalServicePreviewSnapshotRow = Omit<LocalServicePreviewRow, 'diagnostics'> & Readonly<{
    diagnostics: readonly unknown[];
}>;

export type LocalServicePreviewSnapshot = Readonly<{
    generatedAt: number;
    refreshState: 'idle' | 'refreshing' | 'error';
    previews: readonly LocalServicePreviewSnapshotRow[];
    diagnostics: readonly unknown[];
}>;

export type LocalServicePreviewState = Readonly<{
    generatedAt: number | null;
    refreshState: 'idle' | 'refreshing' | 'error';
    previewIds: readonly string[];
    previewsById: ReadonlyMap<string, LocalServicePreviewRow>;
    diagnostics: readonly LocalServicePreviewDiagnosticV1[];
}>;

function rowKey(row: LocalServicePreviewRow): string {
    return JSON.stringify(row);
}

function areRowsEquivalent(a: LocalServicePreviewRow | undefined, b: LocalServicePreviewRow): boolean {
    return Boolean(a) && rowKey(a as LocalServicePreviewRow) === rowKey(b);
}

export function createLocalServicePreviewState(): LocalServicePreviewState {
    return {
        generatedAt: null,
        refreshState: 'idle',
        previewIds: [],
        previewsById: new Map(),
        diagnostics: [],
    };
}

/**
 * A refresh is in flight; keep the last good rows and the generation they came from.
 *
 * Takes no clock: a refresh starting produces no daemon generation, so `generatedAt` keeps naming the
 * snapshot the visible rows actually came from. `refreshState` carries the transition. (Mirrors the
 * inventory store, where stamping the client clock here fabricated a rescan for consumers and
 * corrupted a watch cursor.)
 */
export function applyLocalServicePreviewRefreshStarted(
    state: LocalServicePreviewState,
): LocalServicePreviewState {
    return {
        ...state,
        refreshState: 'refreshing',
    };
}

/**
 * A refresh failed; keep the last good rows and the generation they came from.
 *
 * Takes no clock: a failed read produces no daemon generation, so `generatedAt` keeps naming the
 * snapshot the visible rows actually came from. `refreshState` carries the transition. (Mirrors the
 * inventory store, where stamping the client clock here fabricated a rescan for consumers and
 * corrupted a watch cursor.)
 */
export function applyLocalServicePreviewRefreshFailed(
    state: LocalServicePreviewState,
): LocalServicePreviewState {
    return {
        ...state,
        refreshState: 'error',
    };
}

export function applyLocalServicePreviewSnapshot(
    state: LocalServicePreviewState,
    snapshot: LocalServicePreviewSnapshot,
): LocalServicePreviewState {
    // Action publications and in-flight reads commit through the same reducer.
    if (state.generatedAt !== null && snapshot.generatedAt < state.generatedAt) return state;
    const previewsById = new Map<string, LocalServicePreviewRow>();
    const previewIds: string[] = [];
    for (const preview of snapshot.previews) {
        const normalizedPreview: LocalServicePreviewRow = {
            ...preview,
            diagnostics: readLocalServicePreviewDiagnostics(preview.diagnostics),
        };
        previewIds.push(preview.previewId);
        const previous = state.previewsById.get(preview.previewId);
        previewsById.set(
            preview.previewId,
            areRowsEquivalent(previous, normalizedPreview) ? previous as LocalServicePreviewRow : normalizedPreview,
        );
    }
    const sameIds = state.previewIds.length === previewIds.length
        && previewIds.every((id, index) => id === state.previewIds[index]);
    const sameRows = sameIds && previewIds.every(id => previewsById.get(id) === state.previewsById.get(id));
    const normalizedDiagnostics = readLocalServicePreviewDiagnostics(snapshot.diagnostics);
    const diagnostics = JSON.stringify(state.diagnostics) === JSON.stringify(normalizedDiagnostics)
        ? state.diagnostics : normalizedDiagnostics;
    if (state.generatedAt === snapshot.generatedAt && state.refreshState === snapshot.refreshState
        && sameRows && diagnostics === state.diagnostics) return state;
    return {
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        previewIds: sameIds ? state.previewIds : previewIds,
        previewsById: sameRows ? state.previewsById : previewsById,
        diagnostics,
    };
}

function matchesLocalServicePreviewTarget(
    row: LocalServicePreviewRow,
    target: BrowserViewTargetV1,
): boolean {
    if (target.kind !== 'localServicePreview') {
        return false;
    }

    const browserTarget = row.resource.browserTarget;
    if (browserTarget) {
        return browserTarget.targetId === target.targetId
            && browserTarget.sessionId === target.sessionId
            && browserTarget.machineId === target.machineId;
    }

    return row.previewId === target.targetId
        && row.resource.sessionId === target.sessionId
        && row.resource.machineId === target.machineId;
}

export function selectLocalServicePreviewRows(state: LocalServicePreviewState): readonly LocalServicePreviewRow[] {
    return state.previewIds
        .map((id) => state.previewsById.get(id))
        .filter((row): row is LocalServicePreviewRow => Boolean(row));
}

export function selectLocalServicePreviewByBrowserTarget(
    state: LocalServicePreviewState,
    target: BrowserViewTargetV1 | null | undefined,
): LocalServicePreviewRow | null {
    if (!target || target.kind !== 'localServicePreview') {
        return null;
    }

    for (const row of selectLocalServicePreviewRows(state)) {
        if (matchesLocalServicePreviewTarget(row, target)) {
            return row;
        }
    }
    return null;
}
