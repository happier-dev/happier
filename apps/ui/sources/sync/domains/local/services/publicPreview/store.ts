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

/**
 * A refresh is in flight; keep the last good rows and the generation they came from.
 *
 * Takes no clock: a refresh starting produces no daemon generation, so `generatedAt` keeps naming the
 * snapshot the visible rows actually came from. `refreshState` carries the transition. (Mirrors the
 * inventory store, where stamping the client clock here fabricated a rescan for consumers and
 * corrupted a watch cursor.)
 */
export function applyLocalServicePublicPreviewRefreshStarted(
    state: LocalServicePublicPreviewState,
): LocalServicePublicPreviewState {
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
export function applyLocalServicePublicPreviewRefreshFailed(
    state: LocalServicePublicPreviewState,
): LocalServicePublicPreviewState {
    return {
        ...state,
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

export type LocalServicePublicExposureExpiry = Readonly<{
    /** Absolute wall-clock expiry, straight off the wire. */
    expiresAt: number;
    /** Milliseconds left, floored at 0. */
    remainingMs: number;
    /** True once the link can no longer be used, whatever the daemon-reported state still says. */
    expired: boolean;
}>;

/**
 * Client-side expiry derivation for a public exposure (G15).
 *
 * `expiresAt` has always been on the wire and nothing read it, so a link kept reading "Shareable
 * link active" after it died — the daemon's own `public_preview_expired` diagnostic could only
 * arrive on a refresh the pane no longer had. The daemon stays the authority on `state`; this is
 * the honest presentation of a deadline the client can already see, for the window between real
 * expiry and the next snapshot.
 */
export function selectLocalServicePublicExposureExpiry(
    exposure: LocalServicePublicExposureV1,
    nowMs: number,
): LocalServicePublicExposureExpiry {
    const remainingMs = Math.max(0, exposure.expiresAt - nowMs);
    return {
        expiresAt: exposure.expiresAt,
        remainingMs,
        expired: exposure.state === 'expired' || remainingMs === 0,
    };
}

/**
 * Whether an exposure is genuinely usable right now: the daemon calls it active AND its deadline
 * has not passed. Callers that used to test `state === 'active'` alone were the G15 defect.
 */
export function isLocalServicePublicExposureLive(
    exposure: LocalServicePublicExposureV1,
    nowMs: number,
): boolean {
    return exposure.state === 'active'
        && !selectLocalServicePublicExposureExpiry(exposure, nowMs).expired;
}
