// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import {
    createSessionFixture,
    createMachineFixture,
    pressTestInstanceAsync,
    renderScreen,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { InboxSessionAttentionGroupCard } from './InboxSessionAttentionGroupCard';
import { CollectionSessionRequestPeekBody } from '@/components/ui/lists/collection/CollectionSessionRequestPeekBody';
import { Text } from '@/components/ui/text/Text';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { createSessionViewerFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { InboxWorkItemRow } from '@/components/inbox/workGroups/InboxWorkItemRow';
import { InboxModelProvider, useInboxModel } from '@/hooks/inbox/useInboxModel';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import type { Socket } from 'socket.io-client';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';

const NOW_MS = 1_000_000;
const SESSION_ID = 'global-voice-after-end';
let REQUEST_ID = 'permission-after-end';
let requestIdentity = 0;
const permissionRpc = vi.hoisted(() => vi.fn(async (_request: Readonly<{
    serverUrl: string | undefined; method: string; params: unknown;
}>) => undefined));
const routerPush = vi.hoisted(() => vi.fn());
const initialState = storage.getState();
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let serverIdA: string;
let serverIdB: string;
let retrySessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary> | null = null;
let retrySessionReadCount = 0;
let externalQuestionSession: Session | null = null;
let externalQuestionFeatures: ReturnType<typeof createRootLayoutFeaturesResponse> | null = null;
const connectedSockets = new Set<Socket>();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        TouchableOpacity: 'TouchableOpacity',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPush,
        },
    }).module;
});
// Account, crypto and Home qualification run in the real RPC wrapper. Only
// Socket.IO's external delivery and acknowledgement are synthetic.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    connectedSockets.add(socket);
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected Socket RPC request');
        const method = payload.method;
        if (![RPC_METHODS.SESSION_PERMISSION_RESPOND, RPC_METHODS.SESSION_USER_ACTION_ANSWER]
            .some(allowed => method.endsWith(`:${allowed}`))) throw new Error('Unexpected request in Inbox fixture');
        await permissionRpc({ serverUrl, method: payload.method, params: payload.params });
        return { ok: true, result: undefined };
    });
});

function createPendingPostEndSession(): Session {
    return createSessionFixture({
        id: SESSION_ID,
        encryptionMode: 'plain',
        serverId: serverIdA,
        seq: 4,
        lastViewedSessionSeq: 4,
        active: true,
        activeAt: NOW_MS - 100,
        updatedAt: NOW_MS - 10,
        presence: 'online',
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: NOW_MS - 10,
        metadata: {
            name: 'Global Voice session',
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            flavor: 'codex',
            systemSessionV1: {
                v: 1,
                key: 'voice_conversation',
                hidden: true,
            },
        },
        agentState: {
            controlledByUser: null,
            requests: {
                [REQUEST_ID]: {
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                },
            },
            completedRequests: {},
        },
    });
}

