import { gestureTokens } from '../../motion/gestureTokens';

export type PdfTouchPoint = Readonly<{ x: number; y: number }>;
export type PdfTouchZoomHandlers = Readonly<{
    /** The fingers' distance relative to where the pinch began, about the midpoint it began at (container-relative px). */
    onPinch(factor: number, focal: PdfTouchPoint): void;
    /** A finger lifted: the last update stands. */
    onPinchEnd(factor: number, focal: PdfTouchPoint): void;
    onPinchCancel(): void;
    onDoubleTap(focal: PdfTouchPoint): void;
}>;

/**
 * The touch boundary of the PDF canvas engine, as `attachWheelZoom` is its wheel boundary: exactly two touches pinch,
 * one scrolls (never claimed), and two quick taps in the same place double-tap. Gestures arrive container-relative.
 */
export function attachPdfTouchZoom(target: HTMLElement, handlers: PdfTouchZoomHandlers): () => void {
    const listeners = new AbortController();
    const { slopPx, doubleTapMs } = gestureTokens;
    type Touch = Readonly<{ clientX: number; clientY: number }>;
    const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const relative = (x: number, y: number): PdfTouchPoint => {
        const rect = target.getBoundingClientRect();
        return { x: x - rect.left, y: y - rect.top };
    };
    let pinch: { startDistance: number; focal: PdfTouchPoint; factor: number } | null = null;
    // The finger left behind by a pinch is not a new gesture until every finger has lifted.
    let spent = false;
    let tap: { x: number; y: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; at: number } | null = null;

    const touchStart = (event: TouchEvent) => {
        if (event.touches.length === 2) {
            const [a, b] = [event.touches[0]!, event.touches[1]!];
            pinch = { startDistance: Math.max(1, distance(a, b)), focal: relative((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2), factor: 1 };
            spent = true; tap = null; lastTap = null;
        } else if (event.touches.length === 1) {
            // A lone finger down means every other finger is up: a fresh gesture, whatever the last one left behind.
            spent = false;
            tap = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY, moved: false };
        } else tap = null;
    };
    const touchMove = (event: TouchEvent) => {
        if (pinch) {
            if (event.touches.length !== 2) return;
            event.preventDefault();
            pinch.factor = distance(event.touches[0]!, event.touches[1]!) / pinch.startDistance;
            handlers.onPinch(pinch.factor, pinch.focal);
        } else if (tap && event.touches.length === 1 && Math.hypot(event.touches[0]!.clientX - tap.x, event.touches[0]!.clientY - tap.y) > slopPx) tap.moved = true;
    };
    const touchEnd = (event: TouchEvent) => {
        if (pinch) {
            const ended = pinch; pinch = null;
            handlers.onPinchEnd(ended.factor, ended.focal);
        }
        if (event.touches.length > 0) return;
        const finished = tap; tap = null;
        if (spent) { spent = false; return; }
        const point = event.changedTouches[0];
        if (!finished || finished.moved || !point || event.changedTouches.length !== 1) { lastTap = null; return; }
        const now = Date.now();
        if (lastTap && now - lastTap.at <= doubleTapMs && Math.hypot(point.clientX - lastTap.x, point.clientY - lastTap.y) <= slopPx) {
            lastTap = null;
            if (event.cancelable) event.preventDefault();
            handlers.onDoubleTap(relative(point.clientX, point.clientY));
        } else lastTap = { x: point.clientX, y: point.clientY, at: now };
    };
    const touchCancel = () => {
        if (pinch) { pinch = null; handlers.onPinchCancel(); }
        tap = null; lastTap = null; spent = false;
    };
    const options = { signal: listeners.signal, passive: false } as const;
    target.addEventListener('touchstart', touchStart, options);
    target.addEventListener('touchmove', touchMove, options);
    target.addEventListener('touchend', touchEnd, options);
    target.addEventListener('touchcancel', touchCancel, options);
    return () => listeners.abort();
}
