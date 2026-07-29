// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerWebTranscriptKeyboardOwner } from './webTranscriptKeyboardOwner';

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
});
