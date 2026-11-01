import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

// Load the real row after boundaries, outside interaction deadlines.
await import('./Item');

describe('Item leading element', () => {
    it('lets a compact list row\'s leading element wider than the glyph box take its width instead of overhanging the title', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                title="happier"
                density="compact"
                onPress={() => {}}
                leftElement={<View testID="tree-leading" style={{ width: 44 }} />}
            />,
        );
        // The box that holds the leading element: its parent host.
        const box = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'tree-leading').length > 0
            && !node.findAll((child) => typeof child.type === 'string' && child.props?.numberOfLines !== undefined).length)
            .at(-2)!;
        const style = Object.assign({}, ...[box.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
        expect(style.width).toBe('auto');
        expect(typeof style.minWidth).toBe('number');
    });
});

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
