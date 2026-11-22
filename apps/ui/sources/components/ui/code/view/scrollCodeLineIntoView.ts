import { findVerticalScroller } from './readCodeViewReadingLine';

/** A third of the way down what the reader sees, and never inside a band covered at the top (an open Find bar). */
function readingMarginTop(scroller: HTMLElement, coveredBottom: number, coveredTop = 0): number {
    return Math.max(coveredTop, Math.round(Math.max(0, scroller.clientHeight - coveredBottom) / 3));
}

/**
 * Final landing for a mounted code row, shared by both diff renderers and line navigation.
 * `reading` (the default) puts the row a third of the way down what the reader sees (lab G1o), so the
 * lines after it are readable; `start` puts it at the top (a remembered reading position).
 */
export function scrollCodeLineIntoView(
    node: HTMLElement | null,
    block: 'reading' | 'start' = 'reading',
    coveredBottom = 0,
    coveredTop = 0,
): boolean {
    if (!node || typeof node.scrollIntoView !== 'function') return false;
    const previousMarginBottom = node.style?.scrollMarginBottom;
    const previousMarginTop = node.style?.scrollMarginTop;
    // Walk from the row itself: a Pierre row's parent is its shadow root, which the walk crosses to the host.
    const scroller = block === 'reading' && typeof HTMLElement !== 'undefined' && node instanceof HTMLElement ? findVerticalScroller(node) : null;
    try {
        // A sheet over the bottom of the page is not a place to land: the covered strip counts as the row's margin.
        if (coveredBottom > 0) node.style.scrollMarginBottom = `${coveredBottom}px`;
        if (scroller) {
            node.style.scrollMarginTop = `${readingMarginTop(scroller, coveredBottom, coveredTop)}px`;
            node.scrollIntoView({ block: 'start' });
        } else {
            if (coveredTop > 0) node.style.scrollMarginTop = `${coveredTop}px`;
            node.scrollIntoView({ block: block === 'start' ? 'start' : 'center' });
        }
        return true;
    } finally {
        if (coveredBottom > 0) node.style.scrollMarginBottom = previousMarginBottom ?? '';
        if (scroller || coveredTop > 0) node.style.scrollMarginTop = previousMarginTop ?? '';
    }
}

/**
 * Room at the end of `anchor`'s vertical scroller while a sheet covers `coveredBottom` of its bottom, so a row among
 * the last ones can still land above the sheet instead of staying under it at the scroller's end. Returns the release
 * that gives the room back. Web only; elsewhere, and outside a scroller, it reserves nothing.
 */
export function reserveScrollerBottomRoom(anchor: unknown, coveredBottom: number): () => void {
    if (coveredBottom <= 0 || typeof HTMLElement === 'undefined' || !(anchor instanceof HTMLElement)) return () => {};
    const scroller = findVerticalScroller(anchor);
    if (!scroller) return () => {};
    const previous = scroller.style.paddingBottom;
    scroller.style.paddingBottom = previous ? `calc(${previous} + ${coveredBottom}px)` : `${coveredBottom}px`;
    return () => {
        scroller.style.paddingBottom = previous;
    };
}

/** A mounted row can still be clamped by partially measured content. Real layout continues the
 * same landing until the reader takes over; Find keeps that position through later row resizing. */
export function retainCodeLineLanding(
    node: HTMLElement,
    block: 'reading' | 'start' = 'reading',
    coveredBottom = 0,
    coveredTop = 0,
): (() => void) & Readonly<{ refresh: () => void }> {
    const scroller = findVerticalScroller(node);
    if (!scroller) return Object.assign(() => {}, { refresh() {} });
    const top = () => node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const center = () => top() + node.getBoundingClientRect().height / 2;
    const reached = () => {
        const delta = top() - readingMarginTop(scroller, coveredBottom, coveredTop);
        return Math.abs(delta) < 1 || (delta < 0 && scroller.scrollTop === 0);
    };
    // Preserve Find's measured center once the requested reading position is attainable.
    let landedCenter = block === 'start' || reached() ? center() : null;
    let expectedScrollTop = scroller.scrollTop;
    let stopped = false;
    const interactions = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    const stop = () => {
        stopped = true;
        observer?.disconnect();
        scroller.removeEventListener('scroll', onScroll);
        for (const event of interactions) scroller.removeEventListener(event, stop);
    };
    const onScroll = () => {
        if (scroller.scrollTop !== expectedScrollTop) stop();
    };
    const refresh = () => {
        if (stopped) return;
        if (!node.isConnected || scroller.scrollTop !== expectedScrollTop) { stop(); return; }
        if (landedCenter !== null) {
            const delta = center() - landedCenter;
            // Scroll coordinates may be fractional. A subpixel difference needs no further landing.
            if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
        } else {
            if (!reached()) scrollCodeLineIntoView(node, block, coveredBottom, coveredTop);
            if (reached()) landedCenter = center();
        }
        expectedScrollTop = scroller.scrollTop;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    // Observe the containing content as well as the row: resizing an earlier row moves this
    // target without changing its own size. Cross Pierre's shadow root to its scroll owner.
    let ancestor: HTMLElement | null = node;
    while (ancestor) {
        observer?.observe(ancestor);
        if (ancestor === scroller) break;
        const root = ancestor.getRootNode();
        ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
    }
    scroller.addEventListener('scroll', onScroll);
    for (const event of interactions) scroller.addEventListener(event, stop, { passive: true });
    return Object.assign(stop, { refresh });
}
