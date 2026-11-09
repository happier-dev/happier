import * as React from 'react';
import { Platform } from 'react-native';

export function useInitialScrollRestore(input: Readonly<{
    initialScrollTop: number | null | undefined;
    latestScrollTopRef: React.RefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
    ready?: boolean;
}>) {
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const restoredRef = React.useRef(false);
    const cancelledRef = React.useRef(false);
    const scheduledCancelRef = React.useRef<(() => void) | null>(null);
    const trackedTopBeforeRestoreRef = React.useRef(input.latestScrollTopRef.current);
    const cancelScheduled = React.useCallback(() => {
        const cancel = scheduledCancelRef.current;
        scheduledCancelRef.current = null;
        cancel?.();
    }, []);
    const cancelRestore = React.useCallback(() => {
        cancelledRef.current = true;
        cancelScheduled();
    }, [cancelScheduled]);
    const requestRestore = React.useCallback(() => {
        const current = inputRef.current;
        if (Platform.OS !== 'web' || current.ready === false || cancelledRef.current || restoredRef.current) return;
        if (scheduledCancelRef.current !== null) return;
        const initial = current.initialScrollTop;
        if (typeof initial !== 'number' || !Number.isFinite(initial) || initial <= 0) return;

        const apply = () => {
            scheduledCancelRef.current = null;
            const latest = inputRef.current;
            if (cancelledRef.current || latest.ready === false) return;
            // A retained seed is not movement. A changed tracker means the reader took control.
            if (!Object.is(latest.latestScrollTopRef.current, trackedTopBeforeRestoreRef.current)) {
                cancelRestore();
                return;
            }
            restoredRef.current = latest.applyInitialScrollTop(initial);
            // A missing viewport waits for its next load/layout/content event, never another frame.
        };
        if (typeof globalThis.requestAnimationFrame === 'function' && typeof globalThis.cancelAnimationFrame === 'function') {
            const cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis);
            const handle = globalThis.requestAnimationFrame(apply);
            scheduledCancelRef.current = () => cancelFrame(handle);
        } else {
            const handle = globalThis.setTimeout(apply, 0);
            scheduledCancelRef.current = () => globalThis.clearTimeout(handle);
        }
    }, [cancelRestore]);

    React.useEffect(() => {
        if (input.ready === false) cancelScheduled();
        else requestRestore();
    }, [input.initialScrollTop, input.ready, input.applyInitialScrollTop, requestRestore, cancelScheduled]);
    // Effect replay retires queued work; only reader navigation/movement cancels the intent.
    React.useEffect(() => cancelScheduled, [cancelScheduled]);
    return { cancelRestore, requestRestore };
}
