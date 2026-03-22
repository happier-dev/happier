import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { buildNewSessionActionShortcutChips } from './buildNewSessionActionShortcutChips';

const actionIdsState = vi.hoisted(() => ({
    value: [] as string[],
}));

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

vi.mock('@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds', () => ({
    listAgentInputActionChipActionIds: () => actionIdsState.value,
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

describe('buildNewSessionActionShortcutChips', () => {
    it('builds shortcut chips that call the supplied action handler', () => {
        actionIdsState.value = ['review.start'];
        const onPressAction = vi.fn();

        const chips = buildNewSessionActionShortcutChips({
            stateSnapshot: { settings: {} },
            onPressAction,
        });

        expect(chips.map((chip) => chip.key)).toEqual(['new-session-action:review.start']);
        expect(chips[0]?.controlId).toBe('shortcuts');
        const collapsedAction = expectSingleCollapsedAction(chips[0]?.collapsedAction?.({
            tint: '#000',
            dismiss: () => {},
            blurInput: () => {},
        }));
        expect(collapsedAction.id).toBe('new-session-action:review.start');

        const rendered = chips[0]!.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ onPress?: () => void }>;

        rendered.props.onPress?.();

        expect(onPressAction).toHaveBeenCalledWith('review.start');
    });
});
