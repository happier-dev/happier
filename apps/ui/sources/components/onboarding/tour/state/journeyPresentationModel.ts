import type { JourneyAct, JourneyBeat, JourneyBeatId, JourneySurface } from './journeyBeats';
import {
    JOURNEY_SKIP_TO_SETUP_TARGET,
    getJourneyBeatsForSurface,
    journeyBeatById,
    resolveNearestVisibleBeatId,
} from './journeyBeats';

export type JourneyActBoundary = Readonly<{
    startIndex: number;
    endIndex: number;
}>;

export type JourneyActBoundaries = Readonly<Record<JourneyAct, JourneyActBoundary | null>>;

export type JourneyPresentationModelInput = Readonly<{
    surface: JourneySurface;
    currentBeatId?: JourneyBeatId | null;
}>;

export type JourneyPresentationModel = Readonly<{
    surface: JourneySurface;
    visibleBeats: readonly JourneyBeat[];
    currentBeat: JourneyBeat;
    currentIndex: number;
    currentNumber: number;
    totalCount: number;
    previousBeatId: JourneyBeatId | null;
    nextBeatId: JourneyBeatId | null;
    showSkipToSetup: boolean;
    skipTargetBeatId: JourneyBeatId | null;
    actBoundaries: JourneyActBoundaries;
}>;

export type JourneyProgressAction = 'advance' | 'back' | 'skipToSetup';

export type JourneyProgressTransition =
    | Readonly<{ type: 'beat'; beatId: JourneyBeatId }>
    | Readonly<{ type: 'complete' }>
    | Readonly<{ type: 'none' }>;

function resolveCurrentBeat(
    visibleBeats: readonly JourneyBeat[],
    currentBeatId: JourneyBeatId | null | undefined,
): Readonly<{ currentBeat: JourneyBeat; currentIndex: number }> {
    // A beat the cut does not play resolves through the script-order owner, so a
    // cut change under a mid-journey user preserves their progress instead of
    // restarting the journey at its first beat.
    const resolvedBeatId = currentBeatId
        ? resolveNearestVisibleBeatId(visibleBeats, currentBeatId)
        : null;
    const requestedIndex = resolvedBeatId
        ? visibleBeats.findIndex((beat) => beat.id === resolvedBeatId)
        : -1;
    const currentIndex = requestedIndex >= 0 ? requestedIndex : 0;
    const currentBeat = visibleBeats[currentIndex];
    if (!currentBeat) {
        throw new Error('Journey must have at least one visible beat.');
    }
    return { currentBeat, currentIndex };
}

function buildActBoundaries(visibleBeats: readonly JourneyBeat[]): JourneyActBoundaries {
    return {
        dream: resolveActBoundary(visibleBeats, 'dream'),
        setup: resolveActBoundary(visibleBeats, 'setup'),
    };
}

function resolveActBoundary(
    visibleBeats: readonly JourneyBeat[],
    act: JourneyAct,
): JourneyActBoundary | null {
    const startIndex = visibleBeats.findIndex((beat) => beat.act === act);
    if (startIndex < 0) return null;
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < visibleBeats.length; index += 1) {
        if (visibleBeats[index]?.act !== act) break;
        endIndex = index;
    }
    return { startIndex, endIndex };
}

export function buildJourneyPresentationModel(
    input: JourneyPresentationModelInput,
): JourneyPresentationModel {
    const visibleBeats = getJourneyBeatsForSurface(input.surface);
    const { currentBeat, currentIndex } = resolveCurrentBeat(visibleBeats, input.currentBeatId);
    const nextBeat = visibleBeats[currentIndex + 1] ?? null;
    const previousBeat = visibleBeats[currentIndex - 1] ?? null;
    const skipTarget = journeyBeatById.get(JOURNEY_SKIP_TO_SETUP_TARGET);
    const canSkipToSetup = currentBeat.act === 'dream' && Boolean(skipTarget?.surfaces[input.surface]);

    return {
        surface: input.surface,
        visibleBeats,
        currentBeat,
        currentIndex,
        currentNumber: currentIndex + 1,
        totalCount: visibleBeats.length,
        previousBeatId: previousBeat?.id ?? null,
        nextBeatId: nextBeat?.id ?? null,
        showSkipToSetup: canSkipToSetup,
        skipTargetBeatId: canSkipToSetup ? JOURNEY_SKIP_TO_SETUP_TARGET : null,
        actBoundaries: buildActBoundaries(visibleBeats),
    };
}

export function resolveJourneyProgressTransition(
    input: JourneyPresentationModelInput & Readonly<{ action: JourneyProgressAction }>,
): JourneyProgressTransition {
    const model = buildJourneyPresentationModel(input);

    if (input.action === 'skipToSetup') {
        return model.skipTargetBeatId ? { type: 'beat', beatId: model.skipTargetBeatId } : { type: 'none' };
    }

    if (input.action === 'back') {
        return model.previousBeatId ? { type: 'beat', beatId: model.previousBeatId } : { type: 'none' };
    }

    if (model.nextBeatId) {
        return { type: 'beat', beatId: model.nextBeatId };
    }
    return { type: 'complete' };
}
