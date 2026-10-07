import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

describe('Item leftElementWhenHovered', () => {
    it('swaps left element while hovered on web', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="item-left-hover"
                title="Hover"
                onPress={() => {}}
                leftElement={<View testID="default-left" />}
                leftElementWhenHovered={<View testID="hover-left" />}
            />,
        );

        expect(screen.findByTestId('default-left')).toBeTruthy();
        expect(screen.findByTestId('hover-left')).toBeNull();

        const row = screen.findHostByTestId('item-left-hover')!;
        await act(async () => {
            row.props.onHoverIn();
        });

        expect(screen.findByTestId('default-left')).toBeNull();
        expect(screen.findByTestId('hover-left')).toBeTruthy();

        await act(async () => {
            row.props.onHoverOut();
        });
        expect(screen.findByTestId('default-left')).toBeTruthy();
        expect(screen.findByTestId('hover-left')).toBeNull();
    });
});
