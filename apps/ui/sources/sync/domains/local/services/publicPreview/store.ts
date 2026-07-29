import type {
    LocalServicePublicExposureV1,
    LocalServicePublicPolicyV1,
    LocalServicePublicPreviewSnapshotV1,
    LocalServicePreviewDiagnosticV1,
} from '@happier-dev/protocol';

import { readLocalServicePreviewDiagnostics } from '../preview/diagnostics';

export type LocalServicePublicPreviewState = Readonly<{
    machineId: string | null;
    sessionId: string | null;
    previewId: string | null;
    generatedAt: number | null;
    refreshState: 'idle' | 'refreshing' | 'error';
    policy: LocalServicePublicPolicyV1 | null;
    exposureIds: readonly string[];
    exposuresById: ReadonlyMap<string, LocalServicePublicExposureV1>;
    diagnostics: readonly LocalServicePreviewDiagnosticV1[];
}>;

function exposureKey(exposure: LocalServicePublicExposureV1): string {
    return JSON.stringify(exposure);
}

function areExposuresEquivalent(
    previous: LocalServicePublicExposureV1 | undefined,
    next: LocalServicePublicExposureV1,
): boolean {
    return Boolean(previous) && exposureKey(previous as LocalServicePublicExposureV1) === exposureKey(next);
}

export function createLocalServicePublicPreviewState(): LocalServicePublicPreviewState {
    return {
        machineId: null,
        sessionId: null,
        previewId: null,
        generatedAt: null,
        refreshState: 'idle',
        policy: null,
        exposureIds: [],
        exposuresById: new Map(),
        diagnostics: [],
    };
}

export function applyLocalServicePublicPreviewRefreshStarted(
    state: LocalServicePublicPreviewState,
    generatedAt: number,
): LocalServicePublicPreviewState {
    return {
        ...state,
        generatedAt,
        refreshState: 'refreshing',
    };
}

export function applyLocalServicePublicPreviewRefreshFailed(
    state: LocalServicePublicPreviewState,
    generatedAt: number,
): LocalServicePublicPreviewState {
    return {
        ...state,
        generatedAt,
        refreshState: 'error',
    };
}

export function applyLocalServicePublicPreviewSnapshot(
    state: LocalServicePublicPreviewState,
    snapshot: LocalServicePublicPreviewSnapshotV1,
): LocalServicePublicPreviewState {
    const exposuresById = new Map<string, LocalServicePublicExposureV1>();
    const exposureIds: string[] = [];
    for (const exposure of snapshot.exposures) {
        exposureIds.push(exposure.exposureId);
        const previous = state.exposuresById.get(exposure.exposureId);
        exposuresById.set(
            exposure.exposureId,
            areExposuresEquivalent(previous, exposure)
                ? previous as LocalServicePublicExposureV1
                : exposure,
        );
    }
    return {
        machineId: snapshot.machineId,
        sessionId: snapshot.sessionId ?? null,
        previewId: snapshot.previewId ?? null,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        policy: snapshot.policy,
        exposureIds,
        exposuresById,
        diagnostics: readLocalServicePreviewDiagnostics(snapshot.diagnostics),
    };
}

export function selectLocalServicePublicPreviewRows(
    state: LocalServicePublicPreviewState,
): readonly LocalServicePublicExposureV1[] {
    return state.exposureIds
        .map((id) => state.exposuresById.get(id))
        .filter((row): row is LocalServicePublicExposureV1 => Boolean(row));
}

export function selectLocalServicePublicPreviewRowsForPreview(
    state: LocalServicePublicPreviewState,
    previewId: string,
): readonly LocalServicePublicExposureV1[] {
    return selectLocalServicePublicPreviewRows(state).filter((row) => row.previewId === previewId);
}

export function selectLocalServicePublicPreviewExposure(
    state: LocalServicePublicPreviewState,
    exposureId: string,
): LocalServicePublicExposureV1 | null {
    return state.exposuresById.get(exposureId) ?? null;
}
