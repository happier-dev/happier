// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { attachActionBarMouseDragScroll } from './attachActionBarMouseDragScroll';

describe('attachActionBarMouseDragScroll', () => {
    it('drags horizontally by updating scrollLeft', () => {
        const node = document.createElement('div');
        node.scrollLeft = 0;

        const onScroll = vi.fn();
        const cleanup = attachActionBarMouseDragScroll({ node, onScroll });

        node.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, bubbles: true }));

        expect(node.scrollLeft).toBe(60);
        expect(onScroll).toHaveBeenCalled();

        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 40, bubbles: true }));
        cleanup();
    });

    it('suppresses click after a drag gesture', () => {
        const node = document.createElement('div');
        node.scrollLeft = 0;

        const cleanup = attachActionBarMouseDragScroll({ node, onScroll: () => {} });

        node.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 30, bubbles: true }));

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);

        // Next click is not suppressed (didDrag reset).
        const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(click2);
        expect(click2.defaultPrevented).toBe(false);

        cleanup();
    });

    it('does not suppress click after a non-drag click', () => {
        const node = document.createElement('div');
        node.scrollLeft = 0;

        const cleanup = attachActionBarMouseDragScroll({ node, onScroll: () => {} });

        node.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, bubbles: true }));
        // No movement above threshold.
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 100, bubbles: true }));

        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);

        cleanup();
    });
});
