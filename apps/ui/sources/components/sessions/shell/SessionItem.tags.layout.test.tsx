import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { resolveSessionTagChipColors } from './sessionTagColors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: vi.fn(),
                alert: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useSetting: (key: string) => {
                    if (key === 'sessionListIdentityDisplay') return 'avatar';
                    if (key === 'sessionListActiveColorModeV1') return 'activityAndAttention';
                    if (key === 'sessionListNarrowWorkingIndicatorStyle') return 'spinner';
                    return undefined;
                },
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                }),
                useSession: () => null,
            },
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

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

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
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

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
    sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
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
    type SessionItemForTestProps = Omit<
        React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
        'rowModel'
    > & {
        rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
    };

    let SessionItem: React.ComponentType<SessionItemForTestProps>;

    beforeAll(async () => {
        const { SessionItem: ProductionSessionItem } = await import('./SessionItem');
        SessionItem = (props) => (
            <ProductionSessionItem
                {...props}
                rowModel={props.rowModel ?? createSessionItemTestRowModel(props)}
            />
        );
    });

    afterEach(() => {
        standardCleanup();
    });

    it('does not remove the fixed row height when tags are visible', async () => {
        const screen = await renderScreen(
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

        const row = screen.findByTestId('session-list-item-sess_1');
        expect(row).toBeTruthy();

        const styleArray = Array.isArray(row?.props.style) ? row?.props.style.filter(Boolean) : [row?.props.style].filter(Boolean);
        expect(styleArray.some((s: any) => typeof s === 'object' && s?.paddingVertical === 10)).toBe(false);
    });

    it('renders tags with their stable muted color', async () => {
        const screen = await renderScreen(
            <SessionItem
                session={createSession()}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                tagsEnabled={true}
                tags={['focus']}
                allKnownTags={['focus']}
                onSetTags={vi.fn()}
            />,
        );

        const tagText = screen.findAllByType('Text').find((node) => node.props.children === 'focus');
        const tagChip = tagText?.parent;
        const colors = resolveSessionTagChipColors('focus', false, false);

        expect(tagChip?.props.style).toContainEqual({ backgroundColor: colors.backgroundColor, borderColor: colors.borderColor });
        expect(tagText?.props.style).toContainEqual({ color: colors.color });
    });

    it('keeps narrow tags in the trailing metadata cluster', async () => {
        const screen = await renderScreen(
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
                tags={['TODO']}
                allKnownTags={['TODO']}
                onSetTags={vi.fn()}
            />,
        );

        const rightArea = screen.findByTestId('session-item-right-area');
        const rightAreaText = rightArea?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(rightAreaText).toContain('TODO');
        expect(screen.findByTestId('session-item-tags-below-sess_1')).toBeNull();
    });

    it('keeps narrow tags inline without moving them below the session', async () => {
        const screen = await renderScreen(
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
                tags={['tag', 'tag 12', 'tag 3']}
                allKnownTags={['tag', 'tag 12', 'tag 3']}
                onSetTags={vi.fn()}
            />,
        );

        const rightArea = screen.findByTestId('session-item-right-area');
        const rightAreaText = rightArea?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(rightAreaText).toContain('tag');
        expect(rightAreaText).toContain('tag 3');
        expect(rightAreaText).toContain('tag 12');
        expect(screen.findByTestId('session-item-tags-below-sess_1')).toBeNull();
    });

    it('places a short compact tag in the trailing metadata cluster', async () => {
        const screen = await renderScreen(
            <SessionItem
                session={createSession()}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                tagsEnabled={true}
                tags={['v2']}
                allKnownTags={['v2']}
                onTogglePinned={vi.fn()}
            />,
        );

        const rightArea = screen.findByTestId('session-item-right-area');
        const rightAreaText = rightArea?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(rightAreaText).toContain('v2');
        expect(screen.findByTestId('session-item-tags-below-sess_1')).toBeNull();
    });

    it('hides compact tags while row hover actions are visible', async () => {
        const screen = await renderScreen(
            <SessionItem
                session={createSession()}
                serverId="server_a"
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                tagsEnabled={true}
                tags={['v2']}
                allKnownTags={['v2']}
                onTogglePinned={vi.fn()}
            />,
        );

        const rightArea = screen.findByTestId('session-item-right-area');
        expect(rightArea?.findAllByType('Text').map((node) => node.props.children).join(' ')).toContain('v2');

        await act(async () => {
            rightArea?.props.onPointerEnter?.({} as never);
        });

        const hoveredRightArea = screen.findByTestId('session-item-right-area');
        const hoveredRightText = hoveredRightArea?.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(hoveredRightText).not.toContain('v2');
        expect(screen.findByTestId('session-item-tags-below-sess_1')).toBeNull();
        expect(screen.findAllByType('PinIcon')).toHaveLength(1);
    });
});
