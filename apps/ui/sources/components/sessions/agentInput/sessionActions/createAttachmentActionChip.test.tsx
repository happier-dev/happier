import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { Platform } from 'react-native';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

describe('createAttachmentActionChip', () => {
    it('on iOS it opens a chooser popover (image vs file) instead of launching a picker immediately', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'ios';

        try {
            const onPickFile = vi.fn();
            const onPickImage = vi.fn();

            const chip = createAttachmentActionChip({
                onPickFile,
                onPickImage,
            } as any);

            expect(chip.collapsedContentPopover).toBeTruthy();

            const toggleCollapsedPopover = vi.fn();
            const ui = chip.render({
                chipStyle: () => ({}),
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                chipAnchorRef: { current: null },
                popoverAnchorRef: { current: null },
                toggleCollapsedPopover,
            });

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<React.Fragment>{ui}</React.Fragment>);
            });
            expect(tree.toJSON()).not.toBeNull();
            const pressables = tree.root.findAll((node) => node.props?.testID === 'agent-input-attachments-chip');
            expect(pressables).toHaveLength(1);
            const pressable = pressables[0]!;
            await act(async () => {
                pressable.props.onPress?.();
            });
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('attachments-add');

            const requestClose = vi.fn();
            const renderContent = chip.collapsedContentPopover!.renderContent;
            expect(typeof renderContent).toBe('function');
            const contentNode = (renderContent as any)({ requestClose, maxHeight: 420 });
            let contentTree!: renderer.ReactTestRenderer;
            await act(async () => {
                contentTree = renderer.create(<React.Fragment>{contentNode as any}</React.Fragment>);
            });

            const addImageRow = contentTree.root.find((node) => node.props?.testID === 'attachments-action-add-image');
            await act(async () => {
                addImageRow.props.onPress?.();
            });
            expect(onPickImage).toHaveBeenCalled();
            expect(requestClose).toHaveBeenCalled();

            requestClose.mockClear();
            const addFileRow = contentTree.root.find((node) => node.props?.testID === 'attachments-action-add-file');
            await act(async () => {
                addFileRow.props.onPress?.();
            });
            expect(onPickFile).toHaveBeenCalled();
            expect(requestClose).toHaveBeenCalled();
        } finally {
            (Platform as any).OS = originalOs;
        }
    });

    it('on web it keeps the attach chip as a direct action (no chooser popover)', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'web';

        try {
            const onPickFile = vi.fn();
            const onPickImage = vi.fn();
            const chip = createAttachmentActionChip({
                onPickFile,
                onPickImage,
            } as any);

            expect(chip.collapsedContentPopover).toBeFalsy();

            const ui = chip.render({
                chipStyle: () => ({}),
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                chipAnchorRef: { current: null },
                popoverAnchorRef: { current: null },
                toggleCollapsedPopover: vi.fn(),
            });
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<React.Fragment>{ui}</React.Fragment>);
            });
            expect(tree.toJSON()).not.toBeNull();
            const pressables = tree.root.findAll((node) => node.props?.testID === 'agent-input-attachments-chip');
            expect(pressables).toHaveLength(1);
            const pressable = pressables[0]!;
            await act(async () => {
                pressable.props.onPress?.();
            });
            expect(onPickFile).toHaveBeenCalled();
        } finally {
            (Platform as any).OS = originalOs;
        }
    });
});
