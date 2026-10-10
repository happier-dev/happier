// Vitest/node stub for the `expo` package.
// The real `expo` entrypoint loads bundler-specific runtime modules that don't exist in Vitest.
//
// Some Expo modules (e.g. `expo-widgets`) import native-bridge helpers from `expo` directly.
// Provide the minimal surface area needed for unit tests to import those modules without
// running any native side effects.

import * as React from 'react';
import { requireOptionalNativeModule } from './expoModulesCoreStub';
export { installOptionalNativeModuleForTests, requireOptionalNativeModule } from './expoModulesCoreStub';

/** Expo's native-view bridge is an OS boundary; keep the real SDK view wrappers. */
export function requireNativeView<Props extends object = Record<string, unknown>>(
    moduleName: string,
    viewName?: string,
): React.ComponentType<Props> {
    return (props) => React.createElement(viewName ?? moduleName, props);
}

export class NativeModule<TEvents = unknown> {
    addListener(_eventName: keyof TEvents | string, _listener: (...args: unknown[]) => void): { remove: () => void } {
        return { remove: () => undefined };
    }

    removeListeners(_count: number): void {}
}

class UnavailableNativeAesObject {
    constructor() {
        throw new Error('Native Expo AES is unavailable in Vitest; mock the native crypto boundary when exercising it.');
    }
}

type NativeWidgetTimelineEntry = { timestamp: number; props: Record<string, unknown> };

// Mirror the installed Expo Widgets native constructors. The SDK's JS Widget
// wrapper stays real; only the OS-held timeline is in memory.
class NativeWidget {
    private entries: NativeWidgetTimelineEntry[] = [];
    constructor(_name: string, _layout: string) {}
    reload(): void {}
    updateTimeline(entries: NativeWidgetTimelineEntry[]): void {
        this.entries = entries.map(entry => ({ ...entry }));
    }
    async getTimeline(): Promise<NativeWidgetTimelineEntry[]> {
        return this.entries.map(entry => ({ ...entry }));
    }
}

class NativeLiveActivityFactory {
    constructor(_name: string, _layout: string) {}
    getInstances(): never[] { return []; }
    start(): never {
        throw new Error('Native Live Activity creation requires a configured OS fixture');
    }
}

const widgetsModule = Object.assign(new NativeModule(), {
    Widget: NativeWidget,
    LiveActivityFactory: NativeLiveActivityFactory,
    reloadAllWidgets(): void {},
});

export function requireNativeModule<T>(moduleName?: string): T {
    const installed = requireOptionalNativeModule(moduleName);
    if (installed) return installed as T;
    // expo-crypto 55 extends these native classes at import time. Keep that import usable
    // without pretending the Node harness implements native AES operations.
    if (moduleName === 'ExpoCryptoAES') {
        return { EncryptionKey: UnavailableNativeAesObject, SealedData: UnavailableNativeAesObject } as T;
    }
    if (moduleName === 'ExpoWidgets') return widgetsModule as T;
    return {} as T;
}

export default {
    NativeModule,
    requireOptionalNativeModule,
    requireNativeModule,
    requireNativeView,
};
