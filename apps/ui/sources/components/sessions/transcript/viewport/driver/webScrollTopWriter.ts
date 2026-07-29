import type { MutableRefObject } from 'react';

import { recordTranscriptViewportWrite } from './transcriptViewportWriteDiagnostics';

/** Minimal structural view of the web scroller element (satisfied by `HTMLElement`; plain objects in tests). */
export type WebScrollTopWriteTarget = { scrollTop: number; scrollHeight: number };

export type WebScrollTopWriteResult =
    | { ok: true; landedScrollTop: number; landedScrollHeight: number }
    | { ok: false };

/**
 * The single web programmatic-scroll write primitive (seed of the C3b `WebStandardDomAdapter` write side).
 *
 * Writes `targetScrollTop` to the scroller and records the LANDED `scrollTop`/`scrollHeight` into the
 * observation refs, so the resulting `onScroll` echo is recognized as the app's OWN write — not a user scroll —
 * by `resolveWebGenuineScrollMovement`. Centralizing the write+observe here makes the Q1-WEB-1 invariant
 * unbreakable: a programmatic write can never forget to update the observation refs (which is exactly how a pin
 * write got misread as a user scroll-up and released bottom-follow). The LANDED value is read back AFTER the
 * write (the browser may clamp/under-shoot), so the observation reflects reality, not the requested target.
 *
 * Retries the write once: browsers can transiently throw on a `scrollTop=` assignment during reflow. The retry
 * can only turn a prior failure into a success — it never weakens a successful write.
 */
export function writeWebScrollTopAndObserve(params: Readonly<{
    element: WebScrollTopWriteTarget;
    targetScrollTop: number;
    observedScrollTopRef: MutableRefObject<number | null>;
    observedScrollHeightRef: MutableRefObject<number | null>;
}>): WebScrollTopWriteResult {
    const preWriteScrollTop = Number.isFinite(params.element.scrollTop) ? params.element.scrollTop : null;
    if (
        !tryWriteScrollTop(params.element, params.targetScrollTop) &&
        !tryWriteScrollTop(params.element, params.targetScrollTop)
    ) {
        return { ok: false };
    }
    const landedScrollTop = params.element.scrollTop;
    const landedScrollHeight = params.element.scrollHeight;
    params.observedScrollTopRef.current = landedScrollTop;
    params.observedScrollHeightRef.current = landedScrollHeight;
    recordTranscriptViewportWrite({
        landedScrollHeight,
        landedScrollTop,
        preWriteScrollTop,
        targetScrollTop: params.targetScrollTop,
    });
    return { ok: true, landedScrollTop, landedScrollHeight };
}

function tryWriteScrollTop(element: { scrollTop: number }, value: number): boolean {
    try {
        element.scrollTop = value;
        return true;
    } catch {
        return false;
    }
}
