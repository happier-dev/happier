// Vitest/node stub for `react-native-gesture-handler`.
// The real package pulls in React Native internals (`react-native/Libraries/...`) which Vitest can't parse.

export const Gesture = {
    Pan: () => {
        const chain: any = {
            __config: {},
            __handlers: {},
        };
        chain.minDistance = (value: number) => {
            chain.__config.minDistance = value;
            return chain;
        };
        chain.withTestId = (value: string) => {
            chain.__config.testId = value;
            return chain;
        };
        chain.onBegin = (handler: (...args: any[]) => void) => {
            chain.__handlers.onBegin = handler;
            return chain;
        };
        chain.onUpdate = (handler: (...args: any[]) => void) => {
            chain.__handlers.onUpdate = handler;
            return chain;
        };
        chain.onEnd = (handler: (...args: any[]) => void) => {
            chain.__handlers.onEnd = handler;
            return chain;
        };
        chain.onFinalize = (handler: (...args: any[]) => void) => {
            chain.__handlers.onFinalize = handler;
            return chain;
        };
        return chain;
    },
    LongPress: () => {
        const chain: any = {};
        chain.minDuration = () => chain;
        chain.onStart = () => chain;
        chain.runOnJS = () => chain;
        return chain;
    },
};

export const GestureDetector = 'GestureDetector' as any;

// Many UI components use gesture-handler's ScrollView for better nested gesture interop.
export const ScrollView = 'GestureHandlerScrollView' as any;
