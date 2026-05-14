import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        },
    });
});

function makeRoot(): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 's',
                options: [
                    { id: 'one', label: 'One' },
                    { id: 'two', label: 'Two' },
                ],
            },
        ],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeRoot(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList IME composing dispatch suppression (Phase 2.5)', () => {
    it('does not activate the focused option when Enter fires while composing', async () => {
        const onSelect = vi.fn();
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps({ onSelect })} />);

        const input = screen.findByTestId('sl:header:input');
        expect(input).not.toBeNull();

        // Simulate IME composition started.
        await act(async () => {
            input!.props.onCompositionStart?.();
        });

        // Press Enter while composing — must NOT activate the focused option.
        await act(async () => {
            input!.props.onKeyPress?.({
                key: 'Enter',
                isComposing: true,
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });

        expect(onSelect).not.toHaveBeenCalled();

        // End composition — Enter should now activate.
        await act(async () => {
            input!.props.onCompositionEnd?.();
            input!.props.onKeyPress?.({
                key: 'Enter',
                isComposing: false,
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('respects nativeEvent.isComposing as the composing flag (RN web fallback)', async () => {
        const onSelect = vi.fn();
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps({ onSelect })} />);

        const input = screen.findByTestId('sl:header:input');
        // Simulate composition via the nativeEvent flag (no compositionStart event).
        await act(async () => {
            input!.props.onKeyPress?.({
                key: 'Enter',
                nativeEvent: { key: 'Enter', isComposing: true },
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });
        expect(onSelect).not.toHaveBeenCalled();
    });
});
