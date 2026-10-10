import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createMachineFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import type { StorageState } from '@/sync/store/types';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();
const pendingRequestObservedAt = Date.now();
const inboxFixtureState = vi.hoisted(() => ({
    includeHiddenVoiceTranscriptPermission: false,
    includeHiddenVoiceLateResult: false,
    contentReady: true,
}));
const primarySession = () => createSessionFixture({
    id: 'session-1',
    serverId: 'server-a',
    encryptionMode: inboxFixtureState.contentReady ? 'plain' : 'e2ee',
    encryptedContentAvailability: inboxFixtureState.contentReady ? 'ready' : undefined,
    active: true,
    presence: 'online',
    metadata: {
        name: 'Repo session',
        host: 'stale.local',
        path: '/Users/leeroy/repo',
        homeDir: '/Users/leeroy',
        machineId: 'machine-stale',
    },
    agentState: {
        controlledByUser: null,
        requests: {
            perm_1: {
                tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' },
                createdAt: pendingRequestObservedAt - 1,
            },
            ask_1: {
                tool: 'AskUserQuestion', kind: 'user_action',
                arguments: { questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Proceed' }] }] },
                createdAt: pendingRequestObservedAt,
            },
        },
        completedRequests: {},
    },
    viewer: {
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        follow: { follows: false, notificationLevel: null },
        notification: { level: 'important', source: 'owner' },
        attention: {
            needsAttention: true,
            reasons: ['permission_required', 'user_action_required'],
            primary: 'permission_required',
            presentation: inboxFixtureState.contentReady ? 'full' : 'status_only',
        },
    },
});
const storageState: Partial<StorageState> = {
    workflowRunsById: {},
    workflowRunListWindows: {},
    profile: { ...profileDefaults, id: 'me' },
    settings: { ...settingsDefaults, workspacePathDisplayModeV1: 'name' },
    sessionMessages: {
        'session-1': createSessionMessagesFixture(),
        'hidden-voice': createSessionMessagesFixture({
            messageIdsOldestFirst: ['hidden-voice-tool-message'],
            messagesById: {
                'hidden-voice-tool-message': createToolCallMessageFixture({
                    id: 'hidden-voice-tool-message',
                    localId: null,
                    createdAt: pendingRequestObservedAt,
                    children: [],
                    tool: {
                        id: 'hidden-voice-permission',
                        name: 'Bash',
                        state: 'running',
                        input: { command: 'git status' },
                        createdAt: pendingRequestObservedAt,
                        startedAt: pendingRequestObservedAt,
                        completedAt: null,
                        description: 'Inspect repository status',
                        permission: {
                            id: 'hidden-voice-permission',
                            status: 'pending',
                            kind: 'permission',
                        },
                    },
                }),
            },
        }),
        'hidden-voice-late-result': createSessionMessagesFixture(),
    },
    get sessions() {
        return {
            'session-1': primarySession(),
            ...(inboxFixtureState.includeHiddenVoiceTranscriptPermission ? {
                'hidden-voice': createSessionFixture({
                    id: 'hidden-voice', serverId: 'server-a', encryptionMode: 'plain', active: true,
                    presence: 'online', pendingPermissionRequestCount: 1,
                    metadata: {
                        name: 'Hidden Voice session', host: 'stale.local', path: '/Users/leeroy/repo', homeDir: '/Users/leeroy', machineId: 'machine-stale',
                        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                    },
                    viewer: {
                        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                        relevance: { relevant: true, reasons: ['owned_by_me'] },
                        follow: { follows: false, notificationLevel: null },
                        notification: { level: 'important', source: 'owner' },
                        attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' },
                    },
                }),
            } : {}),
            ...(inboxFixtureState.includeHiddenVoiceLateResult ? {
                'hidden-voice-late-result': createSessionFixture({
                    id: 'hidden-voice-late-result', serverId: 'server-a', encryptionMode: 'plain', active: false,
                    presence: 1, seq: 2, latestReadyEventSeq: 2,
                    metadata: {
                        name: 'Global Voice late result', host: 'stale.local', path: '/Users/leeroy/repo', homeDir: '/Users/leeroy', machineId: 'machine-stale',
                        systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
                    },
                    viewer: {
                        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 2 },
                        relevance: { relevant: true, reasons: ['owned_by_me'] },
                        follow: { follows: false, notificationLevel: null },
                        notification: { level: 'important', source: 'owner' },
                        attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
                    },
                }),
            } : {}),
        };
    },
    get sessionListRowsByServerId() {
        return { 'server-a': { 'session-1': buildSessionListRenderableFromSession(primarySession()) } };
    },
    ordinarySessionListMembershipByServerId: { 'server-a': ['session-1'] },
    sessionListIndexByServerId: {
        'server-a': [{ type: 'session', serverId: 'server-a', sessionId: 'session-1', groupKey: 'active', groupKind: 'active' }],
    },
    concurrentSessionListCacheByServerId: {},
    isDataReady: true,
    machines: {
        'machine-stale': createMachineFixture({
            id: 'machine-stale',
            active: false,
            activeAt: 1,
            replacedByMachineId: 'machine-target',
            replacedAt: 2,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            metadata: { ...createMachineFixture().metadata!, host: 'stale.local' },
        }),
        'machine-target': createMachineFixture({
            id: 'machine-target',
            active: true,
            activeAt: 10,
            metadata: { ...createMachineFixture().metadata!, host: 'workstation.local' },
        }),
    },
    getProjectForSession: (sessionId: string) =>
        sessionId === 'session-1'
            ? {
                id: 'project-1', sessionIds: ['session-1'], createdAt: 1, updatedAt: 1,
                key: {
                    serverId: 'server-a',
                    machineId: 'machine-target',
                    rootPath: '/Users/leeroy/repo',
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
        const { createStorageModuleStub, createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
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
                    encryptionMode: inboxFixtureState.contentReady ? 'plain' : undefined,
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
                                createdAt: pendingRequestObservedAt - 1,
                            },
                            ask_1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Proceed' }] }],
                                },
                                createdAt: pendingRequestObservedAt,
                            },
                        },
                        completedRequests: {},
                    },
                },
            ],
            useAllSessionsForAttention: () => [
                {
                    id: 'session-1',
                    encryptionMode: inboxFixtureState.contentReady ? 'plain' : undefined,
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
                                createdAt: pendingRequestObservedAt - 1,
                            },
                            ask_1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [{ question: 'Continue?', header: 'Confirm', options: [{ label: 'Yes', description: 'Proceed' }] }],
                                },
                                createdAt: pendingRequestObservedAt,
                            },
                        },
                        completedRequests: {},
                    },
                },
                ...(inboxFixtureState.includeHiddenVoiceTranscriptPermission
                    ? [{
                        id: 'hidden-voice',
                        encryptionMode: 'plain',
                        serverId: 'server-a',
                        seq: 1,
                        lastViewedSessionSeq: 1,
                        updatedAt: pendingRequestObservedAt,
                        createdAt: pendingRequestObservedAt,
                        active: true,
                        activeAt: pendingRequestObservedAt,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                        metadata: {
                            name: 'Hidden Voice session',
                            path: '/Users/leeroy/repo',
                            homeDir: '/Users/leeroy',
                            machineId: 'machine-stale',
                            systemSessionV1: {
                                v: 1,
                                key: 'voice_conversation',
                                hidden: true,
                            },
                        },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        pendingPermissionRequestCount: 1,
                        pendingRequestObservedAt,
                    }]
                    : []),
                ...(inboxFixtureState.includeHiddenVoiceLateResult
                    ? [{
                        id: 'hidden-voice-late-result',
                        encryptionMode: 'plain',
                        serverId: 'server-a',
                        seq: 2,
                        lastViewedSessionSeq: 1,
                        latestReadyEventSeq: 2,
                        updatedAt: pendingRequestObservedAt + 1,
                        createdAt: pendingRequestObservedAt,
                        active: false,
                        activeAt: pendingRequestObservedAt,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'offline',
                        metadata: {
                            name: 'Global Voice late result',
                            path: '/Users/leeroy/repo',
                            homeDir: '/Users/leeroy',
                            machineId: 'machine-stale',
                            systemSessionV1: {
                                v: 1,
                                key: 'voice_conversation_retired',
                                hidden: true,
                            },
                        },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        pendingPermissionRequestCount: 0,
                        pendingRequestObservedAt: null,
                    }]
                    : []),
            ],
            useAllSessionListRenderables: () => [
                {
                    id: 'session-1',
                    encryptionMode: inboxFixtureState.contentReady ? 'plain' : undefined,
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
                    encryptionMode: inboxFixtureState.contentReady ? 'plain' : undefined,
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
            useAllSessionListAttentionRows: () => [
                {
                    session: {
                        id: 'session-1',
                        encryptionMode: inboxFixtureState.contentReady ? 'plain' : undefined,
                        active: true,
                        presence: 'online',
                        metadata: {
                            name: 'Repo session',
                            path: '/Users/leeroy/repo',
                            homeDir: '/Users/leeroy',
                            machineId: 'machine-stale',
                        },
                        hasUnreadMessages: false,
                    },
                    serverId: null,
                    serverName: null,
                },
            ],
            useMachine: (machineId: string) =>
                machineId === 'machine-target'
                    ? {
                        id: 'machine-target',
                        metadata: { displayName: 'Rebound workstation', host: 'workstation.local' },
                    }
                    : null,
            useServerScopedMachine: (_serverId: string | null, machineId: string) =>
                machineId === 'machine-stale'
                    ? {
                        id: 'machine-target',
                        metadata: { displayName: 'Rebound workstation', host: 'workstation.local' },
                    }
                    : null,
            // These fixtures expose changing getters, rather than an immutable
            // Zustand snapshot. Read them live instead of caching the first case.
            storage: createLiveStorageStoreMock(() => storageState),
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
    Item: ({ title, subtitle, testID, ...props }: any) => React.createElement('Item', {
        title,
        subtitle,
        testID,
        ...props,
    }),
}));

