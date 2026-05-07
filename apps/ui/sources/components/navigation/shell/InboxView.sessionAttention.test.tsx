import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();
const storageState = {
    profile: { id: 'me' },
    sessionMessages: {
        'session-1': { messages: [] },
    },
    sessions: {
        'session-1': {
            active: true,
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/leeroy/repo',
                homeDir: '/Users/leeroy',
            },
        },
    },
    machines: {
        'machine-target': {
            id: 'machine-target',
            active: true,
            activeAt: 10,
            metadata: { host: 'workstation.local' },
        },
    },
    getProjectForSession: (sessionId: string) =>
        sessionId === 'session-1'
            ? {
                key: {
                    machineId: 'machine-target',
                    path: '/Users/leeroy/repo',
                },
            }
            : null,
};

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#111' },
                    text: '#fff',
                    textSecondary: '#999',
                    header: { tint: '#fff' },
                    warning: '#f80',
                    divider: '#333',
                    surface: '#171717',
                    surfaceHigh: '#1d1d1d',
                    surfaceHighest: '#222',
                    surfacePressedOverlay: '#333',
                    status: { error: '#f00' },
                    button: { primary: { tint: '#fff', background: '#444' } },
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: pushSpy },
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useArtifacts: () => [],
            useFriendRequests: () => [],
            useRequestedFriends: () => [],
            useFeedItems: () => [],
            useFeedLoaded: () => true,
            useFriendsLoaded: () => true,
            useAllSessions: () => [
                {
                    id: 'session-1',
                    active: true,
                    presence: 'online',
                    metadata: {
                        name: 'Repo session',
                        path: '/Users/leeroy/repo',
                        homeDir: '/Users/leeroy',
                        machineId: 'machine-stale',
                    },
                    agentState: {
                        requests: {
                            perm_1: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'pwd' },
                                createdAt: 1,
                            },
                            ask_1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Proceed' }] }],
                                },
                                createdAt: 2,
                            },
                        },
                        completedRequests: {},
                    },
                    owner: null,
                },
            ],
            useAllSessionsForAttention: () => [
                {
                    id: 'session-1',
                    active: true,
                    presence: 'online',
                    metadata: {
                        name: 'Repo session',
                        path: '/Users/leeroy/repo',
                        homeDir: '/Users/leeroy',
                        machineId: 'machine-stale',
                    },
                    agentState: {
                        requests: {
                            perm_1: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'pwd' },
                                createdAt: 1,
                            },
                            ask_1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Proceed' }] }],
                                },
                                createdAt: 2,
                            },
                        },
                        completedRequests: {},
                    },
                    owner: null,
                },
            ],
            useAllSessionListRenderables: () => [
                {
                    id: 'session-1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: {
                        name: 'Repo session',
                        path: '/Users/leeroy/repo',
                        homeDir: '/Users/leeroy',
                        machineId: 'machine-stale',
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    hasUnreadMessages: false,
                },
            ],
            useAllSessionListRenderablesForAttention: () => [
                {
                    id: 'session-1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: {
                        name: 'Repo session',
                        path: '/Users/leeroy/repo',
                        homeDir: '/Users/leeroy',
                        machineId: 'machine-stale',
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    hasUnreadMessages: false,
                },
            ],
            useMachine: (machineId: string) =>
                machineId === 'machine-target'
                    ? {
                        id: 'machine-target',
                        metadata: { displayName: 'Rebound workstation', host: 'workstation.local' },
                    }
                    : null,
            storage: {
                getState: () => storageState,
            },
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/track', () => ({
    trackFriendsProfileView: vi.fn(),
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = Object.assign(
        (selector: (value: typeof storageState) => unknown) => selector(storageState),
        {
            getState: () => storageState,
        },
    );
    return { storage, getStorage: () => storage };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle, testID }: any) => React.createElement('Item', { title, subtitle, testID }),
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: 'Header',
}));

vi.mock('@/components/inbox/cards/FeedItemCard', () => ({
    FeedItemCard: 'FeedItemCard',
}));

vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({
    ApprovalInboxCard: 'ApprovalInboxCard',
}));

vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: ({ children }: any) => React.createElement('RequireFriendsIdentityForFriends', null, children),
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: ({ request }: any) => React.createElement('PermissionPromptCard', { request }),
}));

vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: ({ request }: any) => React.createElement('UserActionPromptCard', { request }),
}));

