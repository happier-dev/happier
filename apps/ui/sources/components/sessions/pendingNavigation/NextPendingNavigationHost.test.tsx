import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

const navigation = vi.hoisted(() => ({ routes: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: (route) => navigation.routes.push(route) } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const [{ buildSessionMessagesPath}, { SessionCurrentProjectionRecordV1Schema}] = await Promise.all([import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1'), import('@happier-dev/protocol/sessions/listing/response')]);
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { SessionViewerProjectionV1Schema } = await import('@happier-dev/protocol/sessions/personal/viewer');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
const { invokeNextPendingRequest, markSessionPendingAnswer, useSessionPendingAnswerToken, usePendingNavigationLanding } = await import('@/activity/source/pendingNavigationRuntime');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { NextPendingNavigationHost } = await import('./NextPendingNavigationHost');
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(() => {
    // The real keyboard owner leaves the process only at the browser event target.
    vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    if (connection) await connection.dispose();
    else await disconnectActiveServerConnection();
    connection = undefined;
    getStorage().setState(initialState, true);
    await homes.reset();
    navigation.routes = [];
});

describe('mounted app-shell Next navigation', () => {
    it('navigates a real pending request through the mounted runtime and keyboard seam, and retires on unmount', async () => {
        const serverId = await homes.addHome({ name: 'Next Home', serverUrl: 'https://next-home.test', accountId: 'next-owner' });
        await homes.selectHomes([serverId]);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://next-home.test', accountId: 'next-owner',
            additionalRequestOrigins: ['https://other-next-home.test'], request: homes.request });
        const session = createSessionFixture({ id: 'needs-answer', serverId, active: true, activeAt: Date.now(), updatedAt: Date.now(),
            pendingRequestObservedAt: Date.now(),
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: Date.now() - 10 } } } });
        if (!session.access) throw new Error('Pending fixture requires owner access');
        const wireSession = SessionCurrentProjectionRecordV1Schema.parse({
            id: session.id, createdAt: 1, updatedAt: Date.now(), seq: 5,
            active: true, activeAt: Date.now(), encryptionMode: 'plain', dataEncryptionKey: null,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: session.pendingRequestObservedAt,
            metadataLayoutVersion: 0, metadataVersion: 1, metadata: JSON.stringify({ ...session.metadata, name: 'Needs an answer' }),
            agentStateVersion: 1, agentState: JSON.stringify(session.agentState), share: null,
            effectiveAccess: { v: 1, level: session.access.level, sources: [{ kind: 'owner' }], capabilities: session.access.capabilities },
            responsibleAccountId: null, responsibleAccount: null,
            viewer: SessionViewerProjectionV1Schema.parse({
                latestFailureSeq: null,
                readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' },
            }),
        });
        homes.answer(serverId, '/v2/sessions/needs-answer', { body: { session: wireSession } });
        homes.answer(serverId, 'POST /v2/sessions/read-batch', { body: { results: [{ sessionId: session.id,
            detail: { status: 200, body: { session: wireSession } }, turns: { status: 404, body: { error: 'not_found' } },
        }] } });
        homes.answer(serverId, '/v2/sessions/active', { body: { sessions: [wireSession], hasNext: false, nextCursor: null } });
        session.viewer = wireSession.viewer;
        session.pendingUserActionRequestCount = 1;
        session.pendingPermissionRequestCount = 0;
        homes.answer(serverId, buildSessionMessagesPath({ sessionId: session.id, scope: 'all' }), {
            body: { messages: [], hasMore: false, nextBeforeSeq: null },
        });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: { [session.id]: session },
            sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
        });
        let invokeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        let answerToken: number | null = null;
        let landing: ReturnType<typeof usePendingNavigationLanding> = null;
        let bindings: ReturnType<typeof useServerCredentialAccountScopeBindings> = new Map();
        function KeyboardProbe() {
            invokeCommand = useKeyboardCommand();
            bindings = useServerCredentialAccountScopeBindings([serverId]);
            return null;
        }
        function AnswerProbe({ address }: { address: SessionAddress | null }) {
            answerToken = useSessionPendingAnswerToken(address);
            landing = usePendingNavigationLanding({ serverId, sessionId: session.id });
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}>
            <NextPendingNavigationHost /><KeyboardProbe /><AnswerProbe address={null} />
        </KeyboardShortcutProvider>);
        expect(homes.requestsFor('/v2/sessions/needs-answer')).toHaveLength(0);
        await waitForHomeGovernance(() => expect(bindings.get(serverId)?.isCurrent()).toBe(true));
        const executor = createDefaultActionExecutor();
        const context = { serverId, surface: 'ui' as const, expectedAccountId: 'next-owner' };
        let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
        await act(async () => { result = await executor.execute('session.pending.next', {}, context); });
        expect(result, `HTTP paths: ${homes.requests.map(request => request.path).join(', ')}`)
            .toEqual({ ok: true, result: { status: 'opened' } });
        if (!result?.ok) throw new Error('Expected a successful Next Action');
        expect(getActionSpec('session.pending.next').outputSchema!.parse(result.result)).toEqual({ status: 'opened' });
        expect(navigation.routes.at(-1)).toBe(`/session/needs-answer?serverId=${encodeURIComponent(serverId)}`);
        expect(landing).toMatchObject({ address: { serverId, sessionId: session.id }, requestId: 'question',
            state: 'pending', focusTarget: 'prompt' });
        await act(async () => {
            expect(invokeCommand('session.pending.next')).toBe(true);
        });
        await waitForHomeGovernance(() => expect(navigation.routes).toHaveLength(2));
        homes.answer(serverId, 'POST /v2/sessions/read-batch', { status: 503, body: { error: 'unavailable' } });
        await expect(executor.execute('session.pending.next', {}, context)).resolves.toEqual({ ok: true,
            result: { status: 'unavailable', reason: 'details_unavailable' } });
        expect(navigation.routes).toHaveLength(2);
        await expect(invokeNextPendingRequest({ expectedServerId: 'another-home' })).resolves.toEqual({ status: 'unavailable', reason: 'scope_changed' });
        const cancel = new AbortController();
        cancel.abort();
        await expect(invokeNextPendingRequest({ signal: cancel.signal })).resolves.toEqual({ status: 'unavailable', reason: 'cancelled' });
        await screen.update(<KeyboardShortcutProvider handlers={{}}><KeyboardProbe /><AnswerProbe address={null} /></KeyboardShortcutProvider>);
        // Removing the production host binding must make the public Action unavailable.
        await expect(executor.execute('session.pending.next', {}, context))
            .resolves.toEqual({ ok: true, result: { status: 'unavailable', reason: 'no_navigation_host' } });
        expect(navigation.routes).toHaveLength(2);
        let otherHome = '';
        await act(async () => {
            otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-next-home.test', accountId: 'other-owner' });
        });
        const otherAddress = { serverId: otherHome, sessionId: 'answered-in-other-home' };
        await screen.update(<KeyboardShortcutProvider handlers={{}}>
            <NextPendingNavigationHost /><KeyboardProbe /><AnswerProbe address={otherAddress} />
        </KeyboardShortcutProvider>);
        await act(async () => { markSessionPendingAnswer(otherAddress, 'other-question'); });
        const retainedAnswerToken = answerToken;
        expect(retainedAnswerToken).toEqual(expect.any(Number));
        await act(async () => { await homes.switchAccount(serverId, 'replacement-owner'); });
        expect(answerToken).toBe(retainedAnswerToken);
        await act(async () => { screen.tree.unmount(); });
        await expect(invokeNextPendingRequest()).resolves.toEqual({ status: 'unavailable', reason: 'no_navigation_host' });
    });

    it('distinguishes a mounted empty source from an unavailable client', async () => {
        const serverId = await homes.addHome({ name: 'Empty Home', serverUrl: 'https://empty-next-home.test', accountId: 'next-owner' });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        });
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><NextPendingNavigationHost /></KeyboardShortcutProvider>);
        await expect(invokeNextPendingRequest()).resolves.toEqual({ status: 'none' });
        expect(navigation.routes).toHaveLength(0);
    });

    it('does not redraw when a Session update leaves the pending Homes unchanged', async () => {
        // The host reads only which Homes hold pending requests; every message on the Account redrew it.
        const serverId = await homes.addHome({ name: 'Quiet Home', serverUrl: 'https://quiet-next-home.test', accountId: 'next-owner' });
        const session = createSessionFixture({ id: 'quiet', serverId, active: true, activeAt: Date.now(), updatedAt: Date.now() });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: { [session.id]: session }, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        });
        let commits = 0;
        await renderScreen(<KeyboardShortcutProvider handlers={{}}>
            <React.Profiler id="next" onRender={() => { commits += 1; }}><NextPendingNavigationHost /></React.Profiler>
        </KeyboardShortcutProvider>);
        const before = commits;
        await act(async () => {
            for (let seq = 2; seq < 5; seq += 1) {
                getStorage().setState((state) => ({ sessions: { ...state.sessions, [session.id]: { ...session, seq, updatedAt: session.updatedAt + seq } } }));
            }
        });
        expect(commits - before).toBe(0);
    });

    it('says once, quietly, that nothing waits when the key finds no request (lab fnext ST), and stays silent for Actions', async () => {
        const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const { t } = await import('@/text');
        retirePresentationNotice();
        const serverId = await homes.addHome({ name: 'Quiet Home', serverUrl: 'https://quiet-next-home.test', accountId: 'next-owner' });
        getStorage().setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'next-owner' },
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        });
        let invokeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        function KeyboardProbe() {
            invokeCommand = useKeyboardCommand();
            return null;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><NextPendingNavigationHost /><KeyboardProbe /></KeyboardShortcutProvider>);
        // An Agent or MCP caller gets the typed `none`; the person's screen is not interrupted.
        await expect(invokeNextPendingRequest()).resolves.toEqual({ status: 'none' });
        expect(readPresentationNotice()).toBeNull();
        await act(async () => {
            expect(invokeCommand('session.pending.next')).toBe(true);
            await waitForHomeGovernance(() => expect(readPresentationNotice()).toEqual(expect.objectContaining({
                severity: 'info',
                message: t('pendingNavigation.nothingWaiting'),
            })));
        });
        expect(navigation.routes).toHaveLength(0);
        retirePresentationNotice();
    });
});
