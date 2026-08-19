import React from 'react';

export type TestGestureKind = 'pan' | 'tap' | 'longPress' | 'simultaneous' | 'exclusive' | 'race';
export type TestGestureCallback = (...args: any[]) => void;

export type TestGestureHitSlop = number | {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    width?: number;
    height?: number;
    vertical?: number;
    horizontal?: number;
};

export type TestGestureChain = {
    readonly __kind: TestGestureKind;
    readonly __config: Record<string, unknown>;
    readonly __handlers: Record<string, TestGestureCallback>;
    readonly __gestures?: TestGestureChain[];
    enabled(value: boolean): TestGestureChain;
    hitSlop(value: TestGestureHitSlop): TestGestureChain;
    minDistance(value: number): TestGestureChain;
    activateAfterLongPress(value: number): TestGestureChain;
    minDuration(value: number): TestGestureChain;
    maxDuration(value: number): TestGestureChain;
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
    onChange(callback: TestGestureCallback): TestGestureChain;
    onEnd(callback: TestGestureCallback): TestGestureChain;
    onFinalize(callback: TestGestureCallback): TestGestureChain;
    onTouchesDown(callback: TestGestureCallback): TestGestureChain;
    onTouchesMove(callback: TestGestureCallback): TestGestureChain;
    onTouchesUp(callback: TestGestureCallback): TestGestureChain;
    onTouchesCancelled(callback: TestGestureCallback): TestGestureChain;
    runOnJS(value?: boolean): TestGestureChain;
};

export type TestGestureFactories = {
    Pan(): TestGestureChain;
    Tap(): TestGestureChain;
    LongPress(): TestGestureChain;
    Simultaneous(...gestures: TestGestureChain[]): TestGestureChain;
    Exclusive(...gestures: TestGestureChain[]): TestGestureChain;
    Race(...gestures: TestGestureChain[]): TestGestureChain;
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
        enabled: (value: boolean) => configure('enabled', value),
        hitSlop: (value: TestGestureHitSlop) => configure('hitSlop', value),
        minDistance: (value: number) => configure('minDistance', value),
        activateAfterLongPress: (value: number) => configure('activateAfterLongPress', value),
        minDuration: (value: number) => configure('minDuration', value),
        maxDuration: (value: number) => configure('maxDuration', value),
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
        onChange: (callback: TestGestureCallback) => handle('onChange', callback),
        onEnd: (callback: TestGestureCallback) => handle('onEnd', callback),
        onFinalize: (callback: TestGestureCallback) => handle('onFinalize', callback),
        onTouchesDown: (callback: TestGestureCallback) => handle('onTouchesDown', callback),
        onTouchesMove: (callback: TestGestureCallback) => handle('onTouchesMove', callback),
        onTouchesUp: (callback: TestGestureCallback) => handle('onTouchesUp', callback),
        onTouchesCancelled: (callback: TestGestureCallback) => handle('onTouchesCancelled', callback),
        runOnJS: (value?: boolean) => (value === undefined ? gesture : configure('runOnJS', value)),
    });

    return gesture;
}

/**
 * Canonical chain factories shared by the testkit mock and the global
 * `react-native-gesture-handler` vitest alias (`@/dev/reactNativeGestureHandlerStub`),
 * so both surfaces accept exactly the same chain.
 */
export function createGestureFactories(
    onGestureCreated?: (gesture: TestGestureChain) => void,
): TestGestureFactories {
    const create = (kind: TestGestureKind, gestures?: TestGestureChain[]) => {
        const gesture = createGestureChain(kind, gestures);
        onGestureCreated?.(gesture);
        return gesture;
    };

    return {
        Pan: () => create('pan'),
        Tap: () => create('tap'),
        LongPress: () => create('longPress'),
        Simultaneous: (...gestures: TestGestureChain[]) => create('simultaneous', gestures),
        Exclusive: (...gestures: TestGestureChain[]) => create('exclusive', gestures),
        Race: (...gestures: TestGestureChain[]) => create('race', gestures),
    };
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

export type CreateGestureHandlerMockOptions = {
    /** Called for every gesture the suite's production code creates, in creation order. */
    readonly onGestureCreated?: (gesture: TestGestureChain) => void;
};

export function createGestureHandlerMock(options?: CreateGestureHandlerMockOptions) {
    return {
        Gesture: createGestureFactories(options?.onGestureCreated),
        GestureDetector: (props: { children?: React.ReactNode; gesture?: unknown }) =>
            React.createElement('GestureDetector', props, props.children),
        GestureHandlerRootView: (props: { children?: React.ReactNode }) =>
            React.createElement('GestureHandlerRootView', props, props.children),
        Swipeable: 'Swipeable',
        ScrollView: 'GestureHandlerScrollView',
    };
}
