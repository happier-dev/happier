import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { View } from 'react-native';

import { PlanOptionRow } from '../SelectionListOptionRow';
import type { SelectionListLazyVisual, SelectionListOption } from '../_types';

function hasAncestor(node: unknown, possibleAncestor: unknown): boolean {
    let current = (node as { parent?: unknown } | null)?.parent as { parent?: unknown } | undefined;
    while (current) {
        if (current === possibleAncestor) return true;
        current = current.parent as { parent?: unknown } | undefined;
    }
    return false;
}

const EXPANDED_TEST_ID = 'expanded-controls';

function makeOption(expandedContent: SelectionListLazyVisual): SelectionListOption {
    return {
        id: 'model-a',
        label: 'Model A',
        expandedContent,
    };
}

const staticExpanded = <View testID={EXPANDED_TEST_ID} />;

describe('SelectionListOptionRow expandedContent', () => {
    it('renders the expanded content for the selected option OUTSIDE the row pressable', async () => {
        const screen = await renderScreen(<PlanOptionRow
            option={makeOption(staticExpanded)}
            rootTestID="models"
            stepId="root"
            isSelected
            isFocused={false}
            onSelect={() => {}}
            onPushStep={() => {}}
        />);

        const expanded = screen.findByTestId(EXPANDED_TEST_ID);
        expect(expanded).not.toBeNull();

        // Discriminating assertion: the expanded node must be a SIBLING of the
        // row, never a descendant of the element carrying the option testID —
        // otherwise its controls would nest inside the row's Pressable, both
        // activating the row and producing nested-button markup on web.
        const rowNodes = screen.findAllByTestId('models:root:option:model-a');
        expect(rowNodes.length).toBeGreaterThan(0);
        for (const rowNode of rowNodes) {
            expect(hasAncestor(expanded, rowNode)).toBe(false);
        }
    });

    it('does not render the expanded content for an unselected option', async () => {
        const screen = await renderScreen(<PlanOptionRow
            option={makeOption(staticExpanded)}
            rootTestID="models"
            stepId="root"
            isSelected={false}
            isFocused
            onSelect={() => {}}
            onPushStep={() => {}}
        />);

        expect(screen.findByTestId(EXPANDED_TEST_ID)).toBeNull();
    });

    it('renders the expanded content in measure mode so the measured natural height includes it', async () => {
        const screen = await renderScreen(<PlanOptionRow
            option={makeOption(staticExpanded)}
            rootTestID="models"
            stepId="root"
            isSelected
            isFocused={false}
            onSelect={() => {}}
            onPushStep={() => {}}
            measureMode
        />);

        expect(screen.findByTestId(EXPANDED_TEST_ID)).not.toBeNull();
        // The measure mirror stays identity-free for the row itself.
        expect(screen.findByTestId('models:root:option:model-a')).toBeNull();
    });

    it('resolves a lazy expanded visual only for the selected row', async () => {
        let calls = 0;
        const lazy = (): React.ReactNode => {
            calls += 1;
            return <View testID={EXPANDED_TEST_ID} />;
        };

        await renderScreen(<PlanOptionRow
            option={makeOption(lazy)}
            rootTestID="models"
            stepId="root"
            isSelected={false}
            isFocused={false}
            onSelect={() => {}}
            onPushStep={() => {}}
        />);
        expect(calls).toBe(0);

        const screen = await renderScreen(<PlanOptionRow
            option={makeOption(lazy)}
            rootTestID="models"
            stepId="root"
            isSelected
            isFocused={false}
            onSelect={() => {}}
            onPushStep={() => {}}
        />);
        expect(calls).toBe(1);
        expect(screen.findByTestId(EXPANDED_TEST_ID)).not.toBeNull();
    });
});
