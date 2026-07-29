import * as React from 'react';

import { createStreamingTextPacer, type StreamingTextPacer } from './streamingTextPacer';

type StreamingTextSmoothingResult = Readonly<{
    displayText: string;
    isStreaming: boolean;
}>;

const FRAME_FALLBACK_MS = 16;
// Animation frames can stall entirely while a window is occluded or throttled
// even though `document.visibilityState` stays 'visible'; the timer backstop
// guarantees the reveal keeps draining (and `isStreaming` can settle) without
// depending on frames being produced.
const FRAME_BACKSTOP_MS = 120;

/**
 * Paces streamed transcript text: bursty upstream deltas are revealed as a
 * steady character flow (see streamingTextPacer.ts for the algorithm), and
 * `isStreaming` stays true until the reveal has drained and the text has been
 * quiet for `settleDelayMs`, at which point callers swap to the static path.
 *
 * The text present when pacing first engages is seeded without animation, so
 * opening an already-streaming session never replays existing content.
 */
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

    const pacerRef = React.useRef<StreamingTextPacer | null>(null);
    const lastChangeAtMsRef = React.useRef<number | null>(null);
    const rafHandleRef = React.useRef<number | null>(null);
    const frameTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const framePendingRef = React.useRef(false);
    const wakeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const didChangeThisRender =
        enabled &&
        pacerRef.current != null &&
        pacerRef.current.getTargetText() !== targetText;

    const cancelFrame = React.useCallback(() => {
        framePendingRef.current = false;
        if (rafHandleRef.current != null) {
            if (typeof globalThis.cancelAnimationFrame === 'function') {
                globalThis.cancelAnimationFrame(rafHandleRef.current);
            }
            rafHandleRef.current = null;
        }
        if (frameTimerRef.current != null) {
            clearTimeout(frameTimerRef.current);
            frameTimerRef.current = null;
        }
        if (wakeTimerRef.current != null) {
            clearTimeout(wakeTimerRef.current);
            wakeTimerRef.current = null;
        }
    }, []);

    const clearSettleTimer = React.useCallback(() => {
        if (settleTimerRef.current != null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
    }, []);

    const runTickRef = React.useRef<() => void>(() => {});

    const scheduleFrame = React.useCallback(() => {
        if (framePendingRef.current || wakeTimerRef.current != null) return;
        framePendingRef.current = true;
        const fire = () => {
            if (!framePendingRef.current) return;
            framePendingRef.current = false;
            if (rafHandleRef.current != null) {
                if (typeof globalThis.cancelAnimationFrame === 'function') {
                    globalThis.cancelAnimationFrame(rafHandleRef.current);
                }
                rafHandleRef.current = null;
            }
            if (frameTimerRef.current != null) {
                clearTimeout(frameTimerRef.current);
                frameTimerRef.current = null;
            }
            runTickRef.current();
        };
        const requestAnimationFrameMaybe = globalThis.requestAnimationFrame;
        const hasRaf = typeof requestAnimationFrameMaybe === 'function';
        if (hasRaf) {
            rafHandleRef.current = requestAnimationFrameMaybe(() => {
                rafHandleRef.current = null;
                fire();
            });
        }
        frameTimerRef.current = setTimeout(() => {
            frameTimerRef.current = null;
            fire();
        }, hasRaf ? FRAME_BACKSTOP_MS : FRAME_FALLBACK_MS);
    }, []);

    const scheduleWake = React.useCallback((delayMs: number) => {
        if (wakeTimerRef.current != null) return;
        wakeTimerRef.current = setTimeout(() => {
            wakeTimerRef.current = null;
            runTickRef.current();
        }, Math.max(1, Math.ceil(delayMs)));
    }, []);

    const armSettleTimer = React.useCallback(() => {
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            const now = Date.now();
            const ageMs = now - (lastChangeAtMsRef.current ?? now);
            if (ageMs < settleDelayMs) return;
            const pacer = pacerRef.current;
            if (pacer != null && !pacer.isDrained()) {
                // Backlog remains: keep the drain loop alive so streaming can
                // still settle even if a scheduled frame was lost.
                scheduleFrame();
                return;
            }
            setStreamingState(false);
        }, settleDelayMs);
    }, [clearSettleTimer, scheduleFrame, settleDelayMs]);

    const runTick = React.useCallback(() => {
        const pacer = pacerRef.current;
        if (pacer == null) return;
        const result = pacer.tick(Date.now());
        if (result.changed) {
            setDisplayText(pacer.getDisplayText());
        }
        if (result.drained) {
            armSettleTimer();
            return;
        }
        if (result.wakeDelayMs != null) {
            scheduleWake(result.wakeDelayMs);
            return;
        }
        scheduleFrame();
    }, [armSettleTimer, scheduleFrame, scheduleWake]);
    React.useLayoutEffect(() => {
        runTickRef.current = runTick;
    }, [runTick]);

    React.useEffect(() => {
        if (!enabled) {
            cancelFrame();
            clearSettleTimer();
            pacerRef.current = null;
            lastChangeAtMsRef.current = null;
            if (displayText !== targetText) {
                setDisplayText(targetText);
            }
            if (streamingState) {
                setStreamingState(false);
            }
            return;
        }

        let pacer = pacerRef.current;
        if (pacer == null) {
            // First enabled render: seed the current text without animating it.
            pacer = createStreamingTextPacer({ initialText: targetText, nowMs: Date.now() });
            pacerRef.current = pacer;
            if (displayText !== targetText) {
                setDisplayText(targetText);
            }
            return;
        }

        if (pacer.getTargetText() !== targetText) {
            lastChangeAtMsRef.current = Date.now();
            pacer.setTarget(targetText, Date.now());
            if (!streamingState) {
                setStreamingState(true);
            }
            if (pacer.isDrained()) {
                // Non-append or oversized delta jumped straight to the target.
                setDisplayText(pacer.getDisplayText());
                armSettleTimer();
            } else {
                cancelFrame();
                scheduleFrame();
                armSettleTimer();
            }
        }
    }, [
        armSettleTimer,
        cancelFrame,
        clearSettleTimer,
        displayText,
        enabled,
        scheduleFrame,
        streamingState,
        targetText,
    ]);

    // Reveal pacing is a foreground nicety: when the page is hidden, show
    // everything immediately so background progress is never withheld.
    React.useEffect(() => {
        if (!enabled) return;
        const documentMaybe = (globalThis as { document?: Document }).document;
        if (documentMaybe == null || typeof documentMaybe.addEventListener !== 'function') return;
        const onVisibilityChange = () => {
            if (documentMaybe.visibilityState !== 'hidden') return;
            const pacer = pacerRef.current;
            if (pacer == null || pacer.isDrained()) return;
            cancelFrame();
            pacer.flush();
            setDisplayText(pacer.getDisplayText());
            armSettleTimer();
        };
        documentMaybe.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            documentMaybe.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [armSettleTimer, cancelFrame, enabled]);

    React.useEffect(() => {
        return () => {
            cancelFrame();
            clearSettleTimer();
        };
    }, [cancelFrame, clearSettleTimer]);

    return React.useMemo(
        () => ({
            displayText,
            isStreaming: enabled && (didChangeThisRender || streamingState),
        }),
        [didChangeThisRender, displayText, enabled, streamingState],
    );
}
