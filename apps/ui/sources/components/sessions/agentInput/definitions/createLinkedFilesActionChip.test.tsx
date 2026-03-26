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

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: (props: any) =>
        React.createElement(
            'SessionRepositoryTreeBrowserView',
            props,
            React.createElement('Pressable', {
                testID: 'pick-file',
                onPress: () => props.onOpenFile('src/example.ts'),
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

        await contentScreen.pressByTestIdAsync('pick-file');
        expect(onPickPath).toHaveBeenCalledWith('src/example.ts');
        expect(requestClose).toHaveBeenCalled();
    });
});
