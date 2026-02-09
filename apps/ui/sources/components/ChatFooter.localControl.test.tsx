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
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                box: { warning: { background: '#fff3cd', text: '#856404' } },
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/layout', () => ({
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