function collectText(node: renderer.ReactTestRenderer): string[] {
    return node.root
        .findAll((entry) => String(entry.type) === 'Text')
        .map((entry) => String(entry.props.children ?? ''))
        .filter((value) => value.length > 0);
}

describe('InboxView session attention', () => {
    beforeEach(() => {
        pushSpy.mockReset();
    });

    it('renders actionable grouped session attention with machine and path context', async () => {
        const { InboxView } = await import('./InboxView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<InboxView />)).tree;

        expect(tree!.findAllByTestId('inbox.session_attention.session-1')).toHaveLength(1);
        expect(tree!.findAllByType('PermissionPromptCard')).toHaveLength(1);
        expect(tree!.findAllByType('UserActionPromptCard')).toHaveLength(1);

        const text = collectText(tree!);
        expect(text).toContain('Repo session');
        expect(text).toContain('Rebound workstation');
        expect(text).toContain('~/repo');
        expect(text).not.toContain('status.permissionRequired');
    });

    it('renders unread sessions in inbox and does not list shared sessions there', async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');

        vi.doMock('@/sync/domains/state/storage', async () => {
            return createStorageModuleStub({
                useArtifacts: () => [],
                useFriendRequests: () => [],
                useRequestedFriends: () => [],
                useFeedItems: () => [],
                useFeedLoaded: () => true,
                useFriendsLoaded: () => true,
                useAllSessions: () => [
                    {
                        id: 'session-shared',
                        seq: 0,
                        lastViewedSessionSeq: 0,
                        updatedAt: 40,
                        createdAt: 9,
                        active: false,
                        activeAt: 9,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 9,
                        metadata: {
                            name: 'Shared session',
                            path: '/Users/leeroy/shared',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                        owner: 'friend-1',
                        ownerProfile: { username: 'friend', id: 'friend-1', firstName: null, lastName: null, avatar: null },
                    },
                ],
                useAllSessionsForAttention: () => [
                    {
                        id: 'session-shared',
                        seq: 0,
                        lastViewedSessionSeq: 0,
                        updatedAt: 40,
                        createdAt: 9,
                        active: false,
                        activeAt: 9,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 9,
                        metadata: {
                            name: 'Shared session',
                            path: '/Users/leeroy/shared',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                        owner: 'friend-1',
                        ownerProfile: { username: 'friend', id: 'friend-1', firstName: null, lastName: null, avatar: null },
                    },
                ],
                useAllSessionListRenderables: () => [
                    {
                        id: 'session-unread',
                        seq: 5,
                        updatedAt: 50,
                        createdAt: 10,
                        active: false,
                        activeAt: 10,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 10,
                        metadata: {
                            name: 'Unread session',
                            path: '/Users/leeroy/unread',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                        hasUnreadMessages: true,
                    },
                    {
                        id: 'session-shared',
                        seq: 0,
                        updatedAt: 40,
                        createdAt: 9,
                        active: false,
                        activeAt: 9,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 9,
                        metadata: {
                            name: 'Shared session',
                            path: '/Users/leeroy/shared',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                        owner: 'friend-1',
                        hasUnreadMessages: false,
                    },
                ],
                useAllSessionListRenderablesForAttention: () => [
                    {
                        id: 'session-unread',
                        seq: 5,
                        updatedAt: 50,
                        createdAt: 10,
                        active: false,
                        activeAt: 10,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 10,
                        metadata: {
                            name: 'Unread session',
                            path: '/Users/leeroy/unread',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                        hasUnreadMessages: true,
                    },
                    {
                        id: 'session-shared',
                        seq: 0,
                        updatedAt: 40,
                        createdAt: 9,
                        active: false,
                        activeAt: 9,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 9,
                        metadata: {
                            name: 'Shared session',
                            path: '/Users/leeroy/shared',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                        owner: 'friend-1',
                        hasUnreadMessages: false,
                    },
                ],
                useMachine: () => null,
                storage: {
                    getState: () => storageState,
                },
            });
        });

        vi.resetModules();
        const { InboxView } = await import('./InboxView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<InboxView />)).tree;

        const items = tree!.findAllByType('Item');
        expect(items.some((item) => item.props.title === 'Unread session')).toBe(true);
        expect(items.some((item) => item.props.title === 'Shared session')).toBe(false);
    });
});
