import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
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
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), prompt: vi.fn(), alert: vi.fn() },
}));

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

describe('SessionLinkFileAction', () => {
    it('toggles a popover on web and calls onPickPath when a file is selected', () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
        });

        expect(tree!.root.findAllByType('Popover')).toHaveLength(0);

        const linkChip = tree!.root.findByProps({ testID: 'agent-input-link-file' });
        act(() => {
            linkChip.props.onPress();
        });

        expect(tree!.root.findAllByType('Popover')).toHaveLength(1);
        expect(tree!.root.findByType('Popover').props.anchorRef).toBe(popoverAnchorRef);
        // When anchored to the full-width agent input container, the popover should match that width
        // (like the @ autocomplete popover), not shrink to the trigger chip width.
        expect(tree!.root.findByType('Popover').props.portal?.matchAnchorWidth).toBe(true);

        // Clicking again should close the popover (toggle behavior).
        act(() => {
            linkChip.props.onPress();
        });
        expect(tree!.root.findAllByType('Popover')).toHaveLength(0);

        // Clicking again should re-open it.
        act(() => {
            linkChip.props.onPress();
        });
        expect(tree!.root.findAllByType('Popover')).toHaveLength(1);

        const pick = tree!.root.findByProps({ testID: 'pick-file' });
        act(() => {
            pick.props.onPress();
        });

        expect(onPickPath).toHaveBeenCalledTimes(1);
        expect(onPickPath).toHaveBeenCalledWith('src/example.ts');
        expect(tree!.root.findAllByType('Popover')).toHaveLength(0);
    });

    it('disables Popover close-on-anchor-press so the chip can act as a true toggle', () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
        });

        const linkChip = tree!.root.findByProps({ testID: 'agent-input-link-file' });

        // Open.
        act(() => {
            linkChip.props.onPress();
        });
        const popover = tree!.root.findByType('Popover');
        expect(popover.props.closeOnAnchorPress).toBe(false);
    });

    it('uses the shared popover on native instead of opening a modal', async () => {
        platformState.os = 'ios';
        const { Modal } = await import('@/modal');
        const onPickPath = vi.fn<(path: string) => void>();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SessionLinkFileAction
                    sessionId="s1"
                    onPickPath={onPickPath}
                    showLabel={true}
                    chipStyle={() => ({})}
                    iconColor="#000"
                    textStyle={{}}
                />,
            );
        });

        const linkChip = tree!.root.findByProps({ testID: 'agent-input-link-file' });
        act(() => {
            linkChip.props.onPress();
        });

        expect(Modal.show).not.toHaveBeenCalled();
        expect(tree!.root.findAllByType('Popover')).toHaveLength(1);
    });

    it('supports controlled open state without mirroring props into local state', () => {
        platformState.os = 'web';
        const onPickPath = vi.fn<(path: string) => void>();
        const onOpenChange = vi.fn<(next: boolean) => void>();
        const popoverAnchorRef = { current: { nodeType: 'View' } } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
        });

        expect(tree!.root.findAllByType('Popover')).toHaveLength(1);

        const linkChip = tree!.root.findByProps({ testID: 'agent-input-link-file' });
        act(() => {
            linkChip.props.onPress();
        });

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(tree!.root.findAllByType('Popover')).toHaveLength(1);
    });
});
