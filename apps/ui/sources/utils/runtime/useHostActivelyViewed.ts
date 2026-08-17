import * as React from 'react';
import { AppState } from 'react-native';

import { isTauriMainWindowActivelyViewed } from '@/desktop/window/isTauriMainWindowActivelyViewed';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { isRuntimeActive } from './isRuntimeActive';

type DocumentLike = Readonly<{
    addEventListener?: (event: string, listener: () => void) => void;
}>;

type ViewLike = Readonly<{
    addEventListener?: (event: string, listener: () => void) => void;
}>;

/**
 * Whether the app is genuinely being looked at right now.
 *
 * This is a stricter question than `isRuntimeActive()`, which asks "may a
 * background probe run?" and answers `true` for every Tauri host so polling
 * survives a desktop webview that never reports visibility. Motion cannot use
 * that answer: a 60 Hz loop behind a hidden or unfocused window is pure cost the
 * user never sees. The desktop branch therefore composes the canonical
 * actively-viewed fact instead of restating it, and an unfocused-but-visible
 * window counts as not viewed.
 *
 * The host is watched once for the app's lifetime rather than once per consumer,
 * like `useReducedMotionPreference`: visibility cannot differ between consumers,
 * so paying per instance would be waste.
 *
 * **Named for the question, not for `isRuntimeActive`.** A `useRuntimeActive`
 * already exists — module-private in `useExternalSessionRuntime.ts` — and it
 * answers the *other* question: may this session keep polling? Two hooks with
 * one name would read as one fact with two implementations, so this one says
 * what it actually decides. A consumer choosing between them is choosing
 * between "is anyone looking?" and "may background work run?".
 */
let hostActivelyViewed = true;
let watchStarted = false;
const listeners = new Set<() => void>();

function readHostActivelyViewedNow(): boolean {
    return isTauriDesktop() ? isTauriMainWindowActivelyViewed() : isRuntimeActive();
}

function publishHostActivelyViewed(): void {
    const next = readHostActivelyViewedNow();
    if (hostActivelyViewed === next) return;
    hostActivelyViewed = next;
    for (const listener of listeners) {
        listener();
    }
}

function startHostActivelyViewedWatch(): void {
    if (watchStarted) return;
    watchStarted = true;
    hostActivelyViewed = readHostActivelyViewedNow();

    try {
        // react-native-web returns undefined when `AppState.isAvailable` is false.
        AppState.addEventListener?.('change', publishHostActivelyViewed);
    } catch {
        // Hosts without an app-state bridge keep the sampled value.
    }

    const doc = (globalThis as { document?: DocumentLike }).document;
    doc?.addEventListener?.('visibilitychange', publishHostActivelyViewed);

    const view = globalThis as ViewLike;
    view.addEventListener?.('focus', publishHostActivelyViewed);
    view.addEventListener?.('blur', publishHostActivelyViewed);
}

export function readHostActivelyViewed(): boolean {
    startHostActivelyViewedWatch();
    return hostActivelyViewed;
}

function subscribeToHostActivelyViewed(listener: () => void): () => void {
    startHostActivelyViewedWatch();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useHostActivelyViewed(): boolean {
    return React.useSyncExternalStore(subscribeToHostActivelyViewed, readHostActivelyViewed, () => true);
}
