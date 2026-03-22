import * as React from 'react';
import { Platform } from 'react-native';

export function useInitialScrollRestore(input: Readonly<{
    initialScrollTop: number | null | undefined;
    latestScrollTopRef: React.RefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
    maxAttempts?: number;
}>) {
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts) ? input.maxAttempts : 12;
    const hasScheduledRef = React.useRef(false);
    const cancelledRef = React.useRef(false);
    const scheduledHandleRef = React.useRef<number | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (hasScheduledRef.current) return;

        const initial = input.initialScrollTop;
        if (typeof initial !== 'number' || !Number.isFinite(initial) || initial <= 0) return;
        hasScheduledRef.current = true;
        cancelledRef.current = false;

        const schedule: (cb: FrameRequestCallback) => number =
            typeof (globalThis as any).requestAnimationFrame === 'function'
                ? (globalThis as any).requestAnimationFrame.bind(globalThis)
                : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);
        const cancelScheduled = () => {
            const handle = scheduledHandleRef.current;
            if (handle == null) return;
            if (typeof (globalThis as any).cancelAnimationFrame === 'function') {
                (globalThis as any).cancelAnimationFrame(handle);
            } else {
                globalThis.clearTimeout(handle);
            }
            scheduledHandleRef.current = null;
        };

        const attemptApply = (attempt: number) => {
            if (cancelledRef.current) return;
            if (attempt >= maxAttempts) return;

            // If the user has already scrolled, don't fight them by restoring an old scroll offset.
            if ((input.latestScrollTopRef.current ?? 0) > 0) {
                cancelledRef.current = true;
                return;
            }

            const ok = input.applyInitialScrollTop(initial);
            if (ok) return;
            cancelScheduled();
            scheduledHandleRef.current = schedule(() => {
                scheduledHandleRef.current = null;
                attemptApply(attempt + 1);
            });
        };

        cancelScheduled();
        scheduledHandleRef.current = schedule(() => {
            scheduledHandleRef.current = null;
            attemptApply(0);
        });
        return () => {
            cancelledRef.current = true;
            cancelScheduled();
        };
    }, [input.applyInitialScrollTop, input.initialScrollTop, input.latestScrollTopRef, maxAttempts]);
}
