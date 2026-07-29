import { AppState, Platform } from 'react-native';
import { isTauriDesktop } from '@/utils/platform/tauri';

export function isRuntimeActive(): boolean {
    if (isTauriDesktop()) {
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

    const subscriptions: Array<() => void> = [];
    try {
        const subscription = AppState.addEventListener?.('change', onPotentiallyActive);
        if (subscription && typeof subscription.remove === 'function') {
            subscriptions.push(() => subscription.remove());
        }
    } catch {
        // ignore
    }

    try {
        const doc = (globalThis as unknown as { document?: Document }).document;
        if (doc && typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
            doc.addEventListener('visibilitychange', onPotentiallyActive);
            subscriptions.push(() => doc.removeEventListener('visibilitychange', onPotentiallyActive));
        }
    } catch {
        // ignore
    }

    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe();
        }
    };
}
