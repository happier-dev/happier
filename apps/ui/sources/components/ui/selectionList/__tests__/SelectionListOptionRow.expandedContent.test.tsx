import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { View } from 'react-native';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';

import { PlanOptionRow } from '../SelectionListOptionRow';
import { SelectionListA11yPatternContext } from '../SelectionListA11yPatternContext';
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
    it.each(['none', 'text'] as const)('keeps an always-visible recovery actionable on a disabled, unfocused row (%s inset)', async (inset) => {
        const recover = vi.fn();
        const choose = vi.fn();
        const option: SelectionListOption = {
            id: 'missing-copy', label: 'Worker', disabled: true,
            expandedContentVisibility: 'always', expandedContentInset: inset,
            expandedContent: () => <TextLinkButton label="Set up copy" testID="copy-recovery" onPress={recover} />,
        };
        const screen = await renderScreen(<SelectionListA11yPatternContext.Provider value="grid">
            <PlanOptionRow option={option} rootTestID="workers" stepId="root"
                isSelected={false} isFocused={false} onSelect={choose} onPushStep={() => {}} />
        </SelectionListA11yPatternContext.Provider>);
        try {
            const recovery = screen.findByTestId('copy-recovery');
            expect(recovery).not.toBeNull();
            let ancestor = recovery?.parent;
            while (ancestor) {
                expect(ancestor.props['aria-disabled']).not.toBe(true);
                expect(ancestor.props.accessibilityState?.disabled).not.toBe(true);
                ancestor = ancestor.parent;
            }
            await screen.pressByTestIdAsync('copy-recovery');
            expect(recover).toHaveBeenCalledOnce();
            expect(choose).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('shows an opted-in preview on focus without selecting and restores the snippet when focus leaves', async () => {
        const option: SelectionListOption = {
            ...makeOption(staticExpanded),
            subtitleContent: <View testID="compact-snippet" />,
            expandedContentVisibility: 'focused',
            hideSubtitleWhenExpanded: true,
        };
        const screen = await renderScreen(<PlanOptionRow option={option} rootTestID="files" stepId="root"
            isSelected={false} isFocused onSelect={() => {}} onPushStep={() => {}} />);

        const expanded = screen.findByTestId(EXPANDED_TEST_ID);
        expect(expanded).not.toBeNull();
        expect(screen.findByTestId('compact-snippet')).toBeNull();
        const rows = screen.findAllByTestId('files:root:option:model-a');
        expect(rows.some(row => row.props['aria-selected'] === false)).toBe(true);
        for (const row of rows) expect(hasAncestor(expanded, row)).toBe(false);

        await screen.update(<PlanOptionRow option={option} rootTestID="files" stepId="root"
            isSelected isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        expect(screen.findByTestId(EXPANDED_TEST_ID)).toBeNull();
        expect(screen.findByTestId('compact-snippet')).not.toBeNull();
    });

    it('preserves the plain accessible label while rendering a lazy rich title and suppresses a replaced snippet only when expanded', async () => {
        const option: SelectionListOption = { id: 'file', label: 'src/file.ts:4', accessibilityLabel: 'src/file.ts:4',
            labelContent: () => <View testID="file-label" />, subtitleContent: () => <View testID="file-snippet" />,
            expandedContent: staticExpanded, hideSubtitleWhenExpanded: true };
        const screen = await renderScreen(<PlanOptionRow option={option} rootTestID="files" stepId="root"
            isSelected isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        expect(screen.findByTestId('file-label')).not.toBeNull();
        expect(screen.findByTestId('file-snippet')).toBeNull();
        expect(screen.findByTestId(EXPANDED_TEST_ID)).not.toBeNull();
        expect(screen.findAllByTestId('files:root:option:file').some(node => node.props.accessibilityLabel === option.label)).toBe(true);
        await screen.update(<PlanOptionRow option={option} rootTestID="files" stepId="root"
            isSelected={false} isFocused onSelect={() => {}} onPushStep={() => {}} />);
        expect(screen.findByTestId('file-snippet')).not.toBeNull();
        expect(screen.findByTestId(EXPANDED_TEST_ID)).toBeNull();
    });
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

        // Controls follow selection by default, not the keyboard focus: a focused row that is not
        // selected neither builds nor shows its panel.
        const unselected = await renderScreen(<PlanOptionRow
            option={makeOption(lazy)}
            rootTestID="models"
            stepId="root"
            isSelected={false}
            isFocused
            onSelect={() => {}}
            onPushStep={() => {}}
        />);
        expect(calls).toBe(0);
        expect(unselected.findByTestId(EXPANDED_TEST_ID)).toBeNull();

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
