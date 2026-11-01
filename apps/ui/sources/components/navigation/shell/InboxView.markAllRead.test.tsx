import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/sessions/shell/useSessionScreenIsFocused', () => ({
    useSessionScreenIsFocused: () => true,
}));

// The canonical read executor is `sessionSetManualReadStateWithServerScope`; every Inbox
// mark-read surface (Ready-section mark-all and per-row control) must reach the network through it,
// so this suite mocks only that ops boundary and counts the exact server-scoped writes.
const markReadOps = vi.hoisted(() => ({
    calls: [] as Array<{ sessionId: string; readState: string; serverId: string | null }>,
    deferred: [] as Array<(result: { success: boolean }) => void>,
    mode: 'immediate' as 'immediate' | 'deferred' | 'failure',
}));

const alerts = vi.hoisted(() => ({ titles: [] as string[] }));
const navigation = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn() }));
let includeBackgroundPending = false;

function unreadHydratedSession(id: string, serverId?: string) {
    return {
        id,
        ...(serverId ? { serverId } : {}),
        seq: 2,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'offline' as const,
        metadata: {
            name: serverId ? 'Server session' : 'Local session',
            path: '/Users/leeroy/repo',
            homeDir: '/Users/leeroy',
            machineId: 'machine-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        owner: null,
        hasUnreadMessages: true,
        // Inbox intentionally owns terminal review rows rather than every raw
        // unread session. This fixture represents the terminal event that makes
        // an unread session reviewable.
        latestTurnStatus: 'completed' as const,
        latestTurnStatusObservedAt: 2,
        latestReadyEventSeq: 2,
    };
}

function unreadRenderableRow(id: string, name: string) {
    return {
        id,
        seq: 2,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name,
            path: '/Users/leeroy/repo',
            homeDir: '/Users/leeroy',
            machineId: 'machine-1',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'offline' as const,
        hasUnreadMessages: true,
    };
}

const serverSession = unreadHydratedSession('session-a', 'server-a');
const localSession = unreadHydratedSession('session-local');
const storageState = {
    profile: { id: 'me' },
    sessionMessages: {},
    sessions: {
        'session-a': serverSession,
        'session-local': localSession,
    },
    machines: {},
};

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: navigation }).module;
    },
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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (title: string) => {
                    alerts.titles.push(title);
                },
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const storage = Object.assign(
            (selector: (value: typeof storageState) => unknown) => selector(storageState),
            { getState: () => storageState },
        );
        return createStorageModuleStub({
            useArtifacts: () => [],
            useFriendRequests: () => [],
            useRequestedFriends: () => [],
            useFeedItems: () => [],
            useFeedLoaded: () => true,
            useFriendsLoaded: () => true,
            useAllSessions: () => [serverSession, localSession],
            useAllSessionsForAttention: () => [serverSession, localSession],
            useAllSessionListRenderables: () => [
                unreadRenderableRow('session-a', 'Server session'),
                unreadRenderableRow('session-local', 'Local session'),
            ],
            useAllSessionListRenderablesForAttention: () => [
                unreadRenderableRow('session-a', 'Server session'),
                unreadRenderableRow('session-local', 'Local session'),
            ],
            useSessionListViewDataByServerId: () => includeBackgroundPending ? {
                'server-background': [
                    { type: 'header', title: 'Background', serverId: 'server-background' },
                    {
                        type: 'session',
                        serverId: 'server-background',
                        session: {
                            ...unreadRenderableRow('session-failed', 'Failed session'),
                            active: true,
                            hasUnreadMessages: false,
                            latestTurnStatus: 'failed',
                            latestTurnStatusObservedAt: Date.now(),
                            lastRuntimeIssue: {
                                v: 1,
                                scope: 'primary_session',
                                status: 'failed',
                                source: 'stream_error',
                                code: 'provider_error',
                                occurredAt: Date.now(),
                            },
                        },
                    },
                    {
                        type: 'session',
                        serverId: 'server-background',
                        session: {
                            ...unreadRenderableRow('session-background', 'Background attention'),
                            hasUnreadMessages: false,
                            hasPendingPermissionRequests: true,
                            pendingRequestObservedAt: Date.now(),
                            active: true,
                            presence: 'online',
                            latestTurnStatus: 'in_progress',
                            latestTurnStatusObservedAt: Date.now(),
                        },
                    },
                ],
            } : {},
            useMachine: () => null,
            storage,
            getStorage: () => storage,
        });
    },
});

