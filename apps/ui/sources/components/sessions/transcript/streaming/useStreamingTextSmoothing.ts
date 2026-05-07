import * as React from 'react';

type StreamingTextSmoothingResult = Readonly<{
    displayText: string;
    isStreaming: boolean;
}>;

export function useStreamingTextSmoothing(params: Readonly<{
    enabled: boolean;
    targetText: string;
    settleDelayMs: number;
}>): StreamingTextSmoothingResult {
    const enabled = params.enabled === true;
    const targetText = typeof params.targetText === 'string' ? params.targetText : '';
    const settleDelayMs =
        typeof params.settleDelayMs === 'number' && Number.isFinite(params.settleDelayMs) && params.settleDelayMs >= 0
            ? Math.trunc(params.settleDelayMs)
            : 0;

    const [displayText, setDisplayText] = React.useState(targetText);
    const [streamingState, setStreamingState] = React.useState(false);

    const lastObservedTargetTextRef = React.useRef(targetText);
    const pendingTargetTextRef = React.useRef(targetText);
    const lastChangeAtMsRef = React.useRef<number | null>(null);
    const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduledFlushRef = React.useRef(false);

    const didChangeThisRender = enabled && lastObservedTargetTextRef.current !== targetText;
    if (didChangeThisRender) {
        lastObservedTargetTextRef.current = targetText;
        pendingTargetTextRef.current = targetText;
        lastChangeAtMsRef.current = Date.now();
    } else if (!enabled) {
        lastObservedTargetTextRef.current = targetText;
        pendingTargetTextRef.current = targetText;
    }

    React.useEffect(() => {
        if (!enabled) {
            if (settleTimerRef.current != null) {
                clearTimeout(settleTimerRef.current);
                settleTimerRef.current = null;
            }
            if (displayText !== targetText) {
                setDisplayText(targetText);
            }
            if (streamingState) {
                setStreamingState(false);
            }
            return;
        }

        if (didChangeThisRender && !streamingState) {
            setStreamingState(true);
        }

        if (!scheduledFlushRef.current) {
            scheduledFlushRef.current = true;
            const requestAnimationFrameMaybe = globalThis.requestAnimationFrame;
            const schedule =
                typeof requestAnimationFrameMaybe === 'function'
                    ? (callback: () => void) => requestAnimationFrameMaybe(callback)
                    : (callback: () => void) => setTimeout(callback, 0);
            schedule(() => {
                scheduledFlushRef.current = false;
                setDisplayText(pendingTargetTextRef.current);
            });
        }

        if (settleTimerRef.current != null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }

        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            const now = Date.now();
            const ageMs = now - (lastChangeAtMsRef.current ?? now);
            if (ageMs < settleDelayMs) {
                return;
            }
            setDisplayText(pendingTargetTextRef.current);
            setStreamingState(false);
        }, settleDelayMs);

        return () => {
            if (settleTimerRef.current != null) {
                clearTimeout(settleTimerRef.current);
                settleTimerRef.current = null;
            }
        };
    }, [didChangeThisRender, displayText, enabled, settleDelayMs, streamingState, targetText]);

    return React.useMemo(
        () => ({
            displayText,
            isStreaming: enabled && (didChangeThisRender || streamingState),
        }),
        [didChangeThisRender, displayText, enabled, streamingState],
    );
}
