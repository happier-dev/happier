import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
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
});