function createActivitySource(session: Session): ActivityAttentionSource {
    return {
        isDataReady: true,
        sessionsById: { [session.id]: session },
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {
            // Hidden system sessions are intentionally absent from the ordinary list.
            [serverIdA]: [],
        },
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {
            [serverIdA]: {
                id: serverIdA,
                name: 'Server A',
                serverUrl: 'https://a.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: serverIdA,
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
    };
}

describe('global Voice post-End permission custody', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // An issued answer remains unconfirmed until its real request changes. Each journey owns a new request.
        REQUEST_ID = `permission-after-end-${++requestIdentity}`;
        retrySessionHttp = null;
        retrySessionReadCount = 0;
        externalQuestionSession = null;
        externalQuestionFeatures = null;
        connectedSockets.clear();
        const sessionHttp = createSessionMetadataHttpBoundary(() => externalQuestionSession
            ? { ...storage.getState().sessions, [externalQuestionSession.id]: externalQuestionSession } : storage.getState().sessions);
        const sessionReads = createSessionReadBatchHttpBoundary(request => {
            if (externalQuestionSession && request.path === `/v2/sessions/${externalQuestionSession.id}`) {
                // A full external snapshot carries the same current personal projection as its list header.
                return Response.json({ session: { ...createPlainSessionByIdResponseFixture(externalQuestionSession).session,
                    ownerAccountId: 'account-a', viewer: externalQuestionSession.viewer } });
            }
            if (externalQuestionSession && request.path === `/v1/sessions/${externalQuestionSession.id}/messages`) {
                return Response.json({ messages: [], hasMore: false, nextAfterSeq: null });
            }
            const retryResponse = retrySessionHttp?.handle(request.url);
            if (retryResponse) {
                if (request.path === `/v2/sessions/${SESSION_ID}`) retrySessionReadCount++;
                return retryResponse;
            }
            return sessionHttp.handle(request.url) ?? undefined;
        });
        home = await serveSessionActionHome({
            homes: [
                { key: 'b', serverUrl: 'https://b.example.test', accountId: 'account-b', currentAccount: true },
                { key: 'a', serverUrl: 'https://a.example.test', accountId: 'account-a', currentAccount: true },
            ],
            route: request => {
                if (externalQuestionFeatures && ['/v1/features', '/v1/features/authenticated'].includes(request.path)) {
                    return Response.json(externalQuestionFeatures);
                }
                if (externalQuestionSession && request.path === '/v2/sessions/query') {
                    // The public list carries attention, not the owner's private Agent state.
                    const header = createSessionFixture({ ...externalQuestionSession, active: false, agentStateVersion: 0,
                        agentState: null, pendingUserActionRequestCount: 0 });
                    return Response.json(createSessionListSourceFixture({ sessions: [{ ...createPlainSessionByIdResponseFixture(header).session,
                        ownerAccountId: 'account-a', viewer: header.viewer }], hasNext: false, nextCursor: null,
                        attentionHasNext: false, attentionNextCursor: null }));
                }
                return sessionReads.handle(request);
            },
        });
        serverIdA = home.homes.a!.id;
        serverIdB = home.homes.b!.id;
        const machineA = createMachineFixture({ id: 'shared-machine', metadata: {
            ...createMachineFixture().metadata!, displayName: 'Home A machine',
        } });
        const machineB = createMachineFixture({ ...machineA, metadata: {
            ...machineA.metadata!, displayName: 'Home B machine',
        } });
        storage.setState({
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: { [serverIdA]: [] }, concurrentSessionListCacheByServerId: {},
            machines: { [machineA.id]: machineA },
            machineListByServerId: { [serverIdA]: [machineA], [serverIdB]: [machineB] },
        });
        permissionRpc.mockResolvedValue(undefined);
        routerPush.mockResolvedValue(undefined);
    });
    afterEach(standardCleanup);
    afterEach(async () => {
        await home.dispose();
        act(() => storage.setState(initialState));
    });

    it('retries a mounted Session hydration through the same exact Home reader without remounting', async () => {
        const session = createPendingPostEndSession();
        storage.getState().applySessions([session]);
        const fresh = createSessionFixture({ ...session, metadata: { ...session.metadata!, name: 'Refreshed request session' },
            metadataVersion: session.metadataVersion + 1 });
        const marker = {};
        const hook = await renderHook(() => {
            const stable = React.useRef(marker);
            return { stable: stable.current, hydration: useHydrateSession(session.id, 'request.peek.retry', {
                serverId: serverIdA, hydrateMessages: false,
            }) };
        });
        expect(hook.getCurrent().hydration.kind).toBe('available');
        expect(retrySessionReadCount).toBe(0);
        expect(storage.getState().sessions[session.id]?.metadata?.name).toBe('Global Voice session');
        retrySessionHttp = createSessionMetadataHttpBoundary(() => ({ [session.id]: fresh }));
        await act(async () => { hook.getCurrent().hydration.retry(); });
        await vi.waitFor(() => expect(storage.getState().sessions[session.id]?.metadata?.name).toBe('Refreshed request session'));
        expect(retrySessionReadCount).toBe(1);
        expect(home.httpRequests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
        expect(hook.getCurrent().stable).toBe(marker);
        expect(hook.getCurrent().hydration.kind).toBe('available');
    });

    it('answers an opened collection permission with its exact turn and withdraws a replaced request', async () => {
        const base = createPendingPostEndSession();
        const turnId = '55555555-5555-4555-8555-555555555555';
        const request = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'git status' },
            createdAt: NOW_MS - 10, turnId };
        const session = createSessionFixture({ ...base, agentState: { controlledByUser: null,
            requests: { [REQUEST_ID]: request }, completedRequests: {} } });
        storage.getState().applySessions([session]);
        storage.setState({ sessionListRowsByServerId: { [serverIdA]: { [session.id]: buildSessionListRenderableFromSession(session) } } });
        const body = (open: boolean) => <CollectionSessionRequestPeekBody request={{ kind: 'permission',
            serverId: serverIdA, sessionId: SESSION_ID, requestId: REQUEST_ID, turnId }} open={open}
            renderState={state => <Text testID={`collection-request.${state.kind}`}>{state.kind}</Text>} />;
        const screen = await renderScreen(body(false));
        expect(screen.findByTestId('permission-footer.allow')).toBeNull();
        await screen.update(body(true));
        await vi.waitFor(() => expect(screen.findByTestId('permission-footer.allow')).not.toBeNull());
        expect(permissionRpc).not.toHaveBeenCalled();
        expect(storage.getState().sessions[SESSION_ID]?.lastViewedSessionSeq).toBe(4);
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://a.example.test',
            params: expect.objectContaining({ id: REQUEST_ID, turnId, approved: true }) }));
        await act(async () => storage.getState().applySessions([createSessionFixture({ ...session, agentState: {
            controlledByUser: null, requests: { [REQUEST_ID]: { ...request, turnId: '66666666-6666-4666-8666-666666666666' } },
            completedRequests: {},
        } })]));
        expect(screen.findByTestId('collection-request.replaced')).not.toBeNull();
        expect(screen.findByTestId('permission-footer.allow')).toBeNull();
        expect(permissionRpc).toHaveBeenCalledTimes(1);
        await act(async () => storage.getState().applySessions([createSessionFixture({ ...session, access: {
            ...session.access!, capabilities: { ...session.access!.capabilities, readTranscript: false },
        } })]));
        expect(screen.findByTestId('collection-request.unavailable')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('git status');
    });

    it('answers every required field of a collection question through the existing question owner', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const base = createPendingPostEndSession();
        const session = createSessionFixture({ ...base, agentState: { controlledByUser: null, requests: {
            [REQUEST_ID]: { tool: 'AskUserQuestion', kind: 'user_action', createdAt: NOW_MS - 10,
                arguments: { questions: [
                    { question: 'Pick one', header: 'Choice', options: [{ label: 'A', description: 'First choice' }], multiSelect: false },
                    { id: 'details', question: 'Explain your choice', selection: 'text', required: true },
                ] } },
        }, completedRequests: {} }, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1 });
        storage.getState().applySessions([session]);
        storage.setState({ sessionListRowsByServerId: { [serverIdA]: { [session.id]: buildSessionListRenderableFromSession(session) } } });
        const screen = await renderScreen(<AppPaneProvider><CollectionSessionRequestPeekBody open request={{ kind: 'question',
            serverId: serverIdA, sessionId: session.id, requestId: REQUEST_ID }} renderState={() => null} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('ask-user-question.option:0:0')).not.toBeNull());
        expect(permissionRpc).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('ask-user-question.option:0:0');
        await act(async () => { screen.changeTextByTestId('ask-user-question.freeform:1', 'Ready now'); });
        await screen.pressByTestIdAsync('ask-user-question.submit');
        expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://a.example.test',
            params: expect.objectContaining({ id: REQUEST_ID, answers: { 'Pick one': ['A'], details: ['Ready now'] } }) }));
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('hydrates and answers the original person question from a list-only row through the Inbox owner', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const base = createPendingPostEndSession();
        const questionNow = Date.now();
        const request = { tool: 'AskUserQuestion', kind: 'user_action' as const, createdAt: questionNow - 10,
            questionV1: { mode: 'wait' as const, type: 'decision' as const, lasting: false }, currentHandler: { kind: 'person' as const },
            arguments: { questions: [{ question: 'Pick a region', options: [{ label: 'Europe', description: 'Primary region' }] }] } };
        const session = createSessionFixture({ ...base, metadata: { name: 'Payments worker', path: '/work/payments', host: 'worker' },
            activeAt: questionNow - 100, updatedAt: questionNow - 10, pendingRequestObservedAt: questionNow - 10,
            agentStateVersion: 16, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1,
            agentState: { requests: { [REQUEST_ID]: request }, completedRequests: {} },
            viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' } }) });
        externalQuestionSession = session;
        externalQuestionFeatures = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(externalQuestionFeatures, 'sessions.filteredListing', true)).toBe(true);
        primeServerFeaturesSnapshot({ serverId: serverIdA, snapshot: { status: 'ready', features: externalQuestionFeatures } });
        const row = { ...buildSessionListRenderableFromSession(session), active: false, activeAt: session.activeAt - 1,
            agentStateVersion: 0, hasPendingUserActionRequests: false };
        storage.setState({ sessions: {}, sessionMessages: {},
            sessionListRowsByServerId: { [serverIdA]: { [session.id]: row } },
            ordinarySessionListMembershipByServerId: { [serverIdA]: [session.id] } });
        let needsYou = 0;
        function InboxRow() {
            const model = useInboxModel();
            needsYou = model.items.filter(item => item.focus.id === session.id && item.view === 'needs_you').length;
            const items = model.workGroups.flatMap(group => group.items).filter(item => item.kind === 'session' && item.entry.candidate.sessionId === session.id);
            return <>{items.map(item => <InboxWorkItemRow key={item.key} item={item} spansHomes={false} workflowServerId={serverIdA}
                identityDisplay="none" presentation="screen" navigate={routerPush} settle={async () => {}} setReminder={async () => {}} />)}</>;
        }
        const screen = await renderScreen(<AppPaneProvider><ActivityPersonalSessionMembershipProvider enabled>
            <InboxModelProvider><InboxRow /></InboxModelProvider></ActivityPersonalSessionMembershipProvider></AppPaneProvider>);
        await vi.waitFor(() => expect(needsYou).toBe(1));
        await vi.waitFor(() => expect(screen.findByTestId('ask-user-question.submit')).not.toBeNull());
        expect(storage.getState().sessions[session.id]?.agentState?.requests).toHaveProperty(REQUEST_ID);
        expect(permissionRpc).not.toHaveBeenCalled();
        const sessionReads = () => home.httpRequests.filter(request => request.path === '/v2/sessions/read-batch').length;
        const acquiredReads = sessionReads();
        expect(acquiredReads).toBeGreaterThan(0);
        await act(async () => {
            // Even rebuilt arrays from unrelated Account arrivals must not reacquire a held request.
            for (let index = 0; index < 100; index++) storage.setState({ friends: {} });
        });
        expect(sessionReads()).toBe(acquiredReads);
        permissionRpc.mockImplementationOnce(async () => {
            const answeredAt = questionNow + 1;
            const answered = createSessionFixture({ ...session, updatedAt: answeredAt, seq: session.seq + 1,
                agentStateVersion: session.agentStateVersion + 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: answeredAt,
                agentState: { requests: {}, completedRequests: { [REQUEST_ID]: { ...request, status: 'approved', completedAt: answeredAt } } },
                viewer: createSessionViewerFixture({ relevance: session.viewer!.relevance }) });
            externalQuestionSession = answered;
            const update = { id: 'original-question-answered', seq: answered.seq, createdAt: answeredAt, body: {
                t: 'update-session', id: session.id, agentState: { version: answered.agentStateVersion, value: JSON.stringify(answered.agentState) },
                pendingUserActionRequestCount: 0, pendingRequestObservedAt: answeredAt, viewer: answered.viewer,
            } } satisfies ApiUpdateContainer;
            for (const socket of connectedSockets) for (const listener of socket.listeners('update')) listener(update);
        });
        await screen.pressByTestIdAsync('ask-user-question.option:0:0');
        await screen.pressByTestIdAsync('ask-user-question.submit');
        expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://a.example.test',
            method: `${session.id}:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
            params: expect.objectContaining({ id: REQUEST_ID, answers: { 'Pick a region': ['Europe'] } }) }));
        await vi.waitFor(() => expect(storage.getState().sessions[session.id]?.agentState?.completedRequests).toHaveProperty(REQUEST_ID));
        await vi.waitFor(() => expect(needsYou).toBe(0));
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('shows a stopped pending-approval row with a resume action instead of an empty group', async () => {
        const session = { ...createPendingPostEndSession(), active: false, presence: 0 };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdA}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        expect(screen.findByTestId(`inbox.session_attention.${SESSION_ID}`)).not.toBeNull();
        expect(screen.findByTestId('inbox.session_attention.stopped')).not.toBeNull();
        expect(screen.findByTestId('inbox.session_attention.resume')).not.toBeNull();
        await screen.pressByTestIdAsync('inbox.session_attention.resume');
        expect(screen.findByTestId('inbox.session_attention.resume_error')).not.toBeNull();
    });

    it('draws Resume through the canonical operation control with a keyboard-only focus ring', async () => {
        const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
        const focusColor = createThemeFixture().colors.border.focus;
        const session = { ...createPendingPostEndSession(), active: false, presence: 0 };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdA}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        const resume = () => screen.findByTestId('inbox.session_attention.resume')!;
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...flatten(next) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        // The pill's painted ring: the shared outline, held off the pill so the page shows through.
        const pillRing = () => {
            const frames = resume().findAll((node) => String(node.type) === 'Animated.View');
            expect(frames).toHaveLength(1);
            const style = flatten(frames[0]!.props.style);
            return style.outlineStyle === 'solid' ? { color: style.outlineColor, gap: style.outlineOffset } : null;
        };
        // The browser's `:focus-visible` verdict: a click leaves focus that does not match it, Tab does.
        const focusedElement = (focusVisible: boolean) => ({
            matches: (selector: string) => selector === ':focus-visible' && focusVisible,
        });

        expect(resume().props.accessibilityLabel).toBe(t('session.pendingActivation.actions.resume'));
        expect(resume().props.accessibilityState).toMatchObject({ busy: false, disabled: false });
        expect(pillRing()).toBeNull();

        await act(async () => {
            resume().props.onFocus?.({ target: focusedElement(false) });
        });
        expect(pillRing()).toBeNull();

        await act(async () => {
            // The ring answers only to keyboard use: the document records Tab before the focus lands.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            resume().props.onBlur?.({});
            resume().props.onFocus?.({ target: focusedElement(true) });
        });
        expect(pillRing()).toEqual({ color: focusColor, gap: 2 });
    });

    it('opens a stopped secondary-Home session before resuming with Home-scoped settings', async () => {
        const session = { ...createPendingPostEndSession(), active: false, presence: 0, serverId: serverIdB };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdB}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        await screen.pressByTestIdAsync('inbox.session_attention.resume');
        expect(routerPush).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${serverIdB}`);
    });

    it.each([
        {
            decision: 'approve',
            actionTestId: 'permission-footer.allow',
            approved: true,
            rpcDecision: 'approved',
        },
        {
            decision: 'deny',
            actionTestId: 'permission-footer.deny',
            approved: false,
            rpcDecision: 'denied',
        },
    ] as const)(
        'keeps the post-End hidden-session permission actionable for $decision',
        async ({ actionTestId, approved, rpcDecision }) => {
            const session = createPendingPostEndSession();
            storage.getState().applySessions([session]);
            // A newer list sequence may carry an older attachment clock than the held request.
            const row = buildSessionListRenderableFromSession({ ...session, seq: session.seq + 1,
                active: false, activeAt: session.activeAt - 1, updatedAt: session.updatedAt - 1 });
            const activity = buildActivityOverviewFromSource({
                source: { ...createActivitySource(session),
                    sessionListRowsByServerId: { [serverIdA]: { [session.id]: row } } },
                nowMs: NOW_MS,
                directActionsEnabled: true,
            });
            const inbox = buildInboxSessionPresentation({ overview: activity });

            expect(activity.candidates).toEqual([
                expect.objectContaining({
                    sessionId: SESSION_ID,
                    route: `/session/${SESSION_ID}?serverId=${serverIdA}`,
                }),
            ]);
            expect(inbox.sessionsNeedingAttention).toHaveLength(1);

            const attention = inbox.sessionsNeedingAttention[0]!;
            const screen = await renderScreen(
                <InboxSessionAttentionGroupCard
                    identityDisplay="none"
                    connected={false}
                    session={attention.candidate.session}
                    presentationSource={attention.candidate.presentationSource}
                    serverId={attention.candidate.address?.serverId ?? null}
                    permissionRequests={attention.pendingPermissions}
                    userActionRequests={attention.pendingUserActions}
                />,
            );

            await pressTestInstanceAsync(
                screen.find((node) => node.props.accessibilityLabel === t('inbox.openSession', { session: 'Global Voice session' })),
                'post-End hidden Voice session open action',
            );

            expect(routerPush).toHaveBeenCalledTimes(1);
            expect(routerPush).toHaveBeenCalledWith(
                `/session/${SESSION_ID}?serverId=${serverIdA}`,
            );

            await screen.pressByTestIdAsync(actionTestId);

            expect(screen.findByTestId('permission-footer.action-error')).toBeNull();
            expect(permissionRpc).toHaveBeenCalledTimes(1);
            expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverUrl: 'https://a.example.test',
                method: `${SESSION_ID}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
                params: {
                    id: REQUEST_ID,
                    approved,
                    decision: rpcDecision,
                    answeringClientCategory: 'web',
                },
            }));
            expect(routerPush).toHaveBeenCalledTimes(1);
        },
    );

    it('sends a secondary Home approval with its qualified scope when the active Home has the same session id', async () => {
        const activeSession = createPendingPostEndSession();
        const secondarySession = { ...activeSession, serverId: serverIdB };
        storage.getState().applySessions([activeSession]);
        storage.setState({ sessionListRowsByServerId: {
            [serverIdA]: { [activeSession.id]: buildSessionListRenderableFromSession(activeSession) },
            [serverIdB]: { [secondarySession.id]: buildSessionListRenderableFromSession(secondarySession) },
        } });
        const activity = buildActivityOverviewFromSource({
            source: createActivitySource(secondarySession),
            nowMs: NOW_MS,
            directActionsEnabled: true,
        });
        const inbox = buildInboxSessionPresentation({ overview: activity });
        const attention = inbox.sessionsNeedingAttention[0]!;
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={attention.candidate.session}
                presentationSource={attention.candidate.presentationSource}
                serverId={serverIdB}
                permissionRequests={attention.pendingPermissions}
                userActionRequests={attention.pendingUserActions}
            />,
        );

        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'app', sessionId: SESSION_ID, serverId: serverIdB }),
        ]);
        await screen.pressByTestIdAsync('permission-footer.allow');

        expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://b.example.test',
            method: `${SESSION_ID}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: { id: REQUEST_ID, approved: true, decision: 'approved', answeringClientCategory: 'web' },
        }));
    });

    it('uses the qualified Home when resolving Inbox machine context', async () => {
        const session = createSessionFixture({
            id: 'same-session',
            encryptionMode: 'plain',
            serverId: serverIdB,
            metadata: {
                name: 'Secondary Home session',
                host: 'home-b-host',
                path: '/Users/tester/project',
                homeDir: '/Users/tester',
                machineId: 'shared-machine',
            },
        });

        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdB}
                contextLine="Home B"
                permissionRequests={[]}
                userActionRequests={[]}
            />,
        );

        expect(screen.getTextContent()).toContain('Home B machine');
        expect(screen.getTextContent()).not.toContain('Home A machine');
    });

    it('does not invent raw path context when Activity supplies no resolved context line', async () => {
        const session = createSessionFixture({
            id: 'session-without-context',
            encryptionMode: 'plain',
            serverId: 'server-b',
            metadata: {
                name: 'Secondary Home session',
                path: '/Users/tester/private-project',
                host: 'tester.local',
                homeDir: '/Users/tester',
                machineId: 'shared-machine',
            },
        });

        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId="server-b"
                contextLine={null}
                permissionRequests={[]}
                userActionRequests={[]}
            />,
        );

        expect(screen.getTextContent()).not.toContain('private-project');
        expect(screen.getTextContent()).not.toContain('/Users/tester/private-project');
    });
});
