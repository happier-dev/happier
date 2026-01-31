// Vitest/node stub for `react-native-gesture-handler`.
// The real package pulls in React Native internals (`react-native/Libraries/...`) which Vitest can't parse.

export const Gesture = {
    LongPress: () => {
        const chain: any = {};
        chain.minDuration = () => chain;
        chain.onStart = () => chain;
        chain.runOnJS = () => chain;
        return chain;
    },
};

export const GestureDetector = 'GestureDetector' as any;

