import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
                id: 'files',
                title: 'FILES',
                options: [{ id: 'opt-a', label: 'README.md' }],
            },
            {
                kind: 'static',
                id: 'plugins',
                title: 'PLUGINS',
                options: [{ id: 'opt-b', label: 'reviewer' }],
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

/**
 * A sectioned suggestion popover needs its listbox announced by name — a screen
 * reader otherwise reads "list box" with no indication of what the sections
 * belong to. `listAccessibilityLabel` is the owner-level way to supply it; it
 * must reach the SAME node that already carries `role="listbox"` and must stay
 * absent from the identity-free measure mirror.
 */
describe('SelectionList listAccessibilityLabel', () => {
    it('names the listbox host on the node that owns role=listbox', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ listAccessibilityLabel: 'Mention suggestions' })} />,
        );

        const body = screen.findByTestId('sl:body');
        expect(body).not.toBeNull();
        expect(body!.props.role).toBe('listbox');
        expect(body!.props.accessibilityLabel).toBe('Mention suggestions');
        expect(body!.props['aria-label']).toBe('Mention suggestions');
    });

    it('leaves the listbox unnamed when no label is supplied or the label is blank', async () => {
        const { SelectionList } = await import('../SelectionList');

        const unlabelled = await renderScreen(<SelectionList {...defaultProps()} />);
        const unlabelledBody = unlabelled.findByTestId('sl:body');
        expect(unlabelledBody!.props.role).toBe('listbox');
        expect(unlabelledBody!.props.accessibilityLabel).toBeUndefined();
        expect(unlabelledBody!.props['aria-label']).toBeUndefined();

        const blank = await renderScreen(
            <SelectionList {...defaultProps({ listAccessibilityLabel: '   ' })} />,
        );
        const blankBody = blank.findByTestId('sl:body');
        expect(blankBody!.props.accessibilityLabel).toBeUndefined();
        expect(blankBody!.props['aria-label']).toBeUndefined();
    });

    it('never duplicates the accessible name into the measure mirror', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    listAccessibilityLabel: 'Mention suggestions',
                    // The measure mirror only renders under the animated-height
                    // host, which requires transitions to stay enabled.
                    disableTransitions: false,
                })}
            />,
        );

        const labelled = screen.tree.root.findAll(
            (node) => node.props?.['aria-label'] === 'Mention suggestions',
        );
        expect(labelled).toHaveLength(1);
        expect(labelled[0]!.props.role).toBe('listbox');
    });
});
