import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

const renders = vi.hoisted(() => ({ leadingSlot: 0, filterChips: 0, footer: 0, rows: 0 }));

// The leading slot's search-icon wrapper renders exactly when the real slot re-renders.
vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    const CountedAnimatedView = React.forwardRef(function CountedAnimatedView(props: { testID?: string }, ref) {
        if (props.testID?.endsWith('leading:search-icon')) renders.leadingSlot += 1;
        return <native.Animated.View {...props} ref={ref as never} />;
    });
    return { ...native, Animated: { ...native.Animated, View: CountedAnimatedView } };
});

const OPTIONS = Array.from({ length: 12 }, (_, index) => ({ id: `opt-${index}`, label: `Option ${index}` }));
const ROOT_STEP: SelectionListStep = { id: 'root', inputPlaceholder: 'Search', sections: [{ kind: 'static', id: 'section-a', options: OPTIONS }] };

function makeKeyEvent(key: string) {
    return { key, nativeEvent: { key }, preventDefault: () => {}, stopPropagation: () => {} };
}

describe('SelectionList arrow-key render fan-out', () => {
    it('re-renders only the input, not the rest of the search header, when the highlighted row moves', async () => {
        const { SelectionList } = await import('../SelectionList');
        const props: SelectionListProps = {
            rootStep: ROOT_STEP, onSelect: vi.fn(), onRequestClose: vi.fn(), keyboardHintsEnabled: false,
            disableTransitions: true, testID: 'sl',
        };
        const screen = await renderScreen(<SelectionList {...props} />);
        await act(async () => { await Promise.resolve(); });
        const press = async () => {
            const header = screen.findAllByTestId('sl:header').find((node) => typeof node.props?.onKeyPress === 'function');
            await act(async () => { (header!.props.onKeyPress as (event: unknown) => void)(makeKeyEvent('ArrowDown')); });
        };
        await press();
        renders.leadingSlot = 0;
        for (let index = 0; index < 3; index += 1) await press();
        expect(renders.leadingSlot).toBe(0);
    });
});
