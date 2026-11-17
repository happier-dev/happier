import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findAllHostTestInstances, renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListProps, SelectionListStep } from '../_types';

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
    it('keeps a non-filtering scope step labelled but read-only', async () => {
        const rootStep: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [],
        };
        const scopeStep: SelectionListStep = {
            id: 'scope-picker',
            title: 'Home B',
            inputPlaceholder: 'Home B',
            inputReadOnly: true,
            disableInputFilter: true,
            sections: [{ kind: 'static', id: 'scopes', options: [{ id: 'b', label: 'Home B' }] }],
        };
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ rootStep, syncActiveStep: scopeStep })} />,
        );
        const input = screen.findByTestId('sl:header:input');
        expect(input?.props.editable).toBe(false);
        expect(input?.props.accessibilityLabel).toBe('Home B');
        expect(input?.props.accessibilityState).toEqual({ disabled: true });
    });
    it.each([
        {
            name: 'fallback identity',
            option: { id: 'focused-fallback', label: 'Focused fallback' },
            expectedId: 'sl:root:option:focused-fallback',
        },
        {
            name: 'explicit identity',
            option: {
                id: 'focused-explicit',
                testID: 'custom-focused-option',
                label: 'Focused explicit',
            },
            expectedId: 'custom-focused-option',
        },
    ])('keeps plain-row aria-activedescendant identical and unique for $name', async ({
        option,
        expectedId,
    }) => {
        const rootStep: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [{
                kind: 'static',
                id: 'section-a',
                options: [option],
            }],
        };
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep,
                    selectedOptionId: option.id,
                })}
            />,
        );

        const input = screen.findByTestId('sl:header:input');
        const row = screen.findByTestId(expectedId);
        // ReactTestRenderer exposes both a composite row owner and its host
        // node when props are forwarded. Only host nodes become DOM elements
        // and therefore participate in id uniqueness.
        const matchingHostIds = screen.tree.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.id === expectedId
        ));

        expect(input?.props['aria-activedescendant']).toBe(expectedId);
        expect(row?.props.id).toBe(expectedId);
        expect(matchingHostIds).toHaveLength(1);
    });

    it('keeps an empty result message inside the listbox group structure', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps({
            rootStep: {
                id: 'root',
                inputPlaceholder: 'Search',
                sections: [],
            },
        })} />);

        expect(screen.findByTestId('sl:empty')).not.toBeNull();
        expect(findAllHostTestInstances(screen.root, (node) => node.props?.role === 'group')).toHaveLength(1);
    });

    it('exposes role=combobox + aria-controls + aria-expanded on the focused input element, controlling the listbox body (web)', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // Per Phase 2.10: the combobox role MUST live on the input, not the wrapper,
        // so that aria-activedescendant updates are announced by screen readers.
        const input = screen.findByTestId('sl:header:input');
        expect(input).not.toBeNull();
        expect(input!.props.role).toBe('combobox');
        expect(input!.props['aria-controls']).toBe('sl:listbox');
        // …and the id it controls is the listbox body's own.
        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('listbox');
        expect(body?.props.id).toBe(input!.props['aria-controls']);
        expect(input!.props['aria-expanded']).toBe(true);
        expect(input!.props['aria-haspopup']).toBe('listbox');
        // The header wrapper must NOT also claim combobox semantics.
        const header = screen.findByTestId('sl:header');
        expect(header?.props.role).not.toBe('combobox');
    });

    it('puts option identity, selection, and position on the one actionable row node', async () => {
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ selectedOptionId: 'opt-b' })} />,
        );
        const wrapperA = screen.findByTestId('sl:root:option-wrapper:opt-a');
        const wrapperB = screen.findByTestId('sl:root:option-wrapper:opt-b');
        const optA = screen.findByTestId('sl:root:option:opt-a');
        const optB = screen.findByTestId('sl:root:option:opt-b');

        expect(wrapperA?.props.role).toBeUndefined();
        expect(wrapperB?.props.role).toBeUndefined();
        expect(optA?.props.role).toBe('option');
        expect(optA?.props.id).toBe('sl:root:option:opt-a');
        expect(optA?.props['aria-selected']).toBe(false);
        expect(optA?.props['aria-posinset']).toBe(1);
        expect(optA?.props['aria-setsize']).toBe(2);
        expect(optB?.props.role).toBe('option');
        expect(optB?.props.id).toBe('sl:root:option:opt-b');
        expect(optB?.props['aria-selected']).toBe(true);
        expect(optB?.props['aria-posinset']).toBe(2);
        expect(optB?.props['aria-setsize']).toBe(2);
        expect(optA?.props.tabIndex).toBe(-1);
        expect(optB?.props.tabIndex).toBe(-1);
    });

    it('applies option accessibility labels to plain actionable option rows', async () => {
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
                            }],
                        }],
                    },
                })}
            />,
        );

        const option = screen.findByTestId('sl:root:option:native');

        expect(option?.props.accessibilityLabel).toBe('Anthropic · Backend native auth');
        expect(option?.props['aria-label']).toBe('Anthropic · Backend native auth');
    });

    it('announces disabled state and positions disabled options in the full visible set', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps({
            rootStep: {
                id: 'root',
                inputPlaceholder: 'Search',
                sections: [{
                    kind: 'static',
                    id: 'section-a',
                    options: [
                        { id: 'enabled-a', label: 'Enabled A' },
                        { id: 'disabled', label: 'Disabled', disabled: true },
                        { id: 'enabled-b', label: 'Enabled B' },
                    ],
                }],
            },
        })} />);

        const disabled = screen.findByTestId('sl:root:option:disabled');
        expect(disabled?.props.role).toBe('option');
        expect(disabled?.props['aria-disabled']).toBe(true);
        expect(disabled?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(disabled?.props['aria-posinset']).toBe(2);
        expect(disabled?.props['aria-setsize']).toBe(3);
        expect(disabled?.props.tabIndex).not.toBe(0);
    });

    it('uses the custom-content pressable itself as the single option activation owner', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps({
            rootStep: {
                id: 'root',
                inputPlaceholder: 'Search',
                sections: [{
                    kind: 'static',
                    id: 'custom',
                    options: [{
                        id: 'custom-content',
                        label: 'Custom content',
                        content: <React.Fragment>Custom visual</React.Fragment>,
                    }],
                }],
            },
        })} />);

        const wrapper = screen.findByTestId('sl:root:option-wrapper:custom-content');
        const option = screen.findByTestId('sl:root:option:custom-content');
        expect(wrapper?.props.role).toBeUndefined();
        expect(option?.props.role).toBe('option');
        expect(option?.props.tabIndex).toBe(-1);
    });

    it('keeps exactly the roving focused option in the Tab order for a headerless list', async () => {
        const screen = await renderScreen(<SelectionList {...defaultProps({
            rootStep: {
                id: 'root',
                sections: [{
                    kind: 'static',
                    id: 'section-a',
                    options: [
                        { id: 'first', label: 'First' },
                        { id: 'second', label: 'Second' },
                    ],
                }],
            },
        })} />);

        expect(screen.findByTestId('sl:root:option:first')?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('sl:root:option:second')?.props.tabIndex).toBe(-1);
    });
});
