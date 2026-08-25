// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    focusRegisteredWebTranscriptKeyboardViewport,
    registerWebTranscriptKeyboardOwner,
} from './webTranscriptKeyboardOwner';

describe('webTranscriptKeyboardOwner', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it.each([
        ['PageUp', false, 'toward-start'],
        ['ArrowUp', false, 'toward-start'],
        ['Home', false, 'toward-start'],
        [' ', true, 'toward-start'],
        ['PageDown', false, 'toward-end'],
        ['ArrowDown', false, 'toward-end'],
        ['End', false, 'toward-end'],
        [' ', false, 'toward-end'],
        ['Spacebar', false, 'toward-end'],
    ] as const)('classifies %s (shift=%s) as %s before browser movement', (
        key,
        shiftKey,
        expectedDirection,
    ) => {
        const scroller = document.createElement('div');
        document.body.append(scroller);
        const onViewportKeyboardInput = vi.fn();
        const unregister = registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput,
            resolveScroller: () => scroller,
        });

        scroller.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key,
            shiftKey,
        }));

        expect(onViewportKeyboardInput).toHaveBeenCalledWith(expectedDirection);
        unregister();
    });

    it('returns focus only to the exact mounted, registered transcript scroller', () => {
        const scroller = document.createElement('div');
        const unrelatedScroller = document.createElement('div');
        document.body.append(scroller, unrelatedScroller);
        const unregister = registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: vi.fn(),
            resolveScroller: () => scroller,
        });

        expect(focusRegisteredWebTranscriptKeyboardViewport({
            document,
            scroller: unrelatedScroller,
        })).toBe(false);
        expect(focusRegisteredWebTranscriptKeyboardViewport({ document, scroller })).toBe(true);
        expect(document.activeElement).toBe(scroller);
        expect(scroller.getAttribute('tabindex')).toBe('-1');

        unregister();
    });
});
