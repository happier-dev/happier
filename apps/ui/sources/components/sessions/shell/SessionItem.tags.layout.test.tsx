import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'ios' },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
}));

vi.mock('@/modal', () => ({
    Modal: { prompt: vi.fn(), alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function createSession(): any {
    return {
        id: 'sess_1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('SessionItem tags (layout)', () => {
    it('does not remove the fixed row height when tags are visible', async () => {
        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession()}
                    serverId="server_a"
                    serverName="Server A"
                    showServerBadge={true}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    tagsEnabled={true}
                    tags={['tag-a']}
                    allKnownTags={['tag-a']}
                    onSetTags={vi.fn()}
                />,
            );
        });

        const pressables = (tree as any).root.findAllByType('Pressable');
        const rowPressable = pressables.find((node: any) => typeof node.props?.onPress === 'function' && typeof node.props?.onPressIn === 'function');
        expect(rowPressable).toBeTruthy();

        const styleArray = Array.isArray(rowPressable.props.style) ? rowPressable.props.style.filter(Boolean) : [rowPressable.props.style].filter(Boolean);
        expect(styleArray.some((s: any) => typeof s === 'object' && s?.paddingVertical === 10)).toBe(false);
    });

    it('renders tags in very compact mode (compact + minimal)', async () => {
        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession()}
                    serverId="server_a"
                    serverName="Server A"
                    showServerBadge={true}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={true}
                    compactMinimal={true}
                    tagsEnabled={true}
                    tags={['tag-a']}
                    allKnownTags={['tag-a']}
                    onSetTags={vi.fn()}
                />,
            );
        });

        const texts = (tree as any).root.findAllByType('Text').map((n: any) => n.props?.children);
        expect(texts).toContain('tag-a');
    });
});

