import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { createAgentInputActionShortcutChip } from './createAgentInputActionShortcutChip';
import { createWorkflowRunActionChip } from './createWorkflowRunActionChip';
import { buildCollapsedExtraControlActions } from '../controls/buildCollapsedExtraControlActions';

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
    it('keeps the Workflow descriptor cold and shares one demand/content owner for chip and overflow', () => {
        const detailRead = vi.fn(() => null);
        const demand = vi.fn();
        const chip = createWorkflowRunActionChip({ label: 'Run…', title: 'Run…', testID: 'run-pattern',
            onIntent: demand, renderContent: detailRead });
        const opened = vi.fn();
        const render = chip.render({ chipStyle: () => null, showLabel: true, iconColor: '#000', textStyle: {},
            countTextStyle: {}, popoverAnchorRef: { current: null }, toggleCollapsedPopover: opened }) as React.ReactElement<{ onPress: () => void }>;
        expect(render).toBeTruthy();
        expect(chip.controlId).toBe('workflow');
        expect(chip.placement).toMatchObject({ id: 'workflow', defaultPlacement: 'overflow', pending: false });
        // A phone shows the picker as the shared bottom sheet, not a card over the header (lab T4-Rp).
        expect(chip.collapsedContentPopover?.phonePresentation).toBe('sheet');
        expect(detailRead).not.toHaveBeenCalled();
        expect(demand).not.toHaveBeenCalled();
        render.props.onPress();
        expect(demand).toHaveBeenCalledOnce();
        expect(opened).toHaveBeenCalledWith(chip.key);
        const actions = buildCollapsedExtraControlActions({ chips: [chip], tint: '#000', dismiss: () => {},
            blurInput: () => {}, openCollapsedOptionsPopover: opened });
        expect(detailRead).not.toHaveBeenCalled();
        actions.workflow?.[0]?.onPress?.();
        expect(demand).toHaveBeenCalledTimes(2);
        expect(opened).toHaveBeenCalledTimes(2);
        // Both chip and overflow use the composer's existing collapsed-content slot.
        const content = chip.collapsedContentPopover?.renderContent;
        if (typeof content !== 'function') throw new Error('Workflow detail must be demand-rendered');
        content({ requestClose: () => {}, maxHeight: 320 });
        expect(detailRead).toHaveBeenCalledOnce();
    });

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
        expect(chip.placement?.id).toBe('shortcuts:shortcut:review.start');

        const collapsedAction = expectSingleCollapsedAction(chip.collapsedAction?.({
            tint: '#000',
            dismiss,
            blurInput: () => {},
            openCollapsedPopover: () => {},
        }));
        collapsedAction.onPress?.();
        rendered.props.onPress?.();

        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(2);
    });
});
