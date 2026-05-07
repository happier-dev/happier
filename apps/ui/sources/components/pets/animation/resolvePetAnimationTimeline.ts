import {
    PET_ANIMATION_ROWS_V1,
    PET_ATLAS_V1,
    type PetAnimationStateV1,
} from '@happier-dev/protocol';

import {
    PET_ACTION_LOOP_COUNT,
    PET_IDLE_DURATION_MULTIPLIER,
} from './petAnimationPlaybackConfig';

export type ResolvedPetAnimationFrame = Readonly<{
    state: PetAnimationStateV1;
    row: number;
    frame: number;
    cellWidth: number;
    cellHeight: number;
}>;

export type ResolvePetAnimationTimelineInput = Readonly<{
    state: PetAnimationStateV1;
    elapsedMs: number;
    reducedMotion: boolean;
}>;

function resolveAnimationRow(state: PetAnimationStateV1) {
    return PET_ANIMATION_ROWS_V1.find((row) => row.state === state) ?? PET_ANIMATION_ROWS_V1[0];
}

function normalizeElapsedMs(elapsedMs: number): number {
    return Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
}

function resolveFrameFromDurations(durationsMs: readonly number[], elapsedMs: number): number {
    let cursorMs = 0;
    for (let index = 0; index < durationsMs.length; index += 1) {
        cursorMs += durationsMs[index] ?? 0;
        if (elapsedMs < cursorMs) return index;
    }
    return Math.max(0, durationsMs.length - 1);
}

function resolveRowTotalDurationMs(durationsMs: readonly number[]): number {
    return durationsMs.reduce((sum, value) => sum + value, 0);
}

export function resolvePetAnimationStateDurationMs(state: PetAnimationStateV1): number {
    const row = resolveAnimationRow(state);
    const totalDurationMs = resolveRowTotalDurationMs(row.durationsMs);
    if (row.state === 'idle') return totalDurationMs * PET_IDLE_DURATION_MULTIPLIER;
    return totalDurationMs * PET_ACTION_LOOP_COUNT;
}

function withAtlasFrame(state: PetAnimationStateV1, row: number, frame: number): ResolvedPetAnimationFrame {
    return {
        state,
        row,
        frame,
        cellWidth: PET_ATLAS_V1.cellWidth,
        cellHeight: PET_ATLAS_V1.cellHeight,
    };
}

export function resolvePetAnimationTimeline(input: ResolvePetAnimationTimelineInput): ResolvedPetAnimationFrame {
    const elapsedMs = normalizeElapsedMs(input.elapsedMs);
    const requestedRow = resolveAnimationRow(input.state);
    if (input.reducedMotion) {
        return withAtlasFrame(requestedRow.state, requestedRow.row, 0);
    }

    if (requestedRow.state === 'idle') {
        const idleDurationsMs = requestedRow.durationsMs.map((durationMs) => durationMs * PET_IDLE_DURATION_MULTIPLIER);
        const totalDurationMs = resolveRowTotalDurationMs(idleDurationsMs);
        const loopElapsedMs = totalDurationMs > 0 ? elapsedMs % totalDurationMs : 0;
        return withAtlasFrame(
            requestedRow.state,
            requestedRow.row,
            resolveFrameFromDurations(idleDurationsMs, loopElapsedMs),
        );
    }

    const actionDurationMs = resolveRowTotalDurationMs(requestedRow.durationsMs);
    const actionWindowMs = actionDurationMs * PET_ACTION_LOOP_COUNT;
    if (actionDurationMs <= 0 || elapsedMs >= actionWindowMs) {
        const idle = resolveAnimationRow('idle');
        return withAtlasFrame(idle.state, idle.row, 0);
    }

    const loopElapsedMs = elapsedMs % actionDurationMs;
    return withAtlasFrame(
        requestedRow.state,
        requestedRow.row,
        resolveFrameFromDurations(requestedRow.durationsMs, loopElapsedMs),
    );
}
