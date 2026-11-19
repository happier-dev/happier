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
    it('adds the desktop capture entries to the root list, each running the action it was given', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const run = vi.fn();
        const chip = createAttachmentActionChip({ onPickFile: () => {}, onPickImage: () => {}, screenCapture: [
            { id: 'capture-screen', run }, { id: 'record-screen', run: () => {} }, { id: 'attach-recent-capture', run: () => {} },
        ] });
        const step = chip.collapsedOptionsPopover && 'rootStep' in chip.collapsedOptionsPopover ? chip.collapsedOptionsPopover.rootStep : null;
        const section = step?.sections.find((candidate) => candidate.id === 'screen-capture');
        const options = section && 'options' in section ? section.options : [];
        expect(options.map((option) => option.id)).toEqual(['capture-screen', 'record-screen', 'attach-recent-capture']);
        options[0]?.onSelect?.();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('stays a direct file press on a desktop host with no capture entries', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const chip = createAttachmentActionChip({ onPickFile: () => {}, onPickImage: () => {} });
        expect(chip.collapsedOptionsPopover).toBeUndefined();
    });

    it.each(['ios', 'android'] as const)('offers camera capture in the %s attachment chooser', async os => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        Platform.OS = os;
        try {
            const onTakePhoto = vi.fn();
            const callbacks = { onPickFile: vi.fn(), onPickImage: vi.fn(), onTakePhoto };
            const chip = createAttachmentActionChip(callbacks);
            const section = chip.collapsedOptionsPopover?.rootStep?.sections[0];
            if (section?.kind !== 'static') throw new Error('Expected attachment options');
            const camera = section.options.find(option => option.id === 'take-photo');
            expect(camera?.disabled).not.toBe(true);
            camera?.onSelect?.();
            expect(onTakePhoto).toHaveBeenCalledOnce();
        } finally {
            Platform.OS = originalOs;
        }
    });

    it('keeps files available while image attachment options explain dispatcher refusal', async () => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        Platform.OS = 'ios';
        try {
            const onPickFile = vi.fn();
            const onPickImage = vi.fn();
            const onPasteImage = vi.fn();
            const onTakePhoto = vi.fn();
            const chip = createAttachmentActionChip({ onPickFile, onPickImage, onPasteImage, onTakePhoto,
                imageInputDisabledReason: 'Agent cannot read images' });
            const section = chip.collapsedOptionsPopover?.rootStep?.sections[0];
            if (section?.kind !== 'static') throw new Error('Expected attachment options');
            const images = section.options.filter(option => option.id !== 'add-file');
            expect(images).toHaveLength(3);
            for (const option of images) {
                expect(option).toMatchObject({ disabled: true, subtitle: 'Agent cannot read images' });
                option.onSelect?.();
            }
            expect(onPickImage).not.toHaveBeenCalled();
            expect(onPasteImage).not.toHaveBeenCalled();
            expect(onTakePhoto).not.toHaveBeenCalled();
            const file = section.options.find(option => option.id === 'add-file');
            expect(file?.disabled).not.toBe(true);
            file?.onSelect?.();
            expect(onPickFile).toHaveBeenCalledOnce();
        } finally {
            Platform.OS = originalOs;
        }
    });
    it.each(['web', 'ios', 'android'] as const)('explains an unavailable attachment route on %s without opening a picker', async os => {
        const { createAttachmentActionChip } = await import('./createAttachmentActionChip');
        const originalOs = Platform.OS;
        Platform.OS = os;
        try {
            const onPickFile = vi.fn();
            const reason = { disabledReason: 'File transfer unavailable. Reconnect the session and try again.' };
            const chip = createAttachmentActionChip({ ...reason, disabled: true, onPickFile, onPickImage: vi.fn() });
            const action = chip.collapsedAction?.({ tint: '#000', dismiss: vi.fn(), blurInput: vi.fn(), openCollapsedPopover: vi.fn() });
            assertSingleCollapsedAction(action);
            expect(action).toMatchObject({ disabled: true, subtitle: reason.disabledReason });
            action.onPress?.();
            expect(onPickFile).not.toHaveBeenCalled();
            const screen = await renderScreen(<>{chip.render({ chipStyle: () => ({}), showLabel: false,
                iconColor: '#000', textStyle: {}, countTextStyle: {}, popoverAnchorRef: { current: null },
            })}</>);
            expect(screen.findByTestId('agent-input-attachments-chip')?.props).toMatchObject({
                disabled: true, accessibilityHint: reason.disabledReason,
            });
            expect(screen.tree.findAllByProps({ children: reason.disabledReason }).length).toBeGreaterThan(0);
        } finally {
            Platform.OS = originalOs;
        }
    });

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
                openCollapsedPopover: () => {},
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
