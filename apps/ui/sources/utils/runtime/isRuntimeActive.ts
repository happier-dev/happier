import { AppState, Platform } from 'react-native';
import { readHostWindowFocus } from './readHostWindowFocus';
import { isWebMobileHost } from '@/utils/platform/webMobileHeuristics';
import { isTauriDesktop } from '@/utils/platform/tauri';

export function isRuntimeActive(): boolean {
    if (isTauriDesktop()) {
        return true;
    }

    try {
        const appState = String(AppState.currentState ?? '').trim();
        if (appState && appState !== 'active') {
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
 * or shown. Focus publishers can opt into host window focus/blur signals.
 *
 * This is the single owner of "what counts as a lifecycle transition" that
 * `isRuntimeActive` reads. Every gated worker subscribes here instead of
 * attaching its own `AppState` / `visibilitychange` listeners, so a new poller
 * cannot silently ship without a lifecycle gate for want of somewhere to hang
 * one. The listener is called on every transition signal, including ones that
 * leave the state unchanged; a caller that needs edge semantics compares
 * `isRuntimeActive()` itself.
 */
export function subscribeToRuntimeActiveChange(
    listener: () => void,
    options?: Readonly<{ includeWindowFocus?: boolean }>,
): () => void {
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

/** Only an explicitly focused, visible computer window can mute another device's push. */
export function readComputerUiFocusState(): Readonly<{ computer: boolean; focused: boolean }> {
    const computer = Platform.OS === 'web' && (isTauriDesktop() || !isWebMobileHost());
    return {
        computer,
        focused: computer && readDocument()?.visibilityState === 'visible' && readHostWindowFocus() === true,
    };
}

/**
 * Whether the host surface is on screen and actually being painted.
 *
 * Deliberately a different question from `isRuntimeActive()`. That one answers *may background
 * WORK continue*, and returns `true` unconditionally on Tauri desktop so sync keeps running in a
 * hidden window. Motion has the opposite need: an animation in a window nobody can see is pure
 * cost, and `apps/ui/AGENTS.md` requires every animation loop to declare a stop condition. Same
 * lifecycle signals and the same subscription (`subscribeToRuntimeActiveChange`) — one extra
 * question, rather than a second set of listeners hung off `visibilitychange`.
 *
 * The document is authoritative wherever there is one, because it is the thing that does or does
 * not paint. Native has no document, so the app-state answer above is the signal there.
 */
export function isHostVisible(): boolean {
    try {
        const doc = readDocument();
        if (doc && typeof doc.visibilityState === 'string') {
            return doc.visibilityState !== 'hidden';
        }
    } catch {
        // ignore
    }
    return isRuntimeActive();
}

/**
 * Whether someone is looking at this host window right now: it is visible and holds focus.
 *
 * Document hosts (browser tabs and the desktop app) answer from their document. When focus cannot
 * be established the window counts as viewed, so callers keep their quiet default.
 */
export function isHostActivelyViewed(): boolean {
    if (readDocument()?.visibilityState === 'hidden') {
        return false;
    }
    return readHostWindowFocus() ?? true;
}

/**
 * Runs an interval only while the runtime is active. If regular ticks were
 * skipped while inactive, the callback runs once immediately when the runtime
 * returns to active and the interval is overdue.
 */
export function startRuntimeActiveGatedInterval(
    tick: () => void,
    intervalMs: number,
): () => void {
    const delayMs = Math.max(1, Math.trunc(intervalMs));
    let stopped = false;
    let lastRunAt = Date.now();

    const runNow = () => {
        if (stopped || !isRuntimeActive()) return;
        lastRunAt = Date.now();
        tick();
    };

    const runIfOverdue = () => {
        if (stopped || !isRuntimeActive()) return;
        const now = Date.now();
        if (now - lastRunAt < delayMs) return;
        lastRunAt = now;
        tick();
    };

    const interval = setInterval(runNow, delayMs);
    const detachLifecycle = subscribeToRuntimeActiveChange(runIfOverdue);

    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        detachLifecycle();
    };
}
