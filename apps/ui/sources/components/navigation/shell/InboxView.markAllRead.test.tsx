import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createInboxItemRoute } from '@/components/inbox/inboxItemFocus';
import { getActiveServerId, listServerProfiles, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

installDisconnectedServerSocketBoundary();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ titles: [] as string[] }));
const routeParams = vi.hoisted(() => ({ item: undefined as string | string[] | undefined }));
let harness: Awaited<ReturnType<typeof serveActionHomes>>;
const readAnswers = new Map<string, { status?: number; body: unknown; respondAfter?: Promise<void> }>();
let homeA = '';
let homeB = '';
const readStatePath = '/v2/sessions/session-x/read-state';
const initialServerId = getActiveServerId();
const initialProfileIds = new Set(listServerProfiles().map(profile => profile.id));

function readRequests() {
    return harness.requests.filter(({ path }) => path === readStatePath).map(({ home, body }) => ({
        serverId: harness.homes[home].id,
        input: body,
    }));
}

function answerReadState(serverId: string, respondAfter?: Promise<void>) {
    const viewer = unreadSession(serverId).viewer;
    if (!viewer) throw new Error('Expected a private viewer fixture');
    readAnswers.set(serverId, {
        respondAfter,
        body: {
            success: true, state: 'read', lastViewedSessionSeq: 2, didChange: true,
            viewer: {
                ...viewer,
                readState: { state: 'tracking', lastViewedSessionSeq: 2, unreadSince: null },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            },
        },
    });
}

function unreadSession(serverId: string) {
    return createSessionFixture({
        id: 'session-x',
        serverId,
        encryptionMode: 'plain',
        active: false,
        presence: 1,
        seq: 2,
        latestReadyEventSeq: 2,
        metadata: {
            name: `Session on ${serverId}`,
            host: 'tester.local',
            path: '/Users/leeroy/repo',
            homeDir: '/Users/leeroy',
            machineId: 'machine-1',
        },
        viewer: {
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 2 },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
            attention: {
                needsAttention: true,
                reasons: ['unread'],
                primary: 'unread',
                presentation: 'full',
            },
        },
    });
}

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams }).module;
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
    // Exercise both the Inbox model and the Action executor with the real store.
    storage: async (importOriginal) => importOriginal(),
});

