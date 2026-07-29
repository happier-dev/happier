import * as React from 'react';
import { Pressable } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('SelectableRow (disabled children)', () => {
    it('does not disable the root pressable so nested actions remain usable', async () => {
        const { SelectableRow } = await import('./SelectableRow');
        const onRowPress = vi.fn();
        const onInnerPress = vi.fn();

        const screen = await renderScreen(
            <SelectableRow
                testID="selectable-row"
                title="Row"
                disabled={true}
                onPress={onRowPress}
                right={<Pressable testID="selectable-row-inner" onPress={onInnerPress} />}
            />,
        );

        const rootPressable = screen.findAll((node) => (
            node.props?.testID === 'selectable-row' && typeof node.props?.style === 'function'
        ))[0];
        expect(rootPressable).toBeTruthy();
        expect(rootPressable?.props?.disabled).toBeUndefined();
        expect(rootPressable?.props?.onPress).toBeUndefined();
    });
});
