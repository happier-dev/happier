import { AppState, Platform } from 'react-native';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { isWebMobileHost } from '@/utils/platform/webMobileHeuristics';
import { readHostWindowFocus, subscribeToHostWindowFocus } from './readHostWindowFocus';

export function isRuntimeActive(): boolean {
    try {
        const appState = String(AppState.currentState ?? '').trim();
        // Desktop webviews can report a native background state while their document is visible.
        if (!isDesktopHost() && appState && appState !== 'active' && appState !== 'unknown') {
            return false;
        }
    } catch {
        // ignore
    }

    try {
        if (Platform.OS !== 'web') {
            return true;
        }
    } catch {
        // ignore
    }

    try {
        const doc = (globalThis as unknown as { document?: Document }).document;
        if (doc && typeof doc.visibilityState === 'string' && doc.visibilityState === 'hidden') {
            return false;
        }
    } catch {
        // ignore
    }

    return true;
}

function readDocument(): (Document & {
    addEventListener?: Document['addEventListener'];
    removeEventListener?: Document['removeEventListener'];
}) | undefined {
    try {
        return (globalThis as unknown as { document?: Document }).document;
    } catch {
        return undefined;
    }
}

/**
 * Notifies when the runtime's active/inactive state may have changed: the app
 * moved between foreground and background, or (on web) the document was hidden
 * or shown.
 *
 * This is the single owner of "what counts as a lifecycle transition" that
 * `isRuntimeActive` reads. Every gated worker subscribes here instead of
 * attaching its own `AppState` / `visibilitychange` listeners, so a component
 * gate and a timer gate can never disagree about whether the user is present.
 * The listener is called on every transition signal, including ones that leave
 * the state unchanged; a caller that needs edge semantics compares
 * `isRuntimeActive()` itself.
 */
export function subscribeToRuntimeActiveChange(listener: () => void, options?: Readonly<{ includeWindowFocus?: boolean }>): () => void {
    const detach: Array<() => void> = [];

    const doc = readDocument();
    if (typeof doc?.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
        doc.addEventListener('visibilitychange', listener);
        detach.push(() => {
            doc.removeEventListener?.('visibilitychange', listener);
        });
    }

    const hostWindow = (globalThis as unknown as { window?: Window }).window;
    if (options?.includeWindowFocus === true && typeof hostWindow?.addEventListener === 'function') {
        hostWindow.addEventListener('focus', listener);
        hostWindow.addEventListener('blur', listener);
        detach.push(() => {
            hostWindow.removeEventListener('focus', listener);
            hostWindow.removeEventListener('blur', listener);
        });
    }
    if (options?.includeWindowFocus === true && isDesktopHost()) {
        // A desktop shell's native window focus can change without a document focus event.
        detach.push(subscribeToHostWindowFocus(listener));
    }

    try {
        const subscription = AppState.addEventListener?.('change', listener);
        if (subscription && typeof subscription.remove === 'function') {
            detach.push(() => subscription.remove());
        }
    } catch {
        // ignore
    }

    return () => {
        for (const stop of detach.splice(0)) {
            stop();
        }
    };
}

/** Unknown physical focus cannot suppress another device's alert. */
export function readComputerUiFocusState(): Readonly<{ computer: boolean; focused: boolean }> {
    const focus = readHostWindowFocus();
    const computer = Platform.OS === 'web' && focus !== undefined && (isDesktopHost() || !isWebMobileHost());
    return { computer, focused: computer && focus === true && readDocument()?.visibilityState === 'visible' };
}

export function startRuntimeActiveGatedInterval(callback: () => void, intervalMs: number): () => void {
    const delayMs = Math.max(1, Math.trunc(intervalMs));
    let stopped = false;
    let lastRunAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const scheduleNext = () => {
        clearTimer();
        if (stopped || !isRuntimeActive()) return;
        timer = setTimeout(runIfActive, Math.max(0, lastRunAt + delayMs - Date.now()));
    };
    const runIfActive = () => {
        clearTimer();
        if (stopped || !isRuntimeActive()) return;
        lastRunAt = Date.now();
        try {
            callback();
        } finally {
            scheduleNext();
        }
    };

    const onPotentiallyActive = () => {
        if (!stopped && isRuntimeActive() && Date.now() - lastRunAt >= delayMs) {
            runIfActive();
        } else {
            scheduleNext();
        }
    };

    // Consumes the single lifecycle-transition owner above rather than attaching
    // its own listeners, so the timer gate and any component gate agree.
    const stopListening = subscribeToRuntimeActiveChange(onPotentiallyActive);
    scheduleNext();

    return () => {
        if (stopped) return;
        stopped = true;
        clearTimer();
        stopListening();
    };
}
