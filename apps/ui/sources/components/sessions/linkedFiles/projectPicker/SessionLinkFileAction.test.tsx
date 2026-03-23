import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        get OS() {
                                        return platformState.os;
                                    },
                        select: (values: any) => values?.web ?? values?.default ?? values?.ios ?? values?.android,
                    },
                    View: React.forwardRef((props: any, ref: any) => {
                            React.useImperativeHandle(ref, () => ({ nodeType: 'View' }));
                            return React.createElement('View', props, props.children);
                        }),
                    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            prompt: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        if (!props.open) return null;
        if (!props.anchorRef?.current) return null;
        return React.createElement('Popover', props, props.children({ maxHeight: 400 }));
    },
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: any) => React.createElement('AgentInputPopoverSurface', props, props.children),
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

vi.mock('./ProjectFileLinkPickerModal', () => ({
    ProjectFileLinkPickerModal: 'ProjectFileLinkPickerModal',
}));

import { SessionLinkFileAction } from './SessionLinkFileAction';
import { renderScreen } from '@/dev/testkit';

describe('SessionLinkFileAction', () => {
    it('toggles a popover on web and calls onPickPath when a file is selected', async () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        const screen = await renderScreen(
            <SessionLinkFileAction
                sessionId="s1"
                onPickPath={onPickPath}
                showLabel={true}
                chipStyle={() => ({})}
                iconColor="#000"
                textStyle={{}}
                popoverAnchorRef={popoverAnchorRef}
            />,
        );

        expect(screen.findByTestId('agent-input-link-file-popover')).toBeNull();

        await screen.pressByTestIdAsync('agent-input-link-file');

        const popover = screen.findByType('Popover');
        expect(popover.props.anchorRef).toBe(popoverAnchorRef);
        // When anchored to the full-width agent input container, the popover should match that width
        // (like the @ autocomplete popover), not shrink to the trigger chip width.
        expect(popover.props.portal?.matchAnchorWidth).toBe(true);

        // Clicking again should close the popover (toggle behavior).
        await screen.pressByTestIdAsync('agent-input-link-file');
        expect(screen.findByTestId('agent-input-link-file-popover')).toBeNull();

        // Clicking again should re-open it.
        await screen.pressByTestIdAsync('agent-input-link-file');
        expect(screen.findByTestId('agent-input-link-file-popover')).not.toBeNull();

        await screen.pressByTestIdAsync('pick-file');

        expect(onPickPath).toHaveBeenCalledTimes(1);
        expect(onPickPath).toHaveBeenCalledWith('src/example.ts');
        expect(screen.findByTestId('agent-input-link-file-popover')).toBeNull();
    });

    it('disables Popover close-on-anchor-press so the chip can act as a true toggle', async () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        const screen = await renderScreen(
            <SessionLinkFileAction
                sessionId="s1"
                onPickPath={onPickPath}
                showLabel={true}
                chipStyle={() => ({})}
                iconColor="#000"
                textStyle={{}}
                popoverAnchorRef={popoverAnchorRef}
            />,
        );

        // Open.
        await screen.pressByTestIdAsync('agent-input-link-file');
        const popover = screen.findByType('Popover');
        expect(popover.props.closeOnAnchorPress).toBe(false);
    });

    it('uses the shared popover on native instead of opening a modal', async () => {
        platformState.os = 'ios';
        const { Modal } = await import('@/modal');
        const onPickPath = vi.fn<(path: string) => void>();

        const screen = await renderScreen(
            <SessionLinkFileAction
                sessionId="s1"
                onPickPath={onPickPath}
                showLabel={true}
                chipStyle={() => ({})}
                iconColor="#000"
                textStyle={{}}
            />,
        );

        await screen.pressByTestIdAsync('agent-input-link-file');

        expect(Modal.show).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-link-file-popover')).not.toBeNull();
    });

    it('supports controlled open state without mirroring props into local state', async () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const onOpenChange = vi.fn<(next: boolean) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        const screen = await renderScreen(
            <SessionLinkFileAction
                sessionId="s1"
                onPickPath={onPickPath}
                showLabel={true}
                chipStyle={() => ({})}
                iconColor="#000"
                textStyle={{}}
                popoverAnchorRef={popoverAnchorRef}
                open={true}
                onOpenChange={onOpenChange}
            />,
        );

        expect(screen.findByTestId('agent-input-link-file-popover')).not.toBeNull();

        await screen.pressByTestIdAsync('agent-input-link-file');

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(screen.findByTestId('agent-input-link-file-popover')).not.toBeNull();
    });
});
