import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const rootStep: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search Homes',
    sections: [{
        kind: 'static',
        id: 'homes',
        options: [
            { id: 'home-a', label: 'Home A' },
            { id: 'home-b', label: 'Home B' },
        ],
    }],
};

describe('SelectionList controlled multiple selection', () => {
    it('exposes multiselect semantics and keeps every selected row selected', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selection={{ kind: 'multiple', selectedIds: new Set(['home-a', 'home-b']) }}
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        expect(screen.findByTestId('sl:body')?.props['aria-multiselectable']).toBe(true);
        expect(screen.findByTestId('sl:root:option:home-a')?.props['aria-selected']).toBe(true);
        expect(screen.findByTestId('sl:root:option:home-b')?.props['aria-selected']).toBe(true);
    });

    it('keeps focus separate and leaves the list open when a selected row toggles', async () => {
        const onSelect = vi.fn();
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selection={{ kind: 'multiple', selectedIds: new Set(['home-a']) }}
                onSelect={onSelect}
                onRequestClose={onRequestClose}
                disableTransitions
                testID="sl"
            />,
        );

        screen.pressByTestId('sl:root:option:home-b');

        expect(onSelect).toHaveBeenCalledWith('home-b', expect.objectContaining({ id: 'home-b' }));
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('sl:root:option:home-a')?.props['aria-selected']).toBe(true);
    });

    it('opens with focus on the first selected row, so only the selected row is tinted', async () => {
        const screen = await renderScreen(
            <SelectionList
                rootStep={rootStep}
                selection={{ kind: 'multiple', selectedIds: new Set(['home-b']) }}
                onSelect={vi.fn()}
                onRequestClose={vi.fn()}
                disableTransitions
                testID="sl"
            />,
        );

        const active = screen.findByTestId('sl:header:input')?.props['aria-activedescendant'];
        expect(typeof active).toBe('string');
        expect(active).toBe(screen.findByTestId('sl:root:option:home-b')?.props.id);
    });

    it('rejects expanded content in multiple mode', async () => {
        expect(() => SelectionList({
            rootStep: {
                ...rootStep,
                sections: [{
                    kind: 'static',
                    id: 'homes',
                    options: [{ id: 'home-a', label: 'Home A', expandedContent: <React.Fragment /> }],
                }],
            },
            selection: { kind: 'multiple', selectedIds: new Set(['home-a']) },
            onSelect: vi.fn(),
            onRequestClose: vi.fn(),
        })).toThrow(/expandedContent/);
    });
});
