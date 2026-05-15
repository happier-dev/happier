import React from 'react';

export type TestGestureKind = 'pan' | 'longPress' | 'simultaneous';
export type TestGestureCallback = (...args: any[]) => void;

export type TestGestureChain = {
    readonly __kind: TestGestureKind;
    readonly __config: Record<string, unknown>;
    readonly __handlers: Record<string, TestGestureCallback>;
    readonly __gestures?: TestGestureChain[];
    minDistance(value: number): TestGestureChain;
    activateAfterLongPress(value: number): TestGestureChain;
    minDuration(value: number): TestGestureChain;
    maxDistance(value: number): TestGestureChain;
    shouldCancelWhenOutside(value: boolean): TestGestureChain;
    cancelsTouchesInView(value: boolean): TestGestureChain;
    activeOffsetX(value: number | readonly [number, number]): TestGestureChain;
    activeOffsetY(value: number | readonly [number, number]): TestGestureChain;
    failOffsetX(value: number | readonly [number, number]): TestGestureChain;
    failOffsetY(value: number | readonly [number, number]): TestGestureChain;
    withTestId(value: string): TestGestureChain;
    onBegin(callback: TestGestureCallback): TestGestureChain;
    onStart(callback: TestGestureCallback): TestGestureChain;
    onUpdate(callback: TestGestureCallback): TestGestureChain;
    onEnd(callback: TestGestureCallback): TestGestureChain;
    onFinalize(callback: TestGestureCallback): TestGestureChain;
    onTouchesDown(callback: TestGestureCallback): TestGestureChain;
    onTouchesMove(callback: TestGestureCallback): TestGestureChain;
    onTouchesUp(callback: TestGestureCallback): TestGestureChain;
    onTouchesCancelled(callback: TestGestureCallback): TestGestureChain;
    runOnJS(): TestGestureChain;
};

function createGestureChain(kind: TestGestureKind, gestures?: TestGestureChain[]): TestGestureChain {
    const gesture = {
        __kind: kind,
        __config: {},
        __handlers: {},
        ...(gestures ? { __gestures: gestures } : null),
    } as TestGestureChain;

    const configure = (key: string, value: unknown) => {
        gesture.__config[key] = value;
        return gesture;
    };
    const handle = (key: string, callback: TestGestureCallback) => {
        gesture.__handlers[key] = callback;
        return gesture;
    };

    Object.assign(gesture, {
        minDistance: (value: number) => configure('minDistance', value),
        activateAfterLongPress: (value: number) => configure('activateAfterLongPress', value),
        minDuration: (value: number) => configure('minDuration', value),
        maxDistance: (value: number) => configure('maxDistance', value),
        shouldCancelWhenOutside: (value: boolean) => configure('shouldCancelWhenOutside', value),
        cancelsTouchesInView: (value: boolean) => configure('cancelsTouchesInView', value),
        activeOffsetX: (value: number | readonly [number, number]) => configure('activeOffsetX', value),
        activeOffsetY: (value: number | readonly [number, number]) => configure('activeOffsetY', value),
        failOffsetX: (value: number | readonly [number, number]) => configure('failOffsetX', value),
        failOffsetY: (value: number | readonly [number, number]) => configure('failOffsetY', value),
        withTestId: (value: string) => configure('testId', value),
        onBegin: (callback: TestGestureCallback) => handle('onBegin', callback),
        onStart: (callback: TestGestureCallback) => handle('onStart', callback),
        onUpdate: (callback: TestGestureCallback) => handle('onUpdate', callback),
        onEnd: (callback: TestGestureCallback) => handle('onEnd', callback),
        onFinalize: (callback: TestGestureCallback) => handle('onFinalize', callback),
        onTouchesDown: (callback: TestGestureCallback) => handle('onTouchesDown', callback),
        onTouchesMove: (callback: TestGestureCallback) => handle('onTouchesMove', callback),
        onTouchesUp: (callback: TestGestureCallback) => handle('onTouchesUp', callback),
        onTouchesCancelled: (callback: TestGestureCallback) => handle('onTouchesCancelled', callback),
        runOnJS: () => gesture,
    });

    return gesture;
}

export function findGestureByKind(gesture: TestGestureChain | undefined, kind: TestGestureKind): TestGestureChain | null {
    if (!gesture) return null;
    if (gesture.__kind === kind) return gesture;
    for (const child of gesture.__gestures ?? []) {
        const match = findGestureByKind(child, kind);
        if (match) return match;
    }
    return null;
}

export function createGestureHandlerMock() {
    return {
        Gesture: {
            Pan: () => createGestureChain('pan'),
            LongPress: () => createGestureChain('longPress'),
            Simultaneous: (...gestures: TestGestureChain[]) => createGestureChain('simultaneous', gestures),
        },
        GestureDetector: (props: { children?: React.ReactNode; gesture?: unknown }) =>
            React.createElement('GestureDetector', props, props.children),
        Swipeable: 'Swipeable',
        ScrollView: 'GestureHandlerScrollView',
    };
}
