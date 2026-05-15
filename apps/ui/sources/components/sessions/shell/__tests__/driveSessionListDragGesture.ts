import { act } from 'react-test-renderer';

import { findGestureByKind, type TestGestureChain } from '@/dev/testkit';

export type SessionListDragPointer = Readonly<{
    x: number;
    y: number;
}>;

export type DriveSessionListDragGestureParams = Readonly<{
    gesture: TestGestureChain | unknown;
    pointerSequence: readonly [SessionListDragPointer, ...SessionListDragPointer[]];
}>;

function panGestureFrom(gesture: TestGestureChain | unknown): TestGestureChain {
    const pan = findGestureByKind(gesture as TestGestureChain | undefined, 'pan');
    if (!pan) throw new Error('Expected a recorded pan gesture');
    return pan;
}

function panEventFor(point: SessionListDragPointer, start: SessionListDragPointer) {
    return {
        absoluteX: point.x,
        absoluteY: point.y,
        translationX: point.x - start.x,
        translationY: point.y - start.y,
    };
}

export async function driveSessionListDragGesture(params: DriveSessionListDragGestureParams): Promise<void> {
    const pan = panGestureFrom(params.gesture);
    const [start, ...rest] = params.pointerSequence;
    const final = params.pointerSequence[params.pointerSequence.length - 1];

    await act(async () => {
        pan.__handlers.onTouchesDown?.({
            changedTouches: [{ absoluteX: start.x, absoluteY: start.y }],
            allTouches: [{ absoluteX: start.x, absoluteY: start.y }],
        });
        pan.__handlers.onStart?.(panEventFor(start, start));
        for (const point of rest) {
            pan.__handlers.onUpdate?.(panEventFor(point, start));
        }
        pan.__handlers.onEnd?.(panEventFor(final, start));
        pan.__handlers.onFinalize?.(panEventFor(final, start));
    });
}
