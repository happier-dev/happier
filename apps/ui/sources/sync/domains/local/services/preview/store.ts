import type {
    BrowserViewTargetV1,
    LocalServicePreviewDiagnosticV1,
    LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';

import { readLocalServicePreviewDiagnostics } from './diagnostics';

export type LocalServicePreviewRow = Readonly<{
    previewId: string;
    resource: LocalServicePreviewResourceV1;
    accessUrl: string | null;
    expiresAt: number | null;
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

export function applyLocalServicePreviewRefreshStarted(
    state: LocalServicePreviewState,
    generatedAt: number,
): LocalServicePreviewState {
    return {
        ...state,
        generatedAt,
        refreshState: 'refreshing',
    };
}

export function applyLocalServicePreviewRefreshFailed(
    state: LocalServicePreviewState,
    generatedAt: number,
): LocalServicePreviewState {
    return {
        ...state,
        generatedAt,
        refreshState: 'error',
    };
}

export function applyLocalServicePreviewSnapshot(
    state: LocalServicePreviewState,
    snapshot: LocalServicePreviewSnapshot,
): LocalServicePreviewState {
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
    return {
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        previewIds,
        previewsById,
        diagnostics: readLocalServicePreviewDiagnostics(snapshot.diagnostics),
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
