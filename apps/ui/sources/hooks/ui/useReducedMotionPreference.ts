import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import { fireAndForget } from '@/utils/system/fireAndForget';

const REDUCE_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

type MediaChangeEvent = Readonly<{ matches?: boolean }>;

type MediaQueryListLike = Readonly<{
    matches?: boolean;
    addEventListener?: (event: 'change', listener: (event: MediaChangeEvent) => void) => void;
    addListener?: (listener: (event: MediaChangeEvent) => void) => void;
}>;

type WindowLike = Readonly<{ matchMedia?: (query: string) => MediaQueryListLike }>;

/**
 * Reduce motion is a host property, so it is watched once for the app instead of
 * once per consumer: transcript rows, selection-list rows and status dots mount
 * by the hundred in virtualized lists, and a media-query listener per instance
 * would make scrolling pay repeatedly for a value that cannot differ between
 * them. The watch outlives every consumer on purpose — one listener for the
 * app's lifetime, like the primary-pointer watch in `rowActionRevealHost`.
 */
let reducedMotionPreferred = false;
let watchStarted = false;
const preferenceListeners = new Set<() => void>();

function publishReducedMotionPreference(next: boolean): void {
    if (reducedMotionPreferred === next) return;
    reducedMotionPreferred = next;
    for (const listener of preferenceListeners) {
        listener();
    }
}

function startWebWatch(): void {
    const maybeWindow = (globalThis as { window?: WindowLike }).window;
    if (typeof maybeWindow?.matchMedia !== 'function') return;
    let query: MediaQueryListLike;
    try {
        query = maybeWindow.matchMedia(REDUCE_MOTION_MEDIA_QUERY);
    } catch {
        // Hosts without reduced-motion media support keep the default.
        return;
    }
    reducedMotionPreferred = Boolean(query.matches);
    const onChange = (event: MediaChangeEvent): void => {
        publishReducedMotionPreference(Boolean(event?.matches));
    };
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange);
        return;
    }
    query.addListener?.(onChange);
}

function startNativeWatch(): void {
    fireAndForget(
        AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
            publishReducedMotionPreference(Boolean(enabled));
        }),
        { tag: 'useReducedMotionPreference.isReduceMotionEnabled' },
    );
    AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
        publishReducedMotionPreference(Boolean(enabled));
    });
}

function startReducedMotionWatch(): void {
    if (watchStarted) return;
    watchStarted = true;
    if (Platform.OS === 'web') {
        startWebWatch();
        return;
    }
    startNativeWatch();
}

/**
 * Non-reactive read for consumers that need the preference only at the moment
 * they act on it — starting a reveal, choosing a transition. They cost nothing
 * per instance and see the current value the next time they run.
 */
export function readReducedMotionPreference(): boolean {
    startReducedMotionWatch();
    return reducedMotionPreferred;
}

function subscribeToReducedMotionPreference(listener: () => void): () => void {
    startReducedMotionWatch();
    preferenceListeners.add(listener);
    return () => {
        preferenceListeners.delete(listener);
    };
}

/** Reactive read for consumers whose rendered output depends on the preference. */
export function useReducedMotionPreference(): boolean {
    return React.useSyncExternalStore(
        subscribeToReducedMotionPreference,
        readReducedMotionPreference,
        () => false,
    );
}
