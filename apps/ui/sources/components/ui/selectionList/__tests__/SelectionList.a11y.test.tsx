import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeRootStep(): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [
            {
                kind: 'static',
                id: 'section-a',
                title: 'SECTION A',
                options: [
                    { id: 'opt-a', label: 'Alpha' },
                    { id: 'opt-b', label: 'Bravo' },
                ],
            },
        ],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeRootStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList accessibility contract (Phase 2.10)', () => {
    it('exposes role=listbox on the body container with an id consumed by the input combobox', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        const body = screen.findByTestId('sl:body');
        expect(body).not.toBeNull();
        expect(body!.props.role).toBe('listbox');
        expect(typeof body!.props.id).toBe('string');
        // The id should be the canonical 'sl:listbox' wiring used by the header's
        // aria-controls binding.
        expect(body!.props.id).toBe('sl:listbox');
    });

    it('exposes role=combobox + aria-controls + aria-expanded on the focused input element (web)', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // Per Phase 2.10: the combobox role MUST live on the input, not the wrapper,
        // so that aria-activedescendant updates are announced by screen readers.
        const input = screen.findByTestId('sl:header:input');
        expect(input).not.toBeNull();
        expect(input!.props.role).toBe('combobox');
        expect(input!.props['aria-controls']).toBe('sl:listbox');
        expect(input!.props['aria-expanded']).toBe(true);
        expect(input!.props['aria-haspopup']).toBe('listbox');
        // The header wrapper must NOT also claim combobox semantics.
        const header = screen.findByTestId('sl:header');
        expect(header?.props.role).not.toBe('combobox');
    });

    it('exposes role=option + aria-selected per option row, and the inner Item drops button role on web', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ selectedOptionId: 'opt-b' })} />,
        );
        const optA = screen.findByTestId('sl:root:option-wrapper:opt-a');
        const optB = screen.findByTestId('sl:root:option-wrapper:opt-b');
        expect(optA?.props.role).toBe('option');
        expect(optA?.props['aria-selected']).toBe(false);
        expect(optB?.props.role).toBe('option');
        expect(optB?.props['aria-selected']).toBe(true);

        // The inner Item Pressable must explicitly opt out of the default `button`
        // semantics on web so the wrapper's `option` role isn't shadowed by a
        // conflicting `button` role on a descendant. We rely on Item's `webRole`
        // prop (which sets an explicit DOM `role` that overrides the default
        // `accessibilityRole='button'` when rn-web translates it).
        const innerItem = screen.findByTestId('sl:root:option:opt-a');
        expect(innerItem).not.toBeNull();
        expect(innerItem!.props.role).not.toBe('button');
    });

    it('applies option accessibility labels to plain option wrappers', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: {
                        id: 'root',
                        inputPlaceholder: 'Search',
                        sections: [{
                            kind: 'static',
                            id: 'section-a',
                            options: [{
                                id: 'native',
                                label: 'Backend native auth',
                                accessibilityLabel: 'Anthropic · Backend native auth',
                            } as unknown as SelectionListOption],
                        }],
                    },
                })}
            />,
        );

        const wrapper = screen.findByTestId('sl:root:option-wrapper:native');

        expect(wrapper?.props.accessibilityLabel).toBe('Anthropic · Backend native auth');
        expect(wrapper?.props['aria-label']).toBe('Anthropic · Backend native auth');
    });
});