// The model now reads its canonical source from the store rather than the
// legacy selector helpers above. Keep the test's store fixture on that same
// boundary so the rendered Inbox receives the sessions it describes.
vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = Object.assign(
        (selector: (value: typeof storageState) => unknown) => selector(storageState),
        { getState: () => storageState },
    );
    return { storage, getStorage: () => storage };
});

vi.mock('@/sync/ops', async (importOriginal) => {
    const { installSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return installSyncOpsModuleMock({
        // Test-boundary fixture: the real ops signature is mirrored; only the network
        // response is replaced so the suite can defer and fail it deterministically.
        sessionSetManualReadStateWithServerScope: (async (
            sessionId: string,
            readState: string,
            options?: { serverId?: string | null },
        ) => {
            markReadOps.calls.push({ sessionId, readState, serverId: options?.serverId ?? null });
            if (markReadOps.mode === 'failure') return { success: false, message: 'denied' };
            if (markReadOps.mode === 'immediate') return { success: true };
            return await new Promise<{ success: boolean }>((resolve) => {
                markReadOps.deferred.push(resolve);
            });
        }) as never,
    })(importOriginal as <T>() => Promise<T>);
});

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: React.forwardRef(({ children, ...props }: any, _ref) => (
        React.createElement('Swipeable', props, children)
    )),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/track', () => ({ trackFriendsProfileView: vi.fn() }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/sessions/shell/SessionListIdentity', () => ({
    SessionListIdentity: 'SessionListIdentity',
    useSessionListIdentityDisplay: () => 'none',
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, title, children),
}));
vi.mock('@/components/ui/selectionList', () => ({
    SelectionListSectionHeader: ({ title, rightAccessory, testID }: any) => (
        React.createElement('SelectionListSectionHeader', { title, testID }, rightAccessory)
    ),
}));
// Pass-through row: keep the row's `rightElement` (the mark-read control) in the rendered
// tree so this suite can exercise it from the screen boundary.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ rightElement, children, ...props }: any) => (
        React.createElement('Item', props, children, rightElement)
    ),
}));
vi.mock('@/components/ui/cards/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));
// Rendered, not stubbed away: the mark-all action lives in the header slot and this suite
// is about that action.
vi.mock('@/components/navigation/Header', () => ({
    Header: ({ title, headerLeft, headerRight }: any) => React.createElement(
        'Header',
        null,
        title,
        headerLeft?.(),
        headerRight?.(),
    ),
}));
vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({ ApprovalInboxCard: 'ApprovalInboxCard' }));
vi.mock('@/components/inbox/actionOperations/ActionOperationLedger', () => ({
    ActionOperationLedger: 'ActionOperationLedger',
}));
vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: 'PermissionPromptCard',
}));
vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: 'UserActionPromptCard',
}));
vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));
vi.mock('@/hooks/server/useFriendsEnabled', () => ({ useFriendsEnabled: () => false }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
    useLayoutMaxWidth: () => 960,
}));

function nodesByTestId(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAll((node) => (node.props as { testID?: string } | undefined)?.testID === testID);
}

async function press(node: { props: { onPress?: (event?: unknown) => void } }): Promise<void> {
    await act(async () => {
        // Row-level handlers stop propagation on the gesture event, so press with a
        // well-formed event like a real responder would deliver.
        node.props.onPress?.({ stopPropagation: () => {} });
    });
}