// Configure the shared boundaries before these imports can initialize their store graph.
const { storage } = await import('@/sync/domains/state/storageStore');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const initialStorageState = storage.getState();

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
// Analytics leaves the process; the real module retains every Sync lifecycle export.
vi.mock('@/track/tracking', () => ({ tracking: null }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/icons/Icon')>(),
    Icon: 'Icon',
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: 'ActivitySpinner',
    iconMatchedSpinnerSize: () => 'small',
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    // Like the real section, the header's `action` slot renders beside the title.
    ItemGroup: ({ children, title, action }: any) => React.createElement('ItemGroup', { title }, action, children),
}));
// Accessory slots must render: the per-row mark-read control lives in
// `rightElement`, and a passthrough would leave it as an inert prop.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ children, leftElement, rightElement, ...props }: any) => React.createElement(
        'Item',
        props,
        leftElement,
        rightElement,
        children,
    ),
}));
vi.mock('@/components/ui/cards/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));
// Rendered, not stubbed away: the mark-all action lives in the header slot and
// this suite is about that action.
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

/** Module init for the whole Inbox tree is the cost here, not the assertions. */
const SLOW_RENDER_TIMEOUT_MS = 240_000;

/** Host nodes only: a composite and the host it renders both carry `testID`. */
function nodesByTestId(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAll((node) => (
        typeof node.type === 'string'
        && (node.props as { testID?: string } | undefined)?.testID === testID
    ));
}

async function press(node: { props: { onPress?: () => void } }): Promise<void> {
    await act(async () => {
        node.props.onPress?.();
    });
}

/** Finished sessions to read live under the Inbox's Updates view (lab `inbox-I1`). */
async function renderUpdates(InboxView: React.ComponentType) {
    const tree = (await renderScreen(<InboxView />)).tree;
    const [updatesTab] = nodesByTestId(tree, 'inbox.view:updates');
    await press(updatesTab);
    return tree;
}

// Load the graph outside hook deadlines; per-test setup below still restores its bridge.
await loadSyncSingletonForTests();

describe('InboxView mark as read', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        storage.setState(initialStorageState, true);
        readAnswers.clear();
        alerts.titles = [];
        routeParams.item = undefined;
        harness = await serveActionHomes({
            homes: [
                { key: 'b', serverUrl: 'https://inbox-b.test', accountId: 'me' },
                { key: 'a', serverUrl: 'https://inbox-a.test', accountId: 'me' },
            ],
            route: ({ home, path }) => {
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path !== readStatePath) return undefined;
                const answer = readAnswers.get(harness.homes[home].id);
                if (!answer) return undefined;
                return Promise.resolve(answer.respondAfter).then(() => Response.json(answer.body, { status: answer.status ?? 200 }));
            },
        });
        homeB = harness.homes.b.id;
        homeA = harness.homes.a.id;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(harness.homes.a.serverUrl);
        if (!credentials) throw new Error('Expected the focused Home credential fixture');
        await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(credentials);
        answerReadState(homeA);
        answerReadState(homeB);
        storage.setState({
            profileScope: { serverId: homeA, accountId: 'me' },
            settingsScope: { serverId: homeA, accountId: 'me' },
            sessions: { 'session-x': unreadSession(homeA) },
            sessionMessages: {},
            sessionListRowsByServerId: {
                [homeA]: { 'session-x': unreadSession(homeA) },
                [homeB]: { 'session-x': unreadSession(homeB) },
            },
            ordinarySessionListMembershipByServerId: { [homeA]: ['session-x'], [homeB]: ['session-x'] },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            artifacts: {},
            friends: {},
            isDataReady: true,
        });
    });

    afterEach(async () => {
        standardCleanup();
        await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        harness?.dispose();
        await setActiveServerId(initialServerId);
        for (const id of [homeA, homeB]) if (id && !initialProfileIds.has(id)) await removeServerProfile(id);
        storage.setState(initialStorageState, true);
    });

    it('uses the route item as the only row focus and reopens Needs you when it changes', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const unread = unreadSession(homeA);
        if (!unread.viewer) throw new Error('Expected a private viewer fixture');
        const focused = createSessionFixture({
            id: 'needs-focus', serverId: homeA, encryptionMode: 'plain',
            viewer: {
                ...unread.viewer,
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                attention: { needsAttention: true, reasons: ['manual'], primary: 'manual', presentation: 'full' },
            },
        });
        storage.setState((state) => ({
            sessions: { ...state.sessions, [focused.id]: focused },
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [homeA]: { ...state.sessionListRowsByServerId[homeA], [focused.id]: focused },
            },
            ordinarySessionListMembershipByServerId: { [homeA]: ['session-x', focused.id], [homeB]: ['session-x'] },
        }));
        const { InboxPage } = await import('@/app/(app)/inbox/index');
        const screen = await renderScreen(<InboxPage />);
        await press(nodesByTestId(screen.tree, 'inbox.view:updates')[0]);
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')).toHaveLength(0);

        routeParams.item = [createInboxItemRoute({ kind: 'session', serverId: homeA, id: 'needs-focus' }).params.item];
        await screen.update(<InboxPage />);
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')[0]?.props.selected).toBe(true);
        await press(nodesByTestId(screen.tree, 'inbox.view:updates')[0]);
        await screen.update(<InboxPage />);
        // A render with the same item preserves the person's chosen Updates tab.
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')).toHaveLength(0);

        routeParams.item = createInboxItemRoute({ kind: 'session', serverId: homeA, id: 'missing' }).params.item;
        await screen.update(<InboxPage />);
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')[0]?.props.selected).toBe(false);
        routeParams.item = 'session: ';
        await screen.update(<InboxPage />);
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')[0]?.props.selected).toBe(false);
    }, SLOW_RENDER_TIMEOUT_MS);

    it('acknowledges every ready-for-review Home at its own exact server-scoped address', async () => {
        const { InboxView } = await import('./InboxView');
        const tree = await renderUpdates(InboxView);

        expect(nodesByTestId(tree, `inbox.ready_session.${homeA}.session-x`)).toHaveLength(1);
        expect(nodesByTestId(tree, `inbox.ready_session.${homeB}.session-x`)).toHaveLength(1);

        const [markAll] = nodesByTestId(tree, 'inbox.ready.mark_all_read');
        expect(markAll).toBeDefined();
        await press(markAll);

        await waitForHomeGovernance(() => expect(readRequests()).toHaveLength(2));
        expect(readRequests()).toEqual(expect.arrayContaining([
            { serverId: homeA, input: { state: 'read' } },
            { serverId: homeB, input: { state: 'read' } },
        ]));
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'inbox.ready.mark_all_read')).toHaveLength(0));
        expect(alerts.titles).toEqual([]);
    }, SLOW_RENDER_TIMEOUT_MS);

    it('keeps mark-all truthful and non-duplicating while one row is still settling', async () => {
        let release: () => void = () => {};
        const pending = new Promise<void>((resolve) => { release = resolve; });
        answerReadState(homeA, pending);
        answerReadState(homeB, pending);
        const { InboxView } = await import('./InboxView');
        const tree = await renderUpdates(InboxView);

        const [rowAction] = nodesByTestId(tree, `inbox.ready_session.${homeA}.session-x.mark_read`);
        await press(rowAction);
        await waitForHomeGovernance(() => expect(readRequests()).toEqual([
            { serverId: homeA, input: { state: 'read' } },
        ]));

        // One row in flight is not "the whole Inbox is being cleared": the header
        // action stays available and must only submit what is not already going.
        const [markAll] = nodesByTestId(tree, 'inbox.ready.mark_all_read');
        expect(markAll.findAll((node) => String(node.type) === 'ActivitySpinner')).toHaveLength(0);

        await press(markAll);
        await waitForHomeGovernance(() => expect(readRequests()).toHaveLength(2));
        expect(readRequests()[1]).toEqual({ serverId: homeB, input: { state: 'read' } });
        // A repeated press cannot re-submit either in-flight Home address.
        await press(nodesByTestId(tree, 'inbox.ready.mark_all_read')[0]);
        expect(readRequests()).toHaveLength(2);
        await act(async () => { release(); });
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'inbox.ready.mark_all_read')).toHaveLength(0));
        expect(alerts.titles).toEqual([]);
    }, SLOW_RENDER_TIMEOUT_MS);

    it('reports a failed acknowledgement instead of silently leaving the ready row pending', async () => {
        readAnswers.set(homeB, { status: 500, body: { error: 'unavailable' } });
        const { InboxView } = await import('./InboxView');
        const tree = await renderUpdates(InboxView);

        const [markAll] = nodesByTestId(tree, 'inbox.ready.mark_all_read');
        await press(markAll);

        await waitForHomeGovernance(() => expect(alerts.titles).toEqual(['common.error']));
        expect(nodesByTestId(tree, `inbox.ready_session.${homeB}.session-x`)).toHaveLength(1);
        expect(nodesByTestId(tree, `inbox.ready_session.${homeA}.session-x`)).toHaveLength(0);
        answerReadState(homeB);
        await press(nodesByTestId(tree, 'inbox.ready.mark_all_read')[0]);
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'inbox.ready.mark_all_read')).toHaveLength(0));
        expect(readRequests().map(({ serverId }) => serverId)).toEqual(expect.arrayContaining([homeA, homeB, homeB]));
        expect(readRequests()).toHaveLength(3);
    }, SLOW_RENDER_TIMEOUT_MS);
});
