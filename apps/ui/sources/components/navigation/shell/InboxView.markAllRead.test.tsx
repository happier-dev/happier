import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { HappierWorkRowShell } from '@happier-dev/plugin-ui/presentation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createInboxItemRoute } from '@/components/inbox/inboxItemFocus';
import { getActiveServerId, listServerProfiles, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeParams = vi.hoisted(() => ({ item: undefined as string | string[] | undefined }));
const routerMock = vi.hoisted(() => ({
    current: null as ReturnType<typeof import('@/dev/testkit/mocks/router').createExpoRouterMock> | null,
}));
const viewport = vi.hoisted(() => ({ width: 390 }));
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
            latestFailureSeq: null,
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

vi.mock('expo-router', async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeParams });
    routerMock.current = mock;
    return mock.module;
});
// Expo's native Route context is an SDK boundary absent from this host renderer.
// The canonical root router mock does not cover this deep SDK entry; the route body stays real.
vi.mock('expo-router/build/Route', () => ({ useRouteNode: () => null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only Radix's DOM host is substituted; the app owns alert custody and controls.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

// Configure the shared boundaries before these imports can initialize their store graph.
const { storage } = await import('@/sync/domains/state/storageStore');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
const initialStorageState = storage.getState();

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

/** Module init for the whole Inbox tree is the cost here, not the assertions. */
const SLOW_RENDER_TIMEOUT_MS = 240_000;

/** Host nodes only: a composite and the host it renders both carry `testID`. */
function nodesByTestId(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAll((node) => (
        typeof node.type === 'string'
        && (node.props as { testID?: string } | undefined)?.testID === testID
    ));
}

/** A deep link is a fresh destination: it carries the item alone, never the view a tab press wrote. */
function openDeepLink(item: string | string[]) {
    act(() => {
        routeParams.item = item;
        routerMock.current?.resetParams();
    });
}

async function press(node: { props: { onPress?: () => void } }): Promise<void> {
    await act(async () => {
        node.props.onPress?.();
    });
}

/** Finished sessions to read live under the Inbox's Updates view (lab `inbox-I1`). */
async function renderUpdates(InboxView: React.ComponentType) {
    const tree = (await renderScreen(<ModalProvider><InboxView /></ModalProvider>)).tree;
    const [updatesTab] = nodesByTestId(tree, 'inbox.view:updates');
    await press(updatesTab);
    return tree;
}

// Load the graph outside hook deadlines; per-test setup below still restores its bridge.
await loadSyncSingletonForTests();

describe('InboxView mark as read', () => {
    beforeEach(async () => {
        viewport.width = 390;
        await loadSyncSingletonForTests();
        storage.setState(initialStorageState, true);
        readAnswers.clear();
        routeParams.item = undefined;
        routerMock.current?.resetParams();
        harness = await serveActionHomes({
            homes: [
                { key: 'b', serverUrl: 'https://inbox-b.test', accountId: 'me' },
                { key: 'a', serverUrl: 'https://inbox-a.test', accountId: 'me' },
            ],
            route: ({ home, path }) => {
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                    features: { workflows: { enabled: false }, automations: { enabled: false }, social: { friends: { enabled: false } } },
                }));
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
        await harness?.dispose();
        // A build without a default Home starts with none: the test's Homes are all there is to leave.
        if (initialServerId) await setActiveServerId(initialServerId);
        for (const id of [homeA, homeB]) if (id && !initialProfileIds.has(id)) await removeServerProfile(id);
        storage.setState(initialStorageState, true);
    });

    it('uses the route item as the only row focus and reopens Needs you when it changes', async () => {
        // The retained list/detail selection belongs to a wide Inbox; phones open the item page.
        viewport.width = 1200;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const unread = unreadSession(homeA);
        if (!unread.viewer) throw new Error('Expected a private viewer fixture');
        const focused = createSessionFixture({
            id: 'needs-focus', serverId: homeA, encryptionMode: 'plain',
            viewer: {
                ...unread.viewer,
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                // Manual attention reads under Updates; a blocked delivery is a genuine Needs-you item.
                attention: { needsAttention: true, reasons: ['pending_blocked'], primary: 'pending_blocked', presentation: 'full' },
            },
        });
        storage.getState().applySessions([focused]);
        // Hydration does not enroll a Session into the ordinary list corpus.
        storage.getState().applyServerScopedSessionListRows(homeA, [focused], { source: 'ordinary', mode: 'append' });
        const { InboxPage } = await import('@/app/(app)/inbox/index');
        const screen = await renderScreen(<InboxPage />);
        await press(nodesByTestId(screen.tree, 'inbox.view:updates')[0]);
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')).toHaveLength(0);

        openDeepLink([createInboxItemRoute({ kind: 'session', serverId: homeA, id: 'needs-focus' }).params.item]);
        await screen.update(<InboxPage />);
        const focusedRow = () => screen.findAllByType(HappierWorkRowShell)
            .find(node => node.props.testID === 'inbox.session.needs-focus');
        const { InboxContent } = await import('@/components/inbox/InboxContent');
        const model: React.ComponentProps<typeof InboxContent>['model'] = screen.findByType(InboxContent).props.model;
        expect(focusedRow()?.props.selected, JSON.stringify({
            items: model.items.map(item => ({ id: item.source.id, type: item.type, view: item.view })),
            needsAttention: model.sessionPresentation.sessionsNeedingAttention.map(entry => ({ id: entry.candidate.sessionId, reasons: entry.candidate.personalAttention.reasons })),
            ready: model.sessionPresentation.readySessions.map(candidate => candidate.sessionId),
        })).toBe(true);
        await press(nodesByTestId(screen.tree, 'inbox.view:updates')[0]);
        await screen.update(<InboxPage />);
        // A render with the same item preserves the person's chosen Updates tab.
        expect(nodesByTestId(screen.tree, 'inbox.session.needs-focus')).toHaveLength(0);

        openDeepLink(createInboxItemRoute({ kind: 'session', serverId: homeA, id: 'missing' }).params.item);
        await screen.update(<InboxPage />);
        expect(focusedRow()?.props.selected).toBe(false);
        openDeepLink('session: ');
        await screen.update(<InboxPage />);
        expect(focusedRow()?.props.selected).toBe(false);
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
        expect(tree.root.findAllByType(WebAlertModal)).toHaveLength(0);
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
        expect(markAll.findAll((node) => node.type === ActivitySpinner)).toHaveLength(0);

        await press(markAll);
        await waitForHomeGovernance(() => expect(readRequests()).toHaveLength(2));
        expect(readRequests()[1]).toEqual({ serverId: homeB, input: { state: 'read' } });
        // A repeated press cannot re-submit either in-flight Home address.
        await press(nodesByTestId(tree, 'inbox.ready.mark_all_read')[0]);
        expect(readRequests()).toHaveLength(2);
        await act(async () => { release(); });
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'inbox.ready.mark_all_read')).toHaveLength(0));
        expect(tree.root.findAllByType(WebAlertModal)).toHaveLength(0);
    }, SLOW_RENDER_TIMEOUT_MS);

    it('reports a failed acknowledgement instead of silently leaving the ready row pending', async () => {
        readAnswers.set(homeB, { status: 500, body: { error: 'unavailable' } });
        const { InboxView } = await import('./InboxView');
        const tree = await renderUpdates(InboxView);

        const [markAll] = nodesByTestId(tree, 'inbox.ready.mark_all_read');
        await press(markAll);

        await waitForHomeGovernance(() => expect(tree.root.findAllByType(WebAlertModal)
            .map(node => node.props.config.title)).toEqual(['common.error']));
        expect(nodesByTestId(tree, `inbox.ready_session.${homeB}.session-x`)).toHaveLength(1);
        expect(nodesByTestId(tree, `inbox.ready_session.${homeA}.session-x`)).toHaveLength(0);
        const dismiss = nodesByTestId(tree, 'web-modal-button-0');
        expect(dismiss).toHaveLength(1);
        await press(dismiss[0]);
        await waitForHomeGovernance(() => expect(tree.root.findAllByType(WebAlertModal)).toHaveLength(0));
        answerReadState(homeB);
        await press(nodesByTestId(tree, 'inbox.ready.mark_all_read')[0]);
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'inbox.ready.mark_all_read')).toHaveLength(0));
        expect(readRequests().map(({ serverId }) => serverId)).toEqual(expect.arrayContaining([homeA, homeB, homeB]));
        expect(readRequests()).toHaveLength(3);
    }, SLOW_RENDER_TIMEOUT_MS);
});
