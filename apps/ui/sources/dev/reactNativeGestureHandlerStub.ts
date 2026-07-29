// Vitest/node stub for `react-native-gesture-handler`.
// The real package pulls in React Native internals (`react-native/Libraries/...`) which Vitest can't parse.

function createGestureChain(): any {
    const chain: any = {
        __config: {},
        __handlers: {},
    };
    chain.minDistance = (value: number) => {
        chain.__config.minDistance = value;
        return chain;
    };
    chain.maxDuration = (value: number) => {
        chain.__config.maxDuration = value;
        return chain;
    };
    chain.activateAfterLongPress = (value: number) => {
        chain.__config.activateAfterLongPress = value;
        return chain;
    };
    chain.minDuration = (value: number) => {
        chain.__config.minDuration = value;
        return chain;
    };
    chain.withTestId = (value: string) => {
        chain.__config.testId = value;
        return chain;
    };
    chain.runOnJS = (value: boolean) => {
        chain.__config.runOnJS = value;
        return chain;
    };
    chain.enabled = (value: boolean) => {
        chain.__config.enabled = value;
        return chain;
    };
    chain.shouldCancelWhenOutside = (value: boolean) => {
        chain.__config.shouldCancelWhenOutside = value;
        return chain;
    };
    chain.hitSlop = (value: unknown) => {
        chain.__config.hitSlop = value;
        return chain;
    };
    chain.failOffsetX = (value: unknown) => {
        chain.__config.failOffsetX = value;
        return chain;
    };
    chain.failOffsetY = (value: unknown) => {
        chain.__config.failOffsetY = value;
        return chain;
    };
    chain.activeOffsetX = (value: unknown) => {
        chain.__config.activeOffsetX = value;
        return chain;
    };
    chain.activeOffsetY = (value: unknown) => {
        chain.__config.activeOffsetY = value;
        return chain;
    };
    for (const handlerName of ['onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize', 'onTouchesDown', 'onTouchesUp'] as const) {
        chain[handlerName] = (handler: (...args: unknown[]) => void) => {
            chain.__handlers[handlerName] = handler;
            return chain;
        };
    }
    return chain;
}

export const Gesture = {
    Pan: () => createGestureChain(),
    Tap: () => createGestureChain(),
    LongPress: () => createGestureChain(),
    Exclusive: (...gestures: unknown[]) => ({ __kind: 'Exclusive', gestures }),
    Simultaneous: (...gestures: unknown[]) => ({ __kind: 'Simultaneous', gestures }),
    Race: (...gestures: unknown[]) => ({ __kind: 'Race', gestures }),
};

export const GestureDetector = 'GestureDetector' as any;

// Many UI components use gesture-handler's ScrollView for better nested gesture interop.
export const ScrollView = 'GestureHandlerScrollView' as any;
