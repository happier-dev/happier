import * as React from 'react';

import type { JourneyBeatId, JourneySurface } from './journeyBeats';
import {
    buildJourneyPresentationModel,
    resolveJourneyProgressTransition,
    type JourneyPresentationModel,
} from './journeyPresentationModel';

export type JourneyAttentionChoice = 'keep_current' | 'promote_attention_and_working';

export type JourneyCompletion = Readonly<{
    attentionChoice: JourneyAttentionChoice;
    completedBeatId: JourneyBeatId;
}>;

export type UseJourneyProgressInput = Readonly<{
    surface: JourneySurface;
    initialBeatId?: JourneyBeatId;
    initialAttentionChoice?: JourneyAttentionChoice;
    onComplete: (completion: JourneyCompletion) => void;
}>;

export type JourneyProgressController = JourneyPresentationModel & Readonly<{
    attentionChoice: JourneyAttentionChoice;
    setAttentionChoice: (choice: JourneyAttentionChoice) => void;
    advance: () => void;
    back: () => void;
    skipToSetup: () => void;
}>;

export function useJourneyProgress(input: UseJourneyProgressInput): JourneyProgressController {
    const [currentBeatId, setCurrentBeatId] = React.useState<JourneyBeatId | undefined>(input.initialBeatId);
    const [history, setHistory] = React.useState<JourneyBeatId[]>([]);
    const [attentionChoice, setAttentionChoice] = React.useState<JourneyAttentionChoice>(
        input.initialAttentionChoice ?? 'promote_attention_and_working',
    );

    const model = React.useMemo(
        () => buildJourneyPresentationModel({
            surface: input.surface,
            currentBeatId,
        }),
        [currentBeatId, input.surface],
    );

    React.useEffect(() => {
        if (model.currentBeat.id === currentBeatId) return;
        setCurrentBeatId(model.currentBeat.id);
        setHistory([]);
    }, [currentBeatId, model.currentBeat.id]);

    const moveToBeat = React.useCallback((beatId: JourneyBeatId) => {
        setHistory((previousHistory) => [...previousHistory, model.currentBeat.id]);
        setCurrentBeatId(beatId);
    }, [model.currentBeat.id]);

    const advance = React.useCallback(() => {
        const transition = resolveJourneyProgressTransition({
            surface: input.surface,
            currentBeatId: model.currentBeat.id,
            action: 'advance',
        });
        if (transition.type === 'beat') {
            moveToBeat(transition.beatId);
            return;
        }
        if (transition.type === 'complete') {
            input.onComplete({
                attentionChoice,
                completedBeatId: model.currentBeat.id,
            });
        }
    }, [attentionChoice, input, model.currentBeat.id, moveToBeat]);

    const back = React.useCallback(() => {
        if (history.length > 0) {
            const previousBeatId = history[history.length - 1];
            if (previousBeatId) {
                setCurrentBeatId(previousBeatId);
                setHistory(history.slice(0, -1));
                return;
            }
        }

        const transition = resolveJourneyProgressTransition({
            surface: input.surface,
            currentBeatId: model.currentBeat.id,
            action: 'back',
        });
        if (transition.type === 'beat') {
            setCurrentBeatId(transition.beatId);
        }
    }, [history, input.surface, model.currentBeat.id]);

    const skipToSetup = React.useCallback(() => {
        const transition = resolveJourneyProgressTransition({
            surface: input.surface,
            currentBeatId: model.currentBeat.id,
            action: 'skipToSetup',
        });
        if (transition.type === 'beat') {
            moveToBeat(transition.beatId);
        }
    }, [input.surface, model.currentBeat.id, moveToBeat]);

    return {
        ...model,
        attentionChoice,
        setAttentionChoice,
        advance,
        back,
        skipToSetup,
    };
}
