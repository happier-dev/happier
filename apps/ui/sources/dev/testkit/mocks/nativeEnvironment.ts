import * as React from 'react';

export type TestKeyboardState = Readonly<{
    isVisible: boolean;
    height: number;
}>;

export type TestSafeAreaInsets = Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}>;

export type TestNativeEnvironmentState = Readonly<{
    keyboard: TestKeyboardState;
    safeArea: TestSafeAreaInsets;
}>;

export function createKeyboardControllerMock(state: TestNativeEnvironmentState) {
    return {
        KeyboardAvoidingView: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        KeyboardProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        useKeyboardState: () => state.keyboard,
    };
}

export function createSafeAreaContextMock(state: TestNativeEnvironmentState) {
    return {
        SafeAreaProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        initialWindowMetrics: null,
        useSafeAreaInsets: () => state.safeArea,
    };
}
