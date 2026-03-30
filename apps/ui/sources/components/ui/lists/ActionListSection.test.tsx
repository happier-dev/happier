import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
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
});
