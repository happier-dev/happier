import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

type MediaChangeEvent = Readonly<{ matches?: boolean }>;

type MediaQueryListLike = Readonly<{
    matches?: boolean;
    addEventListener?: (event: 'change', listener: (event: MediaChangeEvent) => void) => void;
    addListener?: (listener: (event: MediaChangeEvent) => void) => void;
}>;

/**
 * High contrast is a host property, so it is read and watched once for the app (like `useReducedMotionPreference`)
 * instead of per consumer: a surface that mounts later renders with the current preference rather than starting
 * from `false` and re-rendering everything that reads the accessibility environment once its own read lands.
 */
let highContrast = false;
let watchStarted = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
    if (highContrast === next) return;
    highContrast = next;
    for (const listener of listeners) listener();
}

function startWebWatch(): boolean {
    const maybeWindow = (globalThis as { window?: { matchMedia?: (query: string) => MediaQueryListLike } }).window;
    if (typeof maybeWindow?.matchMedia !== 'function') return false;
    const query = maybeWindow.matchMedia('(prefers-contrast: more)');
    highContrast = Boolean(query.matches);
    const onChange = (event: MediaChangeEvent) => publish(Boolean(event?.matches));
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else query.addListener?.(onChange);
    return true;
}

function startNativeWatch(): void {
    const maybeApi = AccessibilityInfo as unknown as {
        isHighTextContrastEnabled?: () => Promise<boolean>;
        isDarkerSystemColorsEnabled?: () => Promise<boolean>;
        addEventListener?: (
            eventName: 'highTextContrastChanged' | 'darkerSystemColorsChanged',
            handler: (enabled: boolean) => void,
        ) => { remove?: () => void } | undefined;
    };
    const queryPreference = Platform.OS === 'ios'
        ? maybeApi.isDarkerSystemColorsEnabled
        : maybeApi.isHighTextContrastEnabled;
    if (typeof queryPreference === 'function') {
        // A host that cannot answer keeps the default, as before.
        void queryPreference.call(maybeApi).then((enabled) => publish(Boolean(enabled))).catch(() => {});
    }
    maybeApi.addEventListener?.(
        Platform.OS === 'ios' ? 'darkerSystemColorsChanged' : 'highTextContrastChanged',
        (enabled) => publish(Boolean(enabled)),
    );
}

function startWatch(): void {
    if (watchStarted) return;
    watchStarted = true;
    // The watch outlives every consumer on purpose: one listener for the app's lifetime.
    if (Platform.OS === 'web' && startWebWatch()) return;
    startNativeWatch();
}

function subscribe(listener: () => void): () => void {
    startWatch();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function readHighContrastPreference(): boolean {
    startWatch();
    return highContrast;
}

export function useHighContrastPreference(): boolean {
    return React.useSyncExternalStore(subscribe, readHighContrastPreference, () => false);
}
