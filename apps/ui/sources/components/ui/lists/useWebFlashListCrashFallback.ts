import * as React from 'react';
import { Platform } from 'react-native';

type WebErrorListenerWindow = Readonly<{
    addEventListener: (type: 'error', listener: (event: unknown) => void, options?: unknown) => void;
    removeEventListener: (type: 'error', listener: (event: unknown) => void, options?: unknown) => void;
}>;

type FlashListCrashSignature = Readonly<{ message: string; stack: string }>;

const isKnownFlashListWebLayoutCrash = (signature: FlashListCrashSignature): boolean => {
    const text = (signature.message ?? '').toLowerCase();
    if (!text) return false;
    // This error string is emitted by FlashList/RecyclerListView on web when virtualization requests
    // layout metadata for an index that has not been measured yet.
    return text.includes('not enough layouts') && text.includes('index out of bounds');
};

const isKnownFlashListWebCommitLayoutLoop = (signature: FlashListCrashSignature): boolean => {
    const message = (signature.message ?? '').toLowerCase();
    if (!message.includes('maximum update depth exceeded')) return false;

    const stack = (signature.stack ?? '').toLowerCase();
    if (!stack) return false;

    // FlashList web can trip a RecyclerListView layout-effect loop whose stack includes the internal
    // `Object.commitLayout` frame before React reports the nested update error.
    return stack.includes('object.commitlayout')
        && (stack.includes('commithooklayouteffects') || stack.includes('commitlayouteffectonfiber'));
};

const isKnownFlashListWebCrash = (signature: FlashListCrashSignature): boolean => {
    return isKnownFlashListWebLayoutCrash(signature) || isKnownFlashListWebCommitLayoutLoop(signature);
};

const defaultShouldFallback = (signature: FlashListCrashSignature): boolean => {
    return isKnownFlashListWebCrash(signature);
};

export function useWebFlashListCrashFallback(input: Readonly<{
    enabled: boolean;
    shouldFallback?: (signature: FlashListCrashSignature) => boolean;
    /**
     * Invoked synchronously inside the error handler BEFORE the fallback flip renders, so the
     * caller can capture the current viewport from the still-mounted crashed list (plan E1).
     */
    onBeforeFallback?: () => void;
}>): boolean {
    const [crashed, setCrashed] = React.useState(false);
    const shouldFallbackRef = React.useRef(input.shouldFallback ?? defaultShouldFallback);
    shouldFallbackRef.current = input.shouldFallback ?? defaultShouldFallback;
    const onBeforeFallbackRef = React.useRef(input.onBeforeFallback);
    onBeforeFallbackRef.current = input.onBeforeFallback;

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
            try {
                onBeforeFallbackRef.current?.();
            } catch {
                // A capture failure must never block the crash fallback itself.
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
