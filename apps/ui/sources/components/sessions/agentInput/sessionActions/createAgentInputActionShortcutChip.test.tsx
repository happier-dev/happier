import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { createAgentInputActionShortcutChip } from './createAgentInputActionShortcutChip';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Pressable: 'Pressable',
                                    View: 'View',
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

function expectSingleCollapsedAction(
    action: ActionListItem | readonly ActionListItem[] | undefined,
): ActionListItem {
    expect(Array.isArray(action)).toBe(false);
    if (!action || Array.isArray(action)) {
        throw new Error('expected a single collapsed action');
    }
    return action as ActionListItem;
}

describe('createAgentInputActionShortcutChip', () => {
    it('renders a row-layout shortcut chip and invokes the press handler', () => {
        const onPress = vi.fn();
        const dismiss = vi.fn();
        const chip = createAgentInputActionShortcutChip({
            key: 'shortcut:review.start',
            label: 'Start review',
            onPress,
            layout: 'row',
        });

        const rendered = chip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ onPress?: () => void; children?: React.ReactNode }>;

        expect(chip.key).toBe('shortcut:review.start');
        expect(rendered.type).toBe('Pressable');

        const children = React.Children.toArray(rendered.props.children);
        const contentRow = children[0] as React.ReactElement<{ children?: React.ReactNode }>;
        expect(contentRow.type).toBe('View');
        expect(chip.controlId).toBe('shortcuts');

        const collapsedAction = expectSingleCollapsedAction(chip.collapsedAction?.({
            tint: '#000',
            dismiss,
            blurInput: () => {},
        }));
        collapsedAction.onPress?.();
        rendered.props.onPress?.();

        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(2);
    });
});
