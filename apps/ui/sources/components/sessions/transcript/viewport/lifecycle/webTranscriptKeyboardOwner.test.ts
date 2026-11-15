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

    it.each([
        ['input', () => document.createElement('input')],
        ['textarea', () => document.createElement('textarea')],
        ['select', () => document.createElement('select')],
        ['contenteditable', () => {
            const element = document.createElement('div');
            element.setAttribute('contenteditable', 'true');
            return element;
        }],
        ['textbox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'textbox');
            return element;
        }],
        ['dialog', () => document.createElement('dialog')],
        ['menu', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'menu');
            return element;
        }],
        ['listbox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'listbox');
            return element;
        }],
        ['combobox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'combobox');
            return element;
        }],
    ])('does not claim transcript keyboard scrolling from a %s', (_name, createExcludedElement) => {
        const scroller = document.createElement('div');
        const excludedElement = createExcludedElement();
        scroller.append(excludedElement);
        document.body.append(scroller);
        const onViewportKeyboardInput = vi.fn();
        const unregister = registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput,
            resolveScroller: () => scroller,
        });

        excludedElement.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(onViewportKeyboardInput).not.toHaveBeenCalled();

        excludedElement.setAttribute('tabindex', '0');
        excludedElement.focus();
        expect(document.activeElement).toBe(excludedElement);
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(onViewportKeyboardInput).not.toHaveBeenCalled();

        unregister();
    });

    it('resolves each registered scroller once per press, however deep the pressed element sits', () => {
        // Each retained Session tab registers a transcript; resolving a scroller searches the DOM with computed
        // styles, so a press must not repeat that search for every ancestor of its target.
        const scrollers = [0, 1, 2].map(() => document.createElement('div'));
        document.body.append(...scrollers);
        let target: HTMLElement = scrollers[1]!;
        for (let depth = 0; depth < 20; depth += 1) {
            const child = document.createElement('div');
            target.append(child);
            target = child;
        }
        const calls = [0, 0, 0];
        const inputs = scrollers.map(() => vi.fn());
        const unregisters = scrollers.map((scroller, index) => registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: inputs[index]!,
            resolveScroller: () => { calls[index]! += 1; return scroller; },
        }));

        target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        const perPress = [...calls];
        document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }));

        expect({ perPress, input: inputs.map((input) => input.mock.calls.length) })
            .toEqual({ perPress: [1, 1, 1], input: [0, 1, 0] });
        for (const unregister of unregisters) unregister();
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
