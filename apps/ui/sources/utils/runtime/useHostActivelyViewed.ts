import * as React from 'react';
import { AppState } from 'react-native';

import {
    isDesktopMainWindowFocused,
    isDesktopMainWindowVisible,
} from '@/desktop/window/desktopMainWindowPresence';
import { isDesktopHost } from '@/utils/platform/desktopHost';

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
 * background probe run?" and answers `true` for every desktop host so polling
 * survives a webview that never reports visibility. Motion and disclosure
 * cannot use that answer: a 60 Hz loop behind a hidden window is pure cost, and
 * context described for a window nobody can see is disclosure nobody asked for.
 * The desktop branch therefore composes the canonical window-presence fact
 * instead of restating it.
 *
 * Visibility remains the ordinary gate, not focus. A visible unfocused window
 * still supplies current UI context — that is the hands-free posture, and the
 * web build already keeps both context and motion for a visible unfocused tab.
 * `useHostActivelyFocused` below exposes the narrower projection for the few
 * desktop loops (Voice energy) that must pause until attention returns; it
 * shares this owner rather than installing a second window watch.
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
let hostActivelyFocused = true;
let watchStarted = false;
const listeners = new Set<() => void>();

function readHostActivelyViewedNow(): boolean {
    return isDesktopHost() ? isDesktopMainWindowVisible() : isRuntimeActive();
}

function readHostActivelyFocusedNow(): boolean {
    return isDesktopHost() ? isDesktopMainWindowFocused() : isRuntimeActive();
}

function publishHostActivelyViewed(): void {
    const nextViewed = readHostActivelyViewedNow();
    const nextFocused = readHostActivelyFocusedNow();
    if (hostActivelyViewed === nextViewed && hostActivelyFocused === nextFocused) return;
    hostActivelyViewed = nextViewed;
    hostActivelyFocused = nextFocused;
    for (const listener of listeners) {
        listener();
    }
}

function startHostActivelyViewedWatch(): void {
    if (watchStarted) return;
    watchStarted = true;
    hostActivelyViewed = readHostActivelyViewedNow();
    hostActivelyFocused = readHostActivelyFocusedNow();

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

/**
 * Whether host motion may run right now.
 *
 * Desktop energy is narrower than ordinary visibility: a visible Happier window
 * behind the editor still supplies current UI context, but it does not need a
 * frame callback until focus returns. Native hosts have no separate desktop
 * focus fact, so their existing active-runtime fact remains the projection.
 * This shares the one host watch above; consumers must not install their own
 * window observers for the same decision.
 */
export function readHostActivelyFocused(): boolean {
    startHostActivelyViewedWatch();
    return hostActivelyFocused;
}

export function useHostActivelyFocused(): boolean {
    return React.useSyncExternalStore(subscribeToHostActivelyViewed, readHostActivelyFocused, () => true);
}
