import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { ChatFooter } from './ChatFooter';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                divider: '#ddd',
                shadow: { color: '#000', opacity: 0.2 },
                box: { warning: { background: '#fff3cd', text: '#856404' } },
            },
        },
    }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors: { shadow: { color: '#000', opacity: 0.2 } } }) : input) },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800 },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/SessionNoticeBanner', () => ({
    SessionNoticeBanner: () => null,
}));

async function renderFooter(props: React.ComponentProps<typeof ChatFooter>) {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
        tree = renderer.create(<ChatFooter {...props} />);
    });
    return tree!;
}

describe('ChatFooter (local control)', () => {
    it('renders a switch-to-remote button when controlled by user', async () => {
        const tree = await renderFooter({
            controlledByUser: true,
            onRequestSwitchToRemote: vi.fn(),
        });

        // Root container should allow full-width children so long notices wrap instead of overflowing.
        const views = tree.root.findAllByType('View');
        expect(views[0]?.props?.style?.alignItems).toBe('stretch');

        const warningViews = views.filter((v) => v.props?.style?.backgroundColor === '#fff3cd');
        expect(warningViews.length).toBe(1);
        expect(warningViews[0].props.style.flexWrap).toBe('wrap');

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.length).toBeGreaterThan(0);
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToRemote')).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('shows a local-running notice (without terminal-only copy) when the local permission bridge is enabled', async () => {
        const tree = await renderFooter({
            controlledByUser: true,
            permissionsInUiWhileLocal: true,
            onRequestSwitchToRemote: vi.fn(),
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.permissionsTerminalOnly')).toBe(false);
        expect(textNodes.some((node) => node.props.children === 'chatFooter.sessionRunningLocally')).toBe(true);
        const localNotice = textNodes.find((node) => node.props.children === 'chatFooter.sessionRunningLocally');
        expect(localNotice?.props?.selectable).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToRemote')).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not render switch-to-local controls when localControl is not provided', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.localModeAvailable')).toBe(false);
        expect(textNodes.some((node) => node.props.children === 'chatFooter.localModeUnavailableNeedsResume')).toBe(false);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders switch-to-local controls when local mode is available', async () => {
        const onRequestSwitchToLocal = vi.fn();
        const tree = await renderFooter({
            controlledByUser: false,
            localControl: { disabledReason: null, onRequestSwitchToLocal },
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.localModeAvailable')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        const switchToLocal = pressables.find((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal');
        expect(Boolean(switchToLocal)).toBe(true);

        await act(async () => {
            switchToLocal!.props.onPress();
        });
        expect(onRequestSwitchToLocal).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders a switching-to-local message and hides the action while a control switch is in flight', async () => {
        const onRequestSwitchToLocal = vi.fn();
        const tree = await renderFooter({
            controlledByUser: false,
            controlSwitchTo: 'local',
            localControl: { disabledReason: null, onRequestSwitchToLocal },
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.switchingToLocal')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders a switching-to-remote message and hides the action while a control switch is in flight', async () => {
        const tree = await renderFooter({
            controlledByUser: true,
            controlSwitchTo: 'remote',
            onRequestSwitchToRemote: vi.fn(),
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.switchingToRemote')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToRemote')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders an unavailable message and no action when local mode is disabled', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
            localControl: { disabledReason: 'machineOffline' },
        });

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.localModeUnavailableMachineOffline')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });
});
