import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: unknown) => value },
    useUnistyles: () => ({
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
    }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/track', () => ({
    trackFriendsProfileView: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();

    return {
        ...actual,
        useArtifacts: () => [],
        useFriendRequests: () => [],
        useRequestedFriends: () => [],
        useFeedItems: () => [],
        useFeedLoaded: () => true,
        useFriendsLoaded: () => true,
        useAllSessions: () => [
            {
                id: 'session-1',
                presence: 'online',
                metadata: {
                    name: 'Repo session',
                    path: '/Users/leeroy/repo',
                    homeDir: '/Users/leeroy',
                    machineId: 'machine-1',
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
        useMachine: (machineId: string) =>
            machineId === 'machine-1'
                ? {
                      id: 'machine-1',
                      metadata: { displayName: 'Workstation', host: 'workstation.local' },
                  }
                : null,
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const state = {
        profile: { id: 'me' },
        sessionMessages: {
            'session-1': { messages: [] },
        },
    };
    const storage = Object.assign(
        (selector: (value: typeof state) => unknown) => selector(state),
        {
            getState: () => state,
        },
    );
    return { storage, getStorage: () => storage };
});

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
        await act(async () => {
            tree = renderer.create(<InboxView />);
        });

        expect(tree!.root.findAllByProps({ testID: 'inbox.session_attention.session-1' })).toHaveLength(1);
        expect(tree!.root.findAllByType('PermissionPromptCard')).toHaveLength(1);
        expect(tree!.root.findAllByType('UserActionPromptCard')).toHaveLength(1);

        const text = collectText(tree!);
        expect(text).toContain('Repo session');
        expect(text).toContain('Workstation');
        expect(text).toContain('~/repo');
        expect(text).not.toContain('status.permissionRequired');
    });
});
