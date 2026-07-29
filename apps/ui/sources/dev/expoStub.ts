// Vitest/node stub for the `expo` package.
// The real `expo` entrypoint loads bundler-specific runtime modules that don't exist in Vitest.
//
// Some Expo modules (e.g. `expo-widgets`) import native-bridge helpers from `expo` directly.
// Provide the minimal surface area needed for unit tests to import those modules without
// running any native side effects.

export class NativeModule<TEvents = unknown> {
    addListener(_eventName: keyof TEvents | string, _listener: (...args: unknown[]) => void): { remove: () => void } {
        return { remove: () => undefined };
    }

    removeListeners(_count: number): void {}
}

export function requireOptionalNativeModule(_moduleName?: string): null {
    return null;
}

export function requireNativeModule<T>(_moduleName?: string): T {
    return {} as T;
}

export default {
    NativeModule,
    requireOptionalNativeModule,
    requireNativeModule,
};
