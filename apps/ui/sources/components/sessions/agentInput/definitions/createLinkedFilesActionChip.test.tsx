import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/sessions/linkedFiles/projectPicker/LinkFilePickerPopoverContent', () => ({
    LinkFilePickerPopoverContent: (props: Record<string, unknown> & { onPickPath: (path: string) => void; onRequestClose: () => void }) =>
        React.createElement(
            'LinkFilePickerPopoverContent',
            props,
            React.createElement('Pressable', {
                testID: 'pick-file',
                onPress: () => {
                    props.onPickPath('src/example.ts');
                    props.onRequestClose();
                },
            }),
        ),
}));

describe('createLinkedFilesActionChip', () => {
    it('uses the shared AgentInput collapsed content popover so it participates in the unified popover controller', async () => {
        const { createLinkedFilesActionChip } = await import('./createLinkedFilesActionChip');

        const onPickPath = vi.fn();
        const chip = createLinkedFilesActionChip({
            sessionId: 's1',
            disabled: false,
            onPickPath,
        });

        expect(chip.collapsedContentPopover).toBeTruthy();
        expect(chip.collapsedContentPopover?.scrollEnabled).toBe(false);

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

        await screen.pressByTestIdAsync('agent-input-link-file');
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('project-file-link');

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

        const linkFilePicker = contentScreen.findByType('LinkFilePickerPopoverContent');
        expect(linkFilePicker?.props.maxHeight).toBe(420);

        await contentScreen.pressByTestIdAsync('pick-file');
        expect(onPickPath).toHaveBeenCalledWith('src/example.ts');
        expect(requestClose).toHaveBeenCalled();
    });

    it('uses the @ icon for link-file chips', async () => {
        const { createLinkedFilesActionChip } = await import('./createLinkedFilesActionChip');

        const chip = createLinkedFilesActionChip({
            sessionId: 's1',
            disabled: false,
            onPickPath: vi.fn(),
        });

        const screen = await renderScreen(
            <React.Fragment>
                {chip.render({
                    chipStyle: () => ({}),
                    showLabel: true,
                    iconColor: '#123',
                    textStyle: {},
                    countTextStyle: {},
                    chipAnchorRef: { current: null },
                    popoverAnchorRef: { current: null },
                })}
            </React.Fragment>,
        );

        const icon = screen.findAllByType('Ionicons')[0];
        expect(icon?.props.name).toBe('at');
    });
});