vi.mock('@/components/ui/cards/UserCard', () => ({
    UserCard: 'UserCard',
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
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
    useLayoutMaxWidth: () => 960,
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

// Load the source dependency closure outside the interaction tests' timeout budget.
await import('./InboxView');

describe('InboxView session attention', () => {
    beforeEach(() => {
        pushSpy.mockReset();
        inboxFixtureState.includeHiddenVoiceTranscriptPermission = false;
        inboxFixtureState.includeHiddenVoiceLateResult = false;
        inboxFixtureState.contentReady = true;
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
        expect(text).toContain('repo');
        expect(text).not.toContain('status.permissionRequired');
    });

    it('hides retained attention titles, paths and requests when content readiness is unknown', async () => {
        inboxFixtureState.contentReady = false;
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;
        expect(tree.findAllByTestId('inbox.session_attention.session-1')).toHaveLength(1);
        expect(tree.findAllByType('ItemGroup').some((group) => group.props.title === 'Repo session')).toBe(false);
        expect(collectText(tree)).not.toContain('Repo session');
        expect(collectText(tree)).not.toContain('~/repo');
        expect(tree.findAllByType('PermissionPromptCard')).toHaveLength(0);
        expect(tree.findAllByType('UserActionPromptCard')).toHaveLength(0);
    });

    it('keeps a qualified card out of a same-id session on another Home', async () => {
        const { InboxSessionAttentionGroupCard } = await import('@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard');
        const session = createSessionFixture({
            id: 'session-1',
            serverId: 'home-b',
            encryptionMode: 'plain',
            active: true,
            presence: 'online',
            metadata: { name: 'Home B session', host: 'home-b-host', path: '/home/b/project', homeDir: '/home/b', machineId: 'machine-b' },
        });
        const tree = (await renderScreen(<InboxSessionAttentionGroupCard
            identityDisplay="none"
            connected={false}
            session={session}
            serverId="home-b"
            contextLine={null}
            permissionRequests={[]}
            userActionRequests={[]}
        />)).tree;
        const text = collectText(tree);
        expect(text).toContain('Home B session');
        expect(text).not.toContain('~/project');
        expect(text).not.toContain('/Users/leeroy/repo');
    });

    it('renders a transcript-only hidden Voice permission as an actionable Inbox card', async () => {
        inboxFixtureState.includeHiddenVoiceTranscriptPermission = true;
        const { InboxView } = await import('./InboxView');

        const tree = (await renderScreen(<InboxView />)).tree;

        const hiddenVoiceCard = tree.findByTestId('inbox.session_attention.hidden-voice');
        expect(hiddenVoiceCard).not.toBeNull();
        if (!hiddenVoiceCard) {
            throw new Error('Expected hidden Voice permission card.');
        }
        expect(
            tree.findAllByType('PermissionPromptCard')
                .some((card) => card.props.request.id === 'hidden-voice-permission'),
        ).toBe(true);

        await renderer.act(async () => {
            hiddenVoiceCard.findByType('Pressable').props.onPress();
        });
        expect(pushSpy).toHaveBeenCalledWith('/session/hidden-voice?serverId=server-a');
    });

    it('navigates an unread hidden post-Voice result to its exact scoped session', async () => {
        inboxFixtureState.includeHiddenVoiceLateResult = true;
        const { InboxView } = await import('./InboxView');

        const tree = (await renderScreen(<InboxView />)).tree;
        // A finished result to read lives in the Inbox's Updates view (ORC R-10, lab `inbox-I1`).
        const updatesTab = tree.findByTestId('inbox.view:updates');
        if (!updatesTab) throw new Error('Expected the Inbox Updates view tab.');
        await renderer.act(async () => {
            updatesTab.props.onPress?.();
        });
        const lateResultItem = tree.findAllByType('Item')
            .find((item) => item.props.title === 'Global Voice late result');
        expect(lateResultItem).toBeDefined();
        if (!lateResultItem) {
            throw new Error('Expected hidden Voice late-result Inbox item.');
        }

        await renderer.act(async () => {
            lateResultItem.props.onPress();
        });

        expect(pushSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith(
            '/session/hidden-voice-late-result?serverId=server-a',
        );
    });

});
