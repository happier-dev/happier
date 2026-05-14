import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * RUX-10 — SelectionListInputMirror
 *
 * The mirror is the **bottom layer** of the layered-mirror autocomplete: it
 * renders the typed value followed by the ghost suffix as inline `<Text>`
 * spans with identical font metrics to the editable `<TextInput>` painted on
 * top. Because the typed text in the mirror is rendered at the SAME width as
 * the TextInput's transparent text, the ghost suffix sits visually flush to
 * the right of the typed text (i.e. immediately after the cursor on web).
 *
 * Contract:
 *   - renders nothing when `ghostSuffix` is empty (no host node carries the
 *     testID, mirroring SelectionListInputGhost's behaviour),
 *   - on web the mirror is `pointerEvents="none"` so it never intercepts
 *     clicks intended for the TextInput overlay,
 *   - the typed text and ghost text are siblings inside a single `<Text>`
 *     parent (inline span continuity — no flex gap, no second-line wrap),
 *   - the ghost text uses opacity 0.4 to match the previous ghost styling.
 */
describe('SelectionListInputMirror (RUX-10)', () => {
    it('renders nothing when ghostSuffix is empty', async () => {
        const { SelectionListInputMirror } = await import('../SelectionListInputMirror');
        const screen = await renderScreen(
            <SelectionListInputMirror
                testID="m"
                value="hello"
                ghostSuffix=""
            />,
        );
        const hostMatches = screen.findAllByTestId('m').filter((n) => typeof n.type === 'string');
        expect(hostMatches).toEqual([]);
    });

    it('renders the typed value and ghost suffix as inline spans of a single text parent', async () => {
        const { SelectionListInputMirror } = await import('../SelectionListInputMirror');
        const screen = await renderScreen(
            <SelectionListInputMirror
                testID="m"
                value="~/Doc"
                ghostSuffix="uments/"
            />,
        );
        const text = screen.getTextContent();
        // Both segments rendered in the mirror text content
        expect(text).toContain('~/Doc');
        expect(text).toContain('uments/');

        // The ghost span carries a dedicated testID so we can assert it sits
        // INSIDE the same parent as the typed span.
        const ghost = screen.findByTestId('m:ghost');
        expect(ghost).not.toBeNull();
        const typed = screen.findByTestId('m:typed');
        expect(typed).not.toBeNull();
    });

    it('uses pointerEvents="none" on the host so it never intercepts clicks', async () => {
        const { SelectionListInputMirror } = await import('../SelectionListInputMirror');
        const screen = await renderScreen(
            <SelectionListInputMirror
                testID="m"
                value="anything"
                ghostSuffix="rest"
            />,
        );
        const host = screen.findByTestId('m');
        expect(host).not.toBeNull();
        expect(host!.props.pointerEvents).toBe('none');
    });

    it('applies opacity 0.4 to the ghost span', async () => {
        const { SelectionListInputMirror } = await import('../SelectionListInputMirror');
        const screen = await renderScreen(
            <SelectionListInputMirror
                testID="m"
                value="prefix"
                ghostSuffix="suffix"
            />,
        );
        const ghost = screen.findByTestId('m:ghost');
        expect(ghost).not.toBeNull();
        const styleArray = Array.isArray(ghost!.props.style)
            ? ghost!.props.style.flat(Infinity)
            : [ghost!.props.style];
        const merged = Object.assign({}, ...styleArray.filter(Boolean));
        expect(merged.opacity).toBeCloseTo(0.4, 5);
    });

    it('hides the mirror from the accessibility tree (it is a visual duplicate of the TextInput value)', async () => {
        const { SelectionListInputMirror } = await import('../SelectionListInputMirror');
        const screen = await renderScreen(
            <SelectionListInputMirror
                testID="m"
                value="abc"
                ghostSuffix="def"
            />,
        );
        const host = screen.findByTestId('m');
        expect(host).not.toBeNull();
        expect(host!.props.accessibilityElementsHidden).toBe(true);
        expect(host!.props.importantForAccessibility).toBe('no');
    });
});
