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

        const pressables = tree.root.findAllByType('Pressable');
        expect(pressables.some((node) => node.props.accessibilityLabel === 'chatFooter.switchToRemote')).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not render switch-to-local controls while remote-controlled', async () => {
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
});
