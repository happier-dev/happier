import * as React from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether a screen reader runs is a host property, so it is asked once for the app and watched once, like
 * `useReducedMotionPreference`. Every surface that mounts later (each page's plugin UI presentation scope) then
 * renders with the answer instead of starting from `false` and re-rendering everything that reads the
 * accessibility environment when the same answer resolves again (react-native-web answers `true` asynchronously).
 */
let screenReaderEnabled = false;
let watchStarted = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
    if (screenReaderEnabled === next) return;
    screenReaderEnabled = next;
    for (const listener of listeners) listener();
}

function startWatch(): void {
    if (watchStarted) return;
    watchStarted = true;
    const maybeApi = AccessibilityInfo as unknown as {
        isScreenReaderEnabled?: () => Promise<boolean>;
        addEventListener?: (
            eventName: 'screenReaderChanged',
            handler: (enabled: boolean) => void,
        ) => { remove?: () => void } | undefined;
    };
    if (typeof maybeApi.isScreenReaderEnabled === 'function') {
        // A host that cannot answer keeps the default, as before.
        void maybeApi.isScreenReaderEnabled().then((enabled) => publish(Boolean(enabled))).catch(() => {});
    }
    // The watch outlives every consumer on purpose: one listener for the app's lifetime.
    maybeApi.addEventListener?.('screenReaderChanged', (enabled) => publish(Boolean(enabled)));
}

function subscribe(listener: () => void): () => void {
    startWatch();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function readScreenReaderEnabled(): boolean {
    startWatch();
    return screenReaderEnabled;
}

export function useScreenReaderEnabled(): boolean {
    return React.useSyncExternalStore(subscribe, readScreenReaderEnabled, () => false);
}
