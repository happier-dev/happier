import * as React from 'react';
import { Platform } from 'react-native';

import { deferOnWeb } from '@/utils/platform/deferOnWeb';

export function useInitialScrollRestore(input: Readonly<{
    initialScrollTop: number | null | undefined;
    latestScrollTopRef: React.RefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
    maxAttempts?: number;
}>) {
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts) ? input.maxAttempts : 12;
    const hasScheduledRef = React.useRef(false);
    const cancelledRef = React.useRef(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (hasScheduledRef.current) return;

        const initial = input.initialScrollTop;
        if (typeof initial !== 'number' || !Number.isFinite(initial) || initial <= 0) return;
        hasScheduledRef.current = true;
        cancelledRef.current = false;

        const raf: (cb: FrameRequestCallback) => number =
            typeof (globalThis as any).requestAnimationFrame === 'function'
                ? (globalThis as any).requestAnimationFrame.bind(globalThis)
                : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);

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
            raf(() => attemptApply(attempt + 1));
        };

        deferOnWeb(() => attemptApply(0));
        return () => {
            cancelledRef.current = true;
        };
    }, [input.applyInitialScrollTop, input.initialScrollTop, input.latestScrollTopRef, maxAttempts]);
}

