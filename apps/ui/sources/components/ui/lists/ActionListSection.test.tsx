import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import type { ActionListItem, ActionListItemContent } from './ActionListSection';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

let selectableRowProps: any | null = null;
vi.mock('./SelectableRow', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./SelectableRow')>();
    return {
        SelectableRow: (props: any) => {
            selectableRowProps = props;
            return React.createElement(actual.SelectableRow, props);
        },
    };
});

describe('ActionListSection', () => {
    it('keeps a disabled action recovery explanation readable without truncating it to one menu line', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const reason = 'File transfer is unavailable. Reconnect this session or ask its owner to check the machine.';
        const screen = await renderScreen(<ActionListSection actions={[
            { id: 'attach', label: 'Attach', subtitle: reason, disabled: true },
            { id: 'available', label: 'Other action', subtitle: 'Ordinary summary' },
        ]} />);
        const reasonText = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.children === reason);
        expect(reasonText.length).toBeGreaterThan(0);
        // React Native's zero line count means no truncation; undefined uses
        // the shared OptionRow's ordinary two-line default.
        expect(reasonText.every(node => node.props.numberOfLines === 0)).toBe(true);
        expect(screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.children === 'Ordinary summary')
            .every(node => node.props.numberOfLines === 1)).toBe(true);
    });

    it('labels its section through the shared popover section-header owner, in the title\'s own case', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const { SelectionListSectionHeader } = await import('@/components/ui/selectionList/SelectionListSectionHeader');
        const screen = await renderScreen(
            <ActionListSection title="Homes" actions={[{ id: 'a', label: 'A' }]} />,
        );
        const header = screen.tree.root.findByType(SelectionListSectionHeader);
        expect(header.props.title).toBe('Homes');
    });

    it('wraps string icons so they do not render as raw text nodes under <View>', async () => {
        const { ActionListSection } = await import('./ActionListSection');

        selectableRowProps = null;

        const screen = await renderScreen(
            <ActionListSection
                title="Actions"
                actions={[
                    {
                        id: 'dot',
                        label: 'Dot action',
                        icon: '.',
                    },
                ]}
            />,
        );

        expect(selectableRowProps).toBeTruthy();
        expect(selectableRowProps.left).toBeTruthy();
        expect((selectableRowProps.left.type as any)?.name ?? selectableRowProps.left.type).toBe('View');
        expect(typeof selectableRowProps.left.props.children).not.toBe('string');
        expect(React.isValidElement(selectableRowProps.left.props.children)).toBe(true);
        expect(selectableRowProps.left.props.children.props.children).toBe('.');
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('normalizes icon fragments so they do not render raw text nodes under <View>', async () => {
        const { ActionListSection } = await import('./ActionListSection');

        selectableRowProps = null;

        const screen = await renderScreen(
            <ActionListSection
                actions={[
                    {
                        id: 'fragment',
                        label: 'Fragment icon',
                        icon: <>{'.'}</>,
                    },
                ]}
            />,
        );

        expect(selectableRowProps).toBeTruthy();
        expect(selectableRowProps.left).toBeTruthy();
        expect((selectableRowProps.left.type as any)?.name ?? selectableRowProps.left.type).toBe('View');
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('lets a private render boundary update the incumbent row without taking over its SelectableRow chrome', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const receivedItems: ActionListItemContent[] = [];
        const action: ActionListItem = {
            id: 'dynamic',
            label: 'Declaration fallback',
            icon: '.',
            renderItem: (item, renderDefaultItem) => {
                receivedItems.push(item);
                return renderDefaultItem({
                    ...item,
                    label: 'Live Resource label',
                    disabled: true,
                });
            },
        };

        selectableRowProps = null;
        await renderScreen(<ActionListSection actions={[action]} />);

        expect(receivedItems).toEqual([{
            id: 'dynamic',
            label: 'Declaration fallback',
            icon: '.',
        }]);
        expect(selectableRowProps).toEqual(expect.objectContaining({
            title: 'Live Resource label',
            disabled: true,
            variant: 'slim',
        }));
    });

    it('draws menu rows as the menu\'s inset rounded highlight, with a fill and no outline', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const { flattenTestStyle } = await import('@/dev/testkit/harness/popoverHarness');

        const screen = await renderScreen(
            <ActionListSection
                actions={[
                    { id: 'current', testID: 'row-current', label: 'All sources', selected: true, onPress: () => {} },
                    { id: 'other', testID: 'row-other', label: 'Community npm', onPress: () => {} },
                ]}
            />,
        );

        const rowStyle = (testID: string) => flattenTestStyle(screen.findByTestId(testID)?.props.style);
        for (const testID of ['row-current', 'row-other']) {
            const style = rowStyle(testID);
            expect(style.alignSelf).toBe('stretch');
            // Inset rounded highlight (owner 2026-11-11, phone #03/#05): the menu keeps one even inner inset.
            expect(style.marginHorizontal).toBe(MENU_ROW_METRICS.insetPx);
            expect(style.borderRadius).toBe(MENU_ROW_METRICS.highlightRadiusPx);
            expect(style.borderWidth).toBe(0);
        }
        // The current choice is a fill; the other row has none.
        expect(rowStyle('row-current').backgroundColor).not.toBe('transparent');
        expect(rowStyle('row-other').backgroundColor).toBe('transparent');
    });

    it('keeps an authored action accessibility label when it differs from the visible label', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const action: ActionListItem = {
            id: 'accessible-action',
            label: 'Visible label',
            accessibilityLabel: 'Accessible action name',
        };

        selectableRowProps = null;
        await renderScreen(<ActionListSection actions={[action]} />);

        expect(selectableRowProps).toEqual(expect.objectContaining({
            title: 'Visible label',
            accessibilityLabel: 'Accessible action name',
        }));
    });

    it('exposes applied menu choices with platform-correct button selection semantics', async () => {
        const { ActionListSection } = await import('./ActionListSection');

        const screen = await renderScreen(
            <ActionListSection
                title="Width"
                actions={[
                    { id: 'compact', testID: 'choice-compact', label: 'Compact', selected: true, onPress: () => {} },
                    { id: 'wide', testID: 'choice-wide', label: 'Wide', selected: false, onPress: () => {} },
                    { id: 'rename', testID: 'plain-action', label: 'Rename', onPress: () => {} },
                ]}
            />,
        );

        const compact = screen.findByTestId('choice-compact');
        const wide = screen.findByTestId('choice-wide');
        const plain = screen.findByTestId('plain-action');
        expect(compact?.props.role ?? compact?.props.accessibilityRole).toBe('button');
        expect(compact?.props['aria-pressed'] ?? compact?.props.accessibilityState?.selected).toBe(true);
        expect(compact?.props.accessibilityState).toMatchObject({ selected: true });
        expect(wide?.props['aria-pressed'] ?? wide?.props.accessibilityState?.selected).toBe(false);
        expect(wide?.props.accessibilityState).toMatchObject({ selected: false });
        expect(plain?.props).not.toHaveProperty('aria-pressed');
        expect(plain?.props.accessibilityState).toBeUndefined();
    });

    it('preserves hook order when an initially empty section gains and loses actions', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        const action: ActionListItem = {
            id: 'late-action',
            testID: 'late-action',
            label: 'Loaded action',
            onPress: () => {},
        };

        const screen = await renderScreen(<ActionListSection actions={[]} />);

        await expect(screen.update(<ActionListSection actions={[action]} />)).resolves.toBeUndefined();
        expect(screen.findByTestId('late-action')).toBeTruthy();
        await expect(screen.update(<ActionListSection actions={[]} />)).resolves.toBeUndefined();
        expect(screen.findByTestId('late-action')).toBeNull();
    });
});
