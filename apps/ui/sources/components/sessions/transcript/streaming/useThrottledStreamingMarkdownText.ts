import * as React from 'react';

export function useThrottledStreamingMarkdownText(params: Readonly<{
    enabled: boolean;
    text: string;
    throttleMs: number;
}>): string {
    const enabled = params.enabled === true;
    const text = typeof params.text === 'string' ? params.text : '';
    const throttleMs =
        typeof params.throttleMs === 'number' && Number.isFinite(params.throttleMs) && params.throttleMs > 0
            ? Math.trunc(params.throttleMs)
            : 0;

    const [renderText, setRenderText] = React.useState(text);
    const latestTextRef = React.useRef(text);
    const lastFlushAtMsRef = React.useRef<number | null>(null);
    const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (flushTimerRef.current != null) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
        };
    }, []);

    React.useEffect(() => {
        latestTextRef.current = text;

        if (!enabled || throttleMs <= 0) {
            if (flushTimerRef.current != null) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            lastFlushAtMsRef.current = null;
            if (renderText !== text) {
                setRenderText(text);
            }
            return;
        }

        if (renderText === text) return;

        const now = Date.now();
        const lastFlushAtMs = lastFlushAtMsRef.current;
        const elapsedMs = lastFlushAtMs == null ? Number.POSITIVE_INFINITY : now - lastFlushAtMs;
        if (elapsedMs >= throttleMs) {
            if (flushTimerRef.current != null) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            lastFlushAtMsRef.current = now;
            setRenderText(text);
            return;
        }

        if (flushTimerRef.current != null) return;

        flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            lastFlushAtMsRef.current = Date.now();
            setRenderText(latestTextRef.current);
        }, throttleMs - elapsedMs);
    }, [enabled, renderText, text, throttleMs]);

    return renderText;
}
