import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { Platform } from 'react-native';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

function assertSingleCollapsedAction(
    action: ActionListItem | readonly ActionListItem[] | undefined,
): asserts action is ActionListItem {
    expect(Array.isArray(action)).toBe(false);
    if (!action || Array.isArray(action)) {
        throw new Error('expected a single collapsed action');
    }
}

describe('createAttachmentActionChip', () => {
    it('on iOS it opens a chooser popover (image vs file) instead of launching a picker immediately', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'ios';

        try {
            const onPickFile = vi.fn();
            const onPickImage = vi.fn();
            const onPasteImage = vi.fn();

            const chip = createAttachmentActionChip({
                onPickFile,
                onPickImage,
                onPasteImage,
            } as any);

            expect(chip.collapsedContentPopover).toBeFalsy();
            expect(chip.collapsedOptionsPopover).toMatchObject({
                presentation: 'list',
                title: '',
            });
            const rootStep = chip.collapsedOptionsPopover?.rootStep;
            if (!rootStep) throw new Error('expected attachment options root step');
            const section = rootStep.sections[0];
            expect(section?.kind).toBe('static');
            if (section?.kind !== 'static') throw new Error('expected static attachment section');
            expect(section.options.map((option) => ({ id: option.id, label: option.label }))).toEqual([
                { id: 'paste-image', label: 'common.pasteImage' },
                { id: 'add-image', label: 'common.addImage' },
                { id: 'add-file', label: 'common.addFile' },
            ]);

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

            section.options.find((option) => option.id === 'paste-image')?.onSelect?.();
            expect(onPasteImage).toHaveBeenCalledTimes(1);

            section.options.find((option) => option.id === 'add-image')?.onSelect?.();
            expect(onPickImage).toHaveBeenCalledTimes(1);

            section.options.find((option) => option.id === 'add-file')?.onSelect?.();
            expect(onPickFile).toHaveBeenCalledTimes(1);
        } finally {
            (Platform as any).OS = originalOs;
        }
    });

    it('on web it keeps the attach chip as a direct action (no chooser popover)', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        (Platform as any).OS = 'web';

        try {
            const callOrder: string[] = [];
            const onPickFile = vi.fn(() => {
                callOrder.push('pickFile');
            });
            const onPickImage = vi.fn();
            const chip = createAttachmentActionChip({
                onPickFile,
                onPickImage,
            } as any);

            expect(chip.collapsedContentPopover).toBeFalsy();
            expect(typeof chip.collapsedAction).toBe('function');

            const dismiss = vi.fn(() => {
                callOrder.push('dismiss');
            });
            const blurInput = vi.fn(() => {
                callOrder.push('blur');
            });
            const collapsed = chip.collapsedAction?.({
                tint: '#000',
                dismiss,
                blurInput,
            });
            assertSingleCollapsedAction(collapsed);
            if (typeof collapsed.onPress !== 'function') {
                throw new Error('Expected web attach chip to expose a single collapsedAction with onPress');
            }

            collapsed.onPress();
            expect(callOrder).toEqual(['blur', 'pickFile', 'dismiss']);

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

    it('on web it ignores duplicate press events fired shortly after opening (prevents double-open)', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        const originalNow = Date.now;
        (Platform as any).OS = 'web';

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

        try {
            const onPickFile = vi.fn();
            const onPickImage = vi.fn();
            const chip = createAttachmentActionChip({
                onPickFile,
                onPickImage,
            } as any);

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

            await screen.pressByTestIdAsync('agent-input-attachments-chip');
            await screen.pressByTestIdAsync('agent-input-attachments-chip');
            expect(onPickFile).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(500);
            await screen.pressByTestIdAsync('agent-input-attachments-chip');
            expect(onPickFile).toHaveBeenCalledTimes(2);
        } finally {
            (Platform as any).OS = originalOs;
            vi.useRealTimers();
            (Date as any).now = originalNow;
        }
    });

});
