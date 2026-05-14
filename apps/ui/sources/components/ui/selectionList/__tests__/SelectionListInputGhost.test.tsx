import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListInputGhost (Phase 2.4)', () => {
    it('renders nothing when ghostSuffix is empty', async () => {
        const { SelectionListInputGhost } = await import('../SelectionListInputGhost');
        const screen = await renderScreen(
            <SelectionListInputGhost
                testID="g"
                ghostSuffix=""
                inputValue="abc"
            />,
        );
        // Hostless: only the component instance has testID prop; no host View renders.
        const hostMatches = screen.findAllByTestId('g').filter((n) => typeof n.type === 'string');
        expect(hostMatches).toEqual([]);
    });

    it('renders the ghost suffix when non-empty', async () => {
        const { SelectionListInputGhost } = await import('../SelectionListInputGhost');
        const screen = await renderScreen(
            <SelectionListInputGhost
                testID="g"
                ghostSuffix="uments/"
                inputValue="~/Doc"
            />,
        );
        const ghost = screen.findByTestId('g');
        expect(ghost).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('uments/');
    });

    it('applies opacity 0.4 to the ghost text container', async () => {
        const { SelectionListInputGhost } = await import('../SelectionListInputGhost');
        const screen = await renderScreen(
            <SelectionListInputGhost
                testID="g"
                ghostSuffix="suffix"
                inputValue="prefix"
            />,
        );
        const ghost = screen.findByTestId('g');
        expect(ghost).not.toBeNull();
        // Flatten possible style array
        const styleArray = Array.isArray(ghost!.props.style)
            ? ghost!.props.style.flat(Infinity)
            : [ghost!.props.style];
        const merged = Object.assign({}, ...styleArray.filter(Boolean));
        expect(merged.opacity).toBeCloseTo(0.4, 5);
    });
});
