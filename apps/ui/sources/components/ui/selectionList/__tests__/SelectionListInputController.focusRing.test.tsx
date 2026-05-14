import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R13 — Premium UI gaps round 2 (Fix 1): the input had `outline: 'none'` +
 * `boxShadow: 'none'` applied unconditionally on web, with no visible focus
 * affordance taking its place. Keyboard users could not see where focus was.
 *
 * Fix: when the input is focused, an outer wrap renders a visible ring
 * (boxShadow / outline) sourced from theme tokens. The contract verified here:
 *   - The input controller exposes a stable testID for the focus-ring wrap.
 *   - When focus is acquired on the input, the wrap's style includes a
 *     non-empty boxShadow ring entry.
 *   - On blur, the ring style is removed (no permanent ring).
 */
describe('SelectionListInputController — R13 web focus ring (Fix 1)', () => {
    it('exposes a stable focus-ring wrap testID and applies a visible ring on focus', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ctl"
                value=""
                onChangeText={() => {}}
                ghostSuffix=""
                onCaretAtEndChange={() => {}}
                placeholder="Search"
            />,
        );
        const wrap = screen.findByTestId('ctl:focus-ring');
        expect(wrap).not.toBeNull();
        // Initially unfocused → no ring.
        const initialStyle = Object.assign(
            {},
            ...((Array.isArray(wrap!.props.style) ? wrap!.props.style.flat(Infinity) : [wrap!.props.style])
                .filter(Boolean)),
        );
        const initialShadow: unknown = initialStyle.boxShadow;
        expect(
            typeof initialShadow !== 'string' || initialShadow.length === 0 || initialShadow === 'none',
        ).toBe(true);

        // Simulate focus on the input.
        const input = screen.findByTestId('ctl:input');
        expect(input).not.toBeNull();
        await act(async () => {
            input!.props.onFocus?.({});
        });

        const focusedWrap = screen.findByTestId('ctl:focus-ring');
        const focusedStyle = Object.assign(
            {},
            ...((Array.isArray(focusedWrap!.props.style)
                ? focusedWrap!.props.style.flat(Infinity)
                : [focusedWrap!.props.style]).filter(Boolean)),
        );
        const focusedShadow: unknown = focusedStyle.boxShadow;
        // boxShadow must be a non-empty string and not 'none'.
        expect(typeof focusedShadow).toBe('string');
        expect(focusedShadow).not.toBe('none');
        expect((focusedShadow as string).length).toBeGreaterThan(0);
    });

    it('removes the ring on blur', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ctl"
                value=""
                onChangeText={() => {}}
                ghostSuffix=""
                onCaretAtEndChange={() => {}}
                placeholder="Search"
            />,
        );
        const input = screen.findByTestId('ctl:input');
        await act(async () => {
            input!.props.onFocus?.({});
        });
        await act(async () => {
            input!.props.onBlur?.({});
        });
        const wrap = screen.findByTestId('ctl:focus-ring');
        const style = Object.assign(
            {},
            ...((Array.isArray(wrap!.props.style) ? wrap!.props.style.flat(Infinity) : [wrap!.props.style])
                .filter(Boolean)),
        );
        const shadow: unknown = style.boxShadow;
        expect(
            typeof shadow !== 'string' || shadow.length === 0 || shadow === 'none',
        ).toBe(true);
    });
});
