import * as React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getAppLockSnapshot, lockAppLock } from './appLockRuntime';

const MINUTE_MS = 60_000;

/** Time away is per window: a hidden browser tab or minimised extra window locks only itself. */
function lockThisWindow(): void {
    lockAppLock({ allWindows: false });
}

/**
 * Re-locks the app after it has spent the chosen time in the background (Android background,
 * a minimised or hidden desktop window, a hidden browser tab).
 *
 * A timer handles platforms that keep timers running while hidden; the elapsed-time check on return
 * handles platforms that suspend them. "Immediately" locks as the app is hidden, so nothing is
 * visible when it comes back.
 */
export function createAppLockAutoLock(): Readonly<{
    onAppStateChange: (next: AppStateStatus) => void;
    dispose: () => void;
}> {
    let hiddenAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };

    const onAppStateChange = (next: AppStateStatus) => {
        const { status, record } = getAppLockSnapshot();
        const minutes = record?.autoLockMinutes ?? null;

        if (next === 'active') {
            clearTimer();
            if (hiddenAt !== null && status === 'unlocked' && minutes !== null && Date.now() - hiddenAt >= minutes * MINUTE_MS) {
                lockThisWindow();
            }
            hiddenAt = null;
            return;
        }
        // `inactive` is a transient state (system dialogs, app switcher on iOS); only `background` counts.
        if (next !== 'background' || status !== 'unlocked' || minutes === null || hiddenAt !== null) return;

        hiddenAt = Date.now();
        if (minutes === 0) {
            lockThisWindow();
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            lockThisWindow();
        }, minutes * MINUTE_MS);
    };

    return {
        onAppStateChange,
        dispose: clearTimer,
    };
}

/** Wires auto-lock to the app's foreground/background state while `enabled`. */
export function useAppLockAutoLock(enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled) return;
        const autoLock = createAppLockAutoLock();
        const subscription = AppState.addEventListener('change', autoLock.onAppStateChange);
        return () => {
            subscription.remove();
            autoLock.dispose();
        };
    }, [enabled]);
}
