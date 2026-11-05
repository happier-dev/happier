import * as React from 'react';

import type { PopoverRenderProps, PopoverWindowRect } from './_types';

/** Measure under the published placement bounds, then reveal before paint. */
export function useWebPopoverContentMeasure(params: Readonly<{
    enabled: boolean;
    getContentElement: () => HTMLElement | null;
    layout: Pick<PopoverRenderProps, 'maxHeight' | 'maxWidth' | 'placement'>;
    publish: React.Dispatch<React.SetStateAction<PopoverWindowRect | null>>;
}>): void {
    const { enabled, getContentElement, layout, publish } = params;
    React.useLayoutEffect(() => {
        if (!enabled) return;

        let isCancelled = false;
        let cancelScheduledMeasure: (() => void) | null = null;
        let resizeObserver: ResizeObserver | null = null;
        let observedContentEl: HTMLElement | null = null;

        const measure = () => {
            if (isCancelled) return false;
            const contentEl = getContentElement();
            if (!contentEl || typeof contentEl.getBoundingClientRect !== 'function') return false;
            if (observedContentEl !== contentEl) {
                resizeObserver?.disconnect();
                resizeObserver = null;
                observedContentEl = contentEl;
                try {
                    resizeObserver = new ResizeObserver(() => { measure(); });
                    resizeObserver.observe(contentEl);
                } catch {
                    // Layout retries also work in environments without ResizeObserver.
                }
            }
            const { width, height } = contentEl.getBoundingClientRect();
            if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
            publish(prev => (
                prev && Math.abs(prev.width - width) <= 1 && Math.abs(prev.height - height) <= 1
                    ? prev
                    : { x: 0, y: 0, width, height }
            ));
            return true;
        };

        // Retain the existing recovery for a portal whose DOM or size is not ready.
        const scheduleMeasure = (attempt: number) => {
            if (isCancelled) return;
            let didRun = false;
            let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
            let frameHandle: number | null = null;
            const runOnce = () => {
                if (didRun || isCancelled) return;
                didRun = true;
                if (fallbackTimer !== null) clearTimeout(fallbackTimer);
                fallbackTimer = null;
                if (frameHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(frameHandle);
                }
                frameHandle = null;
                cancelScheduledMeasure = null;
                if (!measure() && attempt < 5) scheduleMeasure(attempt + 1);
            };
            if (typeof globalThis.requestAnimationFrame === 'function') {
                frameHandle = globalThis.requestAnimationFrame(runOnce);
                fallbackTimer = setTimeout(runOnce, 50);
            } else {
                fallbackTimer = setTimeout(runOnce, 0);
            }
            cancelScheduledMeasure = () => {
                didRun = true;
                if (fallbackTimer !== null) clearTimeout(fallbackTimer);
                if (frameHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(frameHandle);
                }
            };
        };

        if (!measure()) scheduleMeasure(1);
        return () => {
            isCancelled = true;
            cancelScheduledMeasure?.();
            resizeObserver?.disconnect();
        };
    }, [enabled, getContentElement, layout.maxHeight, layout.maxWidth, layout.placement, publish]);
}
