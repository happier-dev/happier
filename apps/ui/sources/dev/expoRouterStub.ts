// Vitest/node stub for `expo-router`.
// The real package imports React Native internals (`react-native/Libraries/...`) in its native entrypoints.

import * as React from 'react';

export const Link = 'Link' as any;

export function Stack(props: { children?: React.ReactNode }) {
    return React.createElement(React.Fragment, null, props.children ?? null);
}

Stack.Screen = 'StackScreen' as any;

export function useRouter() {
    return {
        push: () => {},
        back: () => {},
        replace: () => {},
        setParams: () => {},
    };
}

export function useSegments(): string[] {
    return [];
}

export function useLocalSearchParams(): Record<string, string | string[] | undefined> {
    return {};
}

export const router = useRouter();
