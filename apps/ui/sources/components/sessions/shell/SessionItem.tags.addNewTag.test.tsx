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

const promptSpy = vi.fn(async () => 'new-tag');
vi.mock('@/modal', () => ({
    Modal: { prompt: promptSpy, alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionItem tags (new tag)', () => {
    it('creates a new tag via the tag dropdown create action and adds it to active tags', async () => {
        promptSpy.mockClear();
        const onSetTags = vi.fn();

        const { SessionItem } = await import('./SessionItem');

        const session = {
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
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
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
                    tags={[]}
                    allKnownTags={[]}
                    onSetTags={onSetTags}
                />,
            );
        });

        const stableItemLocator = (tree as any).root.findAll((node: any) => {
            return node.type === 'Pressable' && node.props?.testID === 'session-list-item-sess_1';
        });
        expect(stableItemLocator).toHaveLength(1);

        const dropdown = (tree as any).root.findByType('DropdownMenu');
        expect(dropdown.props.emptyLabel).toBe(null);
        expect(dropdown.props.showCategoryTitles).toBe(false);
        expect(typeof dropdown.props.createItemDisplay).toBe('function');

        const createDisplay = dropdown.props.createItemDisplay('ddd');
        expect(createDisplay.leftGap).toBe(8);
        expect(createDisplay.titleStyle).toMatchObject({ fontSize: 14 });
        expect(createDisplay.rowContainerStyle).toMatchObject({ paddingVertical: 6 });

        await act(async () => {
            dropdown.props.onCreateItem('new-tag');
        });

        expect(promptSpy).not.toHaveBeenCalled();
        await act(async () => {});

        expect(onSetTags).toHaveBeenCalledWith(['new-tag']);
    });
});
