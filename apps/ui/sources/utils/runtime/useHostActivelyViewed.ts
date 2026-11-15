import * as React from 'react';
import { AppState } from 'react-native';

import {
    isDesktopMainWindowFocused,
    isDesktopMainWindowVisible,
} from '@/desktop/window/desktopMainWindowPresence';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { isRuntimeActive } from './isRuntimeActive';
import { subscribeToHostWindowFocus } from './readHostWindowFocus';

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
 * background probe run?" from document visibility and native AppState. The
 * desktop branch here additionally consumes the canonical window-presence fact
 * for motion and disclosure, rather than restating native window visibility.
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
    // A desktop shell's native window focus can change without a document focus event.
    if (isDesktopHost()) subscribeToHostWindowFocus(publishHostActivelyViewed);
}

export function readHostActivelyViewed(): boolean {
    startHostActivelyViewedWatch();
    return hostActivelyViewed;
}

export function subscribeToHostActivelyViewed(listener: () => void): () => void {
    startHostActivelyViewedWatch();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useHostActivelyViewed(): boolean {
    return React.useSyncExternalStore(subscribeToHostActivelyViewed, readHostActivelyViewed, () => true);
}

type HostGatedEffect = (hostFact: boolean) => void | (() => void);

/**
 * Re-runs `effect` (cleanup first) whenever the host fact changes, and whenever `deps` change, without
 * rendering the caller. A component whose host fact only starts or stops work (a timer, a poll, a clock,
 * a frame loop) uses this instead of reading the fact into render: hiding the app then costs no render
 * anywhere, and the work still stops in the same tick. A host transition runs the effect as of the
 * latest committed render, exactly what a render on that transition would have run.
 */
function useHostGatedEffect(
    useEffectHook: typeof React.useEffect,
    read: () => boolean,
    effect: HostGatedEffect,
    deps: React.DependencyList,
): void {
    const latest = React.useRef(effect);
    React.useLayoutEffect(() => {
        latest.current = effect;
    });
    useEffectHook(() => {
        let current = read();
        let cleanup = latest.current(current);
        const unsubscribe = subscribeToHostActivelyViewed(() => {
            const next = read();
            if (next === current) return;
            current = next;
            cleanup?.();
            cleanup = latest.current(next);
        });
        return () => {
            unsubscribe();
            cleanup?.();
        };
        // The caller's deps are the effect's deps; the host fact arrives through the subscription.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
}

/** `useEffect` that also re-runs on host visibility changes, receiving the current fact, without a render. */
export function useHostActivelyViewedEffect(effect: HostGatedEffect, deps: React.DependencyList): void {
    useHostGatedEffect(React.useEffect, readHostActivelyViewed, effect, deps);
}

/** The layout-phase form of {@link useHostActivelyViewedEffect}, for effects that must settle before paint. */
export function useHostActivelyViewedLayoutEffect(effect: HostGatedEffect, deps: React.DependencyList): void {
    useHostGatedEffect(React.useLayoutEffect, readHostActivelyViewed, effect, deps);
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

/** {@link useHostActivelyViewedEffect} for the focused projection. */
export function useHostActivelyFocusedEffect(effect: HostGatedEffect, deps: React.DependencyList): void {
    useHostGatedEffect(React.useEffect, readHostActivelyFocused, effect, deps);
}
