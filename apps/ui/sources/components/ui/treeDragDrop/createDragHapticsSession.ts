import { hapticsDragStart, hapticsError, hapticsLight, hapticsSelection } from '@/components/ui/theme/haptics';

export type DragHapticsOutcome = 'applied' | 'refused' | 'unchanged' | 'unknown';

export type DragHapticsSession = Readonly<{
    updateDestination: (destinationKey: string | null) => void;
    finish: (outcome: DragHapticsOutcome) => void;
    cancel: () => void;
}>;

/** One active drag's semantic feedback; geometry and commit decisions stay with its owner. */
export function createDragHapticsSession(initialDestinationKey: string | null = null): DragHapticsSession {
    let destinationKey = initialDestinationKey;
    let finished = false;
    hapticsDragStart();

    return {
        updateDestination(nextKey: string | null) {
            if (finished || nextKey === destinationKey) return;
            destinationKey = nextKey;
            if (nextKey !== null) hapticsSelection();
        },
        finish(outcome: DragHapticsOutcome) {
            if (finished) return;
            finished = true;
            if (outcome === 'applied') hapticsLight();
            if (outcome === 'refused') hapticsError();
        },
        cancel() {
            finished = true;
        },
    };
}
