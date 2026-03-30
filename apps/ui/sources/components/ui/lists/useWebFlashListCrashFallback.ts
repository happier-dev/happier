import * as React from 'react';
import { Platform } from 'react-native';

type WebErrorListenerWindow = Readonly<{
    addEventListener: (type: 'error', listener: (event: unknown) => void, options?: unknown) => void;
    removeEventListener: (type: 'error', listener: (event: unknown) => void, options?: unknown) => void;
}>;

type FlashListCrashSignature = Readonly<{ message: string; stack: string }>;

const isKnownFlashListWebCrash = (signature: FlashListCrashSignature): boolean => {
    const text = (signature.message ?? '').toLowerCase();
    if (!text) return false;
    // This error string is emitted by FlashList/RecyclerListView on web when virtualization requests
    // layout metadata for an index that has not been measured yet.
    return text.includes('not enough layouts') && text.includes('index out of bounds');
};

const defaultShouldFallback = (signature: FlashListCrashSignature): boolean => {
    return isKnownFlashListWebCrash(signature);
};

export function useWebFlashListCrashFallback(input: Readonly<{
    enabled: boolean;
    shouldFallback?: (signature: FlashListCrashSignature) => boolean;
}>): boolean {
    const [crashed, setCrashed] = React.useState(false);
    const shouldFallbackRef = React.useRef(input.shouldFallback ?? defaultShouldFallback);
    shouldFallbackRef.current = input.shouldFallback ?? defaultShouldFallback;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!input.enabled) return;
        if (crashed) return;

        const win = ((globalThis as any)?.window ?? null) as WebErrorListenerWindow | null;
        if (!win) return;
        if (typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function') return;

        const onError = (event: any) => {
            const message = String(event?.error?.message ?? event?.message ?? '');
            const stack = String(event?.error?.stack ?? '');
            const signature: FlashListCrashSignature = { message, stack };
            if (!shouldFallbackRef.current(signature)) return;
            // Only suppress the global error when we're confident it's the known FlashList crash.
            if (!isKnownFlashListWebCrash(signature)) return;
            try {
                event?.preventDefault?.();
            } catch {
                // ignore
            }
            try {
                event?.stopImmediatePropagation?.();
            } catch {
                // ignore
            }
            setCrashed(true);
        };

        win.addEventListener('error', onError, true);
        return () => {
            try {
                win.removeEventListener('error', onError, true);
            } catch {
                // ignore
            }
        };
    }, [crashed, input.enabled]);

    return crashed;
}
