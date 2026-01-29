// Vitest/node stub for `expo-router`.
// The real package imports React Native internals (`react-native/Libraries/...`) in its native entrypoints.

export const Link = 'Link' as any;

export const Stack = {
    Screen: 'StackScreen' as any,
} as const;

export function useRouter() {
    return {
        push: () => {},
        back: () => {},
        replace: () => {},
        setParams: () => {},
    };
}

export function useLocalSearchParams(): Record<string, string | string[] | undefined> {
    return {};
}

export const router = useRouter();