describe('InboxView mark as read', () => {
    beforeEach(() => {
        markReadOps.calls = [];
        markReadOps.deferred = [];
        markReadOps.mode = 'immediate';
        alerts.titles = [];
        includeBackgroundPending = false;
        navigation.navigate.mockReset();
        navigation.push.mockReset();
    });

    it('exposes mark-all in the ready-for-review section instead of the screen header', async () => {
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [markAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        expect(markAll).toBeDefined();
        expect(markAll!.props.accessibilityRole).toBe('button');
        expect(markAll!.props.accessibilityLabel).toBe('inbox.markAllRead');
        expect(markAll!.props.accessibilityState).toEqual({ disabled: false, busy: false });
        expect(markAll!.props.hitSlop).toBe(17);
        expect(nodesByTestId(tree, 'inbox.section.ready')).toHaveLength(1);
        let ancestor = markAll!.parent;
        while (ancestor && ancestor.props.testID !== 'inbox.section.ready') ancestor = ancestor.parent;
        expect(ancestor?.props.testID).toBe('inbox.section.ready');

        const [readyRow] = nodesByTestId(tree, 'inbox.review_session.server-a.session-a');
        expect(readyRow!.props.subtitle).toContain('status.readyForReview');
        expect(readyRow!.props.detail).toBeUndefined();
    });

    it('marks every unread session at its exact server scope through the canonical executor', async () => {
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        // The test double exposes both its composite and host instances to the
        // renderer; only the row's presence is the screen contract.
        expect(nodesByTestId(tree, 'inbox.review_session.server-a.session-a')).not.toHaveLength(0);
        expect(nodesByTestId(tree, 'inbox.review_session.local.session-local')).not.toHaveLength(0);

        const [markAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        await press(markAll!);

        expect(markReadOps.calls).toEqual([
            { sessionId: 'session-a', readState: 'read', serverId: 'server-a' },
            { sessionId: 'session-local', readState: 'read', serverId: null },
        ]);
        expect(alerts.titles).toEqual([]);
    });

    it('places Ready before Needs attention with one grouped surface per section', async () => {
        includeBackgroundPending = true;
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const sectionIds = tree.root
            .findAll((node) => typeof node.props.testID === 'string' && /^inbox\.section\.[^.]+$/.test(node.props.testID))
            .map((node) => node.props.testID);
        expect(sectionIds).toEqual([
            'inbox.section.errors',
            'inbox.section.ready',
            'inbox.section.needs-attention',
        ]);
        expect(tree.root.findAllByType('ItemGroup')).toHaveLength(3);
    });

    it('routes the row-level mark-read through the same executor at its own server scope', async () => {
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [rowAction] = nodesByTestId(tree, 'inbox.review_session.server-a.session-a.mark_read');
        expect(rowAction).toBeDefined();
        expect(rowAction!.props.accessibilityRole).toBe('button');
        expect(rowAction!.props.accessibilityLabel).toBe('sessionInfo.markSessionRead');
        await press(rowAction!);

        expect(markReadOps.calls).toEqual([
            { sessionId: 'session-a', readState: 'read', serverId: 'server-a' },
        ]);
    });

    it('opens an unread row through the exact Home-scoped canonical session route', async () => {
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [serverRow] = nodesByTestId(tree, 'inbox.review_session.server-a.session-a');
        await press(serverRow!);

        expect(navigation.push).toHaveBeenCalledWith('/session/session-a?serverId=server-a');
    });

    it('opens payload-free background attention at its exact Home scope', async () => {
        includeBackgroundPending = true;
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [backgroundRow] = nodesByTestId(tree, 'inbox.session_attention.server-background.session-background');
        expect(backgroundRow).toBeDefined();
        await press(backgroundRow!);

        expect(navigation.push).toHaveBeenCalledWith('/session/session-background?serverId=server-background');
    });

    it('shows a truthful busy state on the header while marks are still settling', async () => {
        markReadOps.mode = 'deferred';
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [markAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        await press(markAll!);
        expect(markReadOps.calls).toHaveLength(2);

        const [pendingMarkAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        expect(pendingMarkAll!.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(
            pendingMarkAll!.findAll((node) => String(node.type) === 'ActivitySpinner'),
        ).toHaveLength(1);

        await act(async () => {
            for (const resolve of markReadOps.deferred) resolve({ success: true });
            markReadOps.deferred = [];
        });

        const [settledMarkAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        expect(settledMarkAll!.props.accessibilityState).toEqual({ disabled: false, busy: false });
        expect(alerts.titles).toEqual([]);
    });

    it('does not submit a row twice when mark-all is pressed while its mark is pending', async () => {
        markReadOps.mode = 'deferred';
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [rowAction] = nodesByTestId(tree, 'inbox.review_session.server-a.session-a.mark_read');
        await press(rowAction!);
        const [markAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        // One row settling must not block clearing the remaining unread rows.
        expect(markAll!.props.disabled).toBe(false);
        expect(markAll!.props.accessibilityState).toEqual({ disabled: false, busy: false });
        await press(markAll!);

        expect(markReadOps.calls).toEqual([
            { sessionId: 'session-a', readState: 'read', serverId: 'server-a' },
            { sessionId: 'session-local', readState: 'read', serverId: null },
        ]);

        await act(async () => {
            for (const resolve of markReadOps.deferred) resolve({ success: true });
            markReadOps.deferred = [];
        });
    });

    it('reports a failed mark instead of silently leaving rows unread', async () => {
        markReadOps.mode = 'failure';
        const { InboxView } = await import('./InboxView');
        const tree = (await renderScreen(<InboxView />)).tree;

        const [markAll] = nodesByTestId(tree, 'inbox.mark_all_read');
        await press(markAll!);

        expect(markReadOps.calls).toHaveLength(2);
        expect(alerts.titles).toEqual(['common.error']);
    });
});
