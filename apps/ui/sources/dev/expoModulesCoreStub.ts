// Vitest runs in a Node environment; `expo-modules-core` is designed for Expo/Metro and
// imports `react-native` (Flow) via its TS source entrypoint. For unit tests we only need
// a minimal subset of the surface area used by other Expo packages (e.g. `expo-localization`).

export const Platform = {
    // Match the shape used by `expo-localization` on web/Node.
    isDOMAvailable: typeof window !== 'undefined' && typeof document !== 'undefined',
    OS: 'node',
    select: <T,>(specifics: Record<string, T> & { default?: T }) =>
        (specifics as any).node ?? (specifics as any).default,
} as const;

export enum PermissionStatus {
    GRANTED = 'granted',
    UNDETERMINED = 'undetermined',
    DENIED = 'denied',
}

export class NativeModule<TEvents = unknown> {
    addListener(_eventName: keyof TEvents | string, _listener: (...args: unknown[]) => void): { remove: () => void } {
        return {
            remove: () => undefined,
        };
    }

    removeListeners(_count: number): void {}
}

const optionalNativeModules = new Map<string, object>();

/** Replace one genuinely native SDK module, including Metro call-time lookup. */
export function installOptionalNativeModuleForTests(moduleName: string, module: object): () => void {
    const previous = optionalNativeModules.get(moduleName);
    optionalNativeModules.set(moduleName, module);
    return () => {
        if (optionalNativeModules.get(moduleName) !== module) return;
        if (previous) optionalNativeModules.set(moduleName, previous);
        else optionalNativeModules.delete(moduleName);
    };
}

// Native SDK lookup is opaque; the importing SDK supplies its external module type.
export function requireOptionalNativeModule<T extends object = Record<string, unknown>>(moduleName?: string): T | null {
    return (moduleName ? optionalNativeModules.get(moduleName) as T | undefined : undefined) ?? null;
}

export function requireNativeModule(moduleName: string): never {
    // Return a dummy module so packages can be imported in Vitest without exploding at import-time.
    // Tests that actually rely on native behavior should mock the specific module.
    return {} as never;
}

export default {
    NativeModule,
    Platform,
    requireOptionalNativeModule,
    requireNativeModule,
};
