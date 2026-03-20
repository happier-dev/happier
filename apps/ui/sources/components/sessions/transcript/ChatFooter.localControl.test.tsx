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
                groupped: { sectionTitle: '#444' },
                shadow: { color: '#000', opacity: 0.2 },
                box: { warning: { background: '#fff3cd', text: '#856404' } },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function'
            ? input({
                colors: {
                    groupped: { sectionTitle: '#444' },
                    shadow: { color: '#000', opacity: 0.2 },
                },
            })
            : input),
    },
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

    it('does not render footer actions when the session is not locally controlled', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
        });

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables).toHaveLength(0);

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

    it('renders a detach-local action for shared local attachment', async () => {
        const tree = await renderFooter({
            localControl: {
                attached: true,
                topology: 'shared',
                remoteWritable: true,
                canAttach: true,
                canDetach: true,
            },
            onRequestSwitchToRemote: vi.fn(),
        } as any);

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.sessionRunningLocallyAndRemotely')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.detachLocalTerminal')).toBe(true);
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToRemote')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders an attach-local action when shared local control can be attached from remote mode', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
            localControl: {
                attached: false,
                topology: 'shared',
                remoteWritable: true,
                canAttach: true,
                canDetach: false,
            },
            onRequestSwitchToLocal: vi.fn(),
        } as any);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal')).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders an attach-local action when exclusive local control can be attached from remote mode', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
            localControl: {
                attached: false,
                topology: 'exclusive',
                remoteWritable: true,
                canAttach: true,
                canDetach: false,
            },
            onRequestSwitchToLocal: vi.fn(),
        } as any);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToLocal')).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders direct takeover actions for linked direct sessions that are not yet controlled by Happier', async () => {
        const onRequestTakeOverDirect = vi.fn();
        const onRequestTakeOverPersist = vi.fn();
        const tree = await renderFooter({
            controlledByUser: false,
            directControl: {
                machineOnline: true,
                runnerActive: false,
                activity: 'active_recently',
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                takeoverInFlight: null,
                onRequestTakeOverDirect,
                onRequestTakeOverPersist,
            },
        } as any);

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.directSessionTakeoverAvailable')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        const directButton = pressables.find((node) => node.props.accessibilityLabel === 'chatFooter.takeOverDirect');
        const persistButton = pressables.find((node) => node.props.accessibilityLabel === 'chatFooter.takeOverPersist');
        expect(Boolean(directButton)).toBe(true);
        expect(Boolean(persistButton)).toBe(true);

        await act(async () => {
            directButton!.props.onPress();
            persistButton!.props.onPress();
        });

        expect(onRequestTakeOverDirect).toHaveBeenCalledTimes(1);
        expect(onRequestTakeOverPersist).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.unmount();
        });
    });

    it('renders a takeover-in-flight message and hides direct takeover actions while a direct switch is pending', async () => {
        const tree = await renderFooter({
            controlledByUser: false,
            directControl: {
                machineOnline: true,
                runnerActive: false,
                activity: 'running',
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                takeoverInFlight: 'direct',
            },
        } as any);

        const textNodes = tree.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'chatFooter.switchingToDirectTakeover')).toBe(true);

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.takeOverDirect')).toBe(false);
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.takeOverPersist')).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });
});
