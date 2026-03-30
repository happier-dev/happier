import { InteractionManager, Platform } from 'react-native';

function readRunAfterInteractionsFallbackDelayMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS ?? '').trim();
    if (!raw) return 2000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 2000;
    return Math.max(0, Math.min(30_000, parsed));
}

export function runAfterInteractionsWithFallback(fn: () => void): () => void {
    if (Platform.OS === 'web') {
        let cancelled = false;
        const handle = setTimeout(() => {
            if (cancelled) return;
            fn();
        }, 0);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }

    let didRun = false;
    const runOnce = () => {
        if (didRun) return;
        didRun = true;
        fn();
    };

    const fallbackDelayMs = readRunAfterInteractionsFallbackDelayMsFromEnv();
    const fallback = fallbackDelayMs > 0 ? setTimeout(runOnce, fallbackDelayMs) : null;
    try {
        const task = InteractionManager.runAfterInteractions(() => {
            if (fallback !== null) clearTimeout(fallback);
            runOnce();
        });
        return () => {
            didRun = true;
            if (fallback !== null) clearTimeout(fallback);
            task.cancel();
        };
    } catch {
        if (fallback !== null) clearTimeout(fallback);
        const immediate = setTimeout(runOnce, 0);
        return () => {
            didRun = true;
            clearTimeout(immediate);
        };
    }
}
