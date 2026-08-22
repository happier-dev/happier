import { AppState, Platform } from 'react-native';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export function isRuntimeActive(): boolean {
    if (isDesktopHost()) {
        return true;
    }

    try {
        const appState = String(AppState.currentState ?? '').trim();
        if (appState && appState !== 'active' && appState !== 'unknown') {
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
export function subscribeToRuntimeActiveChange(listener: () => void): () => void {
    const detach: Array<() => void> = [];

    const doc = readDocument();
    if (typeof doc?.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
        doc.addEventListener('visibilitychange', listener);
        detach.push(() => {
            doc.removeEventListener?.('visibilitychange', listener);
        });
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

export function startRuntimeActiveGatedInterval(callback: () => void, intervalMs: number): () => void {
    const delayMs = Math.max(1, Math.trunc(intervalMs));
    let stopped = false;
    let lastRunAt = Date.now();
    const runIfActive = () => {
        if (stopped || !isRuntimeActive()) return;
        lastRunAt = Date.now();
        callback();
    };

    const interval = setInterval(runIfActive, delayMs);
    const onPotentiallyActive = () => {
        if (stopped || !isRuntimeActive()) return;
        if (Date.now() - lastRunAt >= delayMs) {
            runIfActive();
        }
    };

    // Consumes the single lifecycle-transition owner above rather than attaching
    // its own listeners, so the timer gate and any component gate agree.
    const stopListening = subscribeToRuntimeActiveChange(onPotentiallyActive);

    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        stopListening();
    };
}
