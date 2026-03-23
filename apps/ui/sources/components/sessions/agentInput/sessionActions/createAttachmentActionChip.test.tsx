import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

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
            const screen = await renderScreen(
                <React.Fragment>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: true,
                        iconColor: '#000',
                        textStyle: {},
                        countTextStyle: {},
                        chipAnchorRef: { current: null },
                        popoverAnchorRef: { current: null },
                        toggleCollapsedPopover,
                    })}
                </React.Fragment>,
            );

            expect(screen.tree.toJSON()).not.toBeNull();
            await screen.pressByTestIdAsync('agent-input-attachments-chip');
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('attachments-add');

            const requestClose = vi.fn();
            const renderContent = chip.collapsedContentPopover!.renderContent;
            if (typeof renderContent !== 'function') {
                throw new Error('Expected collapsedContentPopover.renderContent to be a function');
            }
            const contentScreen = await renderScreen(
                <React.Fragment>
                    {renderContent({ requestClose, maxHeight: 420 }) as React.ReactNode}
                </React.Fragment>,
            );

            await contentScreen.pressByTestIdAsync('attachments-action-add-image');
            expect(onPickImage).toHaveBeenCalled();
            expect(requestClose).toHaveBeenCalled();

            requestClose.mockClear();
            await contentScreen.pressByTestIdAsync('attachments-action-add-file');
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

            const screen = await renderScreen(
                <React.Fragment>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: true,
                        iconColor: '#000',
                        textStyle: {},
                        countTextStyle: {},
                        chipAnchorRef: { current: null },
                        popoverAnchorRef: { current: null },
                        toggleCollapsedPopover: vi.fn(),
                    })}
                </React.Fragment>,
            );
            expect(screen.tree.toJSON()).not.toBeNull();
            await screen.pressByTestIdAsync('agent-input-attachments-chip');
            expect(onPickFile).toHaveBeenCalled();
        } finally {
            (Platform as any).OS = originalOs;
        }
    });
});
