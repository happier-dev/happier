// Vitest/node stub for `react-native-gesture-handler`.
// The real package pulls in React Native internals (`react-native/Libraries/...`) which Vitest can't parse.

type TestGestureCallback = (...args: unknown[]) => void;

class TestGestureChain {
    readonly __config: Record<string, unknown> = {};
    readonly __handlers: Record<string, TestGestureCallback> = {};

    minDistance(value: number): this {
        this.__config.minDistance = value;
        return this;
    }

    minDuration(value: number): this {
        this.__config.minDuration = value;
        return this;
    }

    withTestId(value: string): this {
        this.__config.testId = value;
        return this;
    }

    onBegin(callback: TestGestureCallback): this {
        this.__handlers.onBegin = callback;
        return this;
    }

    onStart(callback: TestGestureCallback): this {
        this.__handlers.onStart = callback;
        return this;
    }

    onUpdate(callback: TestGestureCallback): this {
        this.__handlers.onUpdate = callback;
        return this;
    }

    onEnd(callback: TestGestureCallback): this {
        this.__handlers.onEnd = callback;
        return this;
    }

    onFinalize(callback: TestGestureCallback): this {
        this.__handlers.onFinalize = callback;
        return this;
    }

    runOnJS(): this {
        return this;
    }
}

export const Gesture = {
    Pan: () => new TestGestureChain(),
    LongPress: () => new TestGestureChain(),
};

export const GestureDetector = 'GestureDetector';

// Many UI components use gesture-handler's ScrollView for better nested gesture interop.
export const ScrollView = 'GestureHandlerScrollView';
