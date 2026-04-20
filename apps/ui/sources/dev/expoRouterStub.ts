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

export function usePathname(): string {
    return '/';
}

export function useLocalSearchParams<
    TParams extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>,
>(): TParams {
    // Test-only stub; route-param-heavy specs should use the canonical expo-router mock factory instead.
    return {} as unknown as TParams;
}

export function useGlobalSearchParams<
    TParams extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>,
>(): TParams {
    return useLocalSearchParams<TParams>();
}

export const router = useRouter();
