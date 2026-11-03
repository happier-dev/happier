import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionFixture, createMachineFixture, createSessionMessagesFixture, createToolCallMessageFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import type { StorageState } from '@/sync/store/types';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';



(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.hoisted(() => vi.fn());
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
        latestFailureSeq: null,
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
    settings: { ...settingsDefaults },
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
                        latestFailureSeq: null,
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
                        latestFailureSeq: null,
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
        const current = primarySession();
        // The latest server row carries the rebound target while the hydrated snapshot is older.
        const newer = createSessionFixture({ ...current, seq: current.seq + 1, metadataVersion: current.metadataVersion + 1,
            metadata: { ...current.metadata!, machineId: 'machine-target' } });
        return { 'server-a': { 'session-1': buildSessionListRenderableFromSession(newer) } };
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
            metadata: { ...createMachineFixture().metadata!, displayName: 'Rebound workstation', host: 'workstation.local' },
        }),
    },
    get machineListByServerId() {
        return { 'server-a': Object.values(this.machines ?? {}) };
    },
    machineListStatusByServerId: { 'server-a': 'idle' },

};

const initialStorageState = storage.getState();
async function renderAttentionScreen(element: React.ReactElement) {
    // Use the production store and selectors over the case's canonical Session/message fixtures.
    storage.setState({ ...initialStorageState, ...storageState }, true);
    return renderScreen(<AppPaneProvider>{element}</AppPaneProvider>);
}

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: pushSpy },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/track/tracking', () => ({ tracking: null }));
// The sync runtime is the network boundary: a visible Session row demands its content through it.
vi.mock('@/sync/sync', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/sync')>(),
    sync: { hydrateSessionListRows: vi.fn(async () => undefined) },
}));

// Load the source dependency closure outside the interaction tests' timeout budget.
await import('./InboxView');

describe('InboxView session attention', () => {
    beforeEach(() => {
        pushSpy.mockReset();
        inboxFixtureState.includeHiddenVoiceTranscriptPermission = false;
        inboxFixtureState.includeHiddenVoiceLateResult = false;
        inboxFixtureState.contentReady = true;
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(initialStorageState, true);
    });

    it('renders actionable grouped session attention with machine and path context', async () => {
        const { InboxView } = await import('./InboxView');

        const screen = await renderAttentionScreen(<InboxView />);
        const tree = screen.tree;

        expect(tree!.findAllByTestId('inbox.session_attention.session-1')).toHaveLength(1);
        expect(tree!.findAllByType(PermissionPromptCard)).toHaveLength(1);
        expect(tree!.findAllByType(UserActionPromptCard)).toHaveLength(1);

        const text = screen.getTextContent();
        expect(text).toContain('Repo session');
        expect(text).toContain('Rebound workstation');
        expect(text).toContain('repo');
        expect(text).not.toContain('status.permissionRequired');
    });

    it('hides retained attention titles, paths and requests when content readiness is unknown', async () => {
        inboxFixtureState.contentReady = false;
        const { InboxView } = await import('./InboxView');
        const screen = await renderAttentionScreen(<InboxView />);
        const tree = screen.tree;
        expect(tree.findAllByTestId('inbox.session_attention.session-1')).toHaveLength(1);
        expect(tree.findAllByType(ItemGroup).some((group) => group.props.title === 'Repo session')).toBe(false);
        expect(screen.getTextContent()).not.toContain('Repo session');
        expect(screen.getTextContent()).not.toContain('~/repo');
        expect(tree.findAllByType(PermissionPromptCard)).toHaveLength(0);
        expect(tree.findAllByType(UserActionPromptCard)).toHaveLength(0);
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
        const screen = await renderAttentionScreen(<InboxSessionAttentionGroupCard
            identityDisplay="none"
            connected={false}
            session={session}
            serverId="home-b"
            contextLine={null}
            permissionRequests={[]}
            userActionRequests={[]}
        />);
        const text = screen.getTextContent();
        expect(text).toContain('Home B session');
        expect(text).not.toContain('~/project');
        expect(text).not.toContain('/Users/leeroy/repo');
    });

    it('renders a transcript-only hidden Voice permission as an actionable Inbox card', async () => {
        inboxFixtureState.includeHiddenVoiceTranscriptPermission = true;
        const { InboxView } = await import('./InboxView');

        const screen = await renderAttentionScreen(<InboxView />);
        const tree = screen.tree;

        const hiddenVoiceCard = tree.findByTestId('inbox.session_attention.hidden-voice');
        expect(hiddenVoiceCard).not.toBeNull();
        if (!hiddenVoiceCard) {
            throw new Error('Expected hidden Voice permission card.');
        }
        expect(
            tree.findAllByType(PermissionPromptCard)
                .some((card) => card.props.request.id === 'hidden-voice-permission'),
        ).toBe(true);

        await tree.pressByTestIdAsync('inbox.session_attention.server-a.hidden-voice');
        expect(pushSpy).toHaveBeenCalledWith('/session/hidden-voice?serverId=server-a');
    });

    it('navigates an unread hidden post-Voice result to its exact scoped session', async () => {
        inboxFixtureState.includeHiddenVoiceLateResult = true;
        const { InboxView } = await import('./InboxView');

        const screen = await renderAttentionScreen(<InboxView />);
        const tree = screen.tree;
        // A finished result to read lives in the Inbox's Updates view (ORC R-10, lab `inbox-I1`).
        const updatesTab = tree.findByTestId('inbox.view:updates');
        if (!updatesTab) throw new Error('Expected the Inbox Updates view tab.');
        await renderer.act(async () => {
            updatesTab.props.onPress?.();
        });
        const lateResultItem = tree.findByTestId('inbox.ready_session.server-a.hidden-voice-late-result');
        expect(screen.getTextContent()).toContain('Global Voice late result');
        expect(lateResultItem).not.toBeNull();
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
