/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import { resolveWebTranscriptScrollMetrics } from './webTranscriptScrollMetrics';

function setBox(el: HTMLElement, box: Readonly<{ scrollHeight: number; clientHeight: number; overflowY?: string }>) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.clientHeight });
    if (box.overflowY) el.style.overflowY = box.overflowY;
}

// Shape observed live at session open: the transcript root does not scroll, the renderer's
// scroll node is its child and does not overflow yet, while an unrelated ancestor does.
function buildOpeningTranscript() {
    const page = document.createElement('div');
    const root = document.createElement('div');
    const rendererScrollNode = document.createElement('div');
    const content = document.createElement('div');
    for (let index = 0; index < 40; index += 1) content.appendChild(document.createElement('div'));
    rendererScrollNode.appendChild(content);
    root.appendChild(rendererScrollNode);
    page.appendChild(root);
    document.body.appendChild(page);
    setBox(page, { scrollHeight: 5000, clientHeight: 900, overflowY: 'auto' });
    setBox(root, { scrollHeight: 671, clientHeight: 671 });
    setBox(rendererScrollNode, { scrollHeight: 640, clientHeight: 671, overflowY: 'auto' });
    return { page, root, rendererScrollNode };
}

describe('resolveWebTranscriptScrollMetrics', () => {
    it('reads the renderer-owned scroll node before it overflows, without discovering another scroller', () => {
        const { root, rendererScrollNode } = buildOpeningTranscript();
        const getComputedStyle = vi.spyOn(window, 'getComputedStyle');

        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            scrollElement: rendererScrollNode,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => el.scrollHeight,
        });

        expect(metrics?.element).toBe(rendererScrollNode);
        expect(metrics?.scrollHeight).toBe(640);
        expect(metrics?.clientHeight).toBe(671);
        expect(getComputedStyle).not.toHaveBeenCalled();
        getComputedStyle.mockRestore();
    });

    it('keeps discovery for a root whose renderer has not published a scroll node yet', () => {
        const { root, rendererScrollNode } = buildOpeningTranscript();
        setBox(rendererScrollNode, { scrollHeight: 4000, clientHeight: 671 });

        const metrics = resolveWebTranscriptScrollMetrics({ root, scrollElement: null, win: window, minOverflowPx: 50 });

        expect(metrics?.element).toBe(rendererScrollNode);
    });
});
