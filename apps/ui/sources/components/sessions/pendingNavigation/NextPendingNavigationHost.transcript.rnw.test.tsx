/** @vitest-environment jsdom */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { Session } from '@/sync/domains/state/storageTypes';

// Real web hosts are essential: a focus spy cannot distinguish a mounted answer from BODY.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const mock = createReanimatedModuleMock();
    return { ...mock, View: native.View, Text: native.Text, ScrollView: native.ScrollView,
        default: { ...mock.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView } };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await installRealActionExecutorModuleLoader();
await loadSyncSingletonForTests();
const { createSessionFixture, createSessionMessagesFixture, createSessionViewerFixture, standardCleanup } = await import('@/dev/testkit');
const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AgentStateSchema } = await import('@happier-dev/session-core/state');
const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
const { SessionActionConfirmationsV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1');
const { projectSessionSharedMetadataV1 } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { ChatList } = await import('@/components/sessions/transcript/ChatList');
const { invokeNextPendingRequest, usePendingNavigationLanding } = await import('@/activity/source/pendingNavigationRuntime');
const { NextPendingNavigationHost } = await import('./NextPendingNavigationHost');
const { PendingNavigationPill } = await import('./PendingNavigationPill');

const initialState = storage.getState();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected Session RPC'); };
const responses = installSessionActionRpcBoundary((request, context) => answerRpc(request, context));

afterEach(async () => {
    await React.act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    storage.setState(initialState, true);
    await homes.reset();
    responses.length = 0;
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Next focus through the mounted RN-web transcript', () => {
    it.each([
        { nativeTranscript: false, nextKind: 'question' },
        { nativeTranscript: true, nextKind: 'question' },
        { nativeTranscript: false, nextKind: 'permission' },
        { nativeTranscript: true, nextKind: 'permission' },
    ] as const)('hands a native question to the transcript, then focuses the next $nextKind via the pill (persisted native row: $nativeTranscript)', async ({ nativeTranscript, nextKind }) => {
        // jsdom supplies no layout; only OS/browser measurement boundaries are substituted.
        vi.stubGlobal('ResizeObserver', class {
            observe() {} unobserve() {} disconnect() {}
        });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const height = this.style.overflowY === 'auto' || this.style.overflow === 'auto' ? 600 : 120;
            return { x: 0, y: 0, width: 800, height, top: 0, left: 0, right: 800, bottom: height, toJSON: () => ({}) };
        });
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) {
            this.scrollTop = options.top ?? this.scrollTop;
        } });
        const serverUrl = 'https://next-transcript.test';
        const accountId = 'focus-owner';
        const serverId = await homes.addHome({ name: 'Next transcript', serverUrl, accountId });
        await homes.selectHomes([serverId]);
        connection = await restoreServerAccountForTest({ serverUrl, accountId, request: createSessionReadBatchFetchBoundary(homes.request) });
        const now = Date.now();
        const input = { questions: [{ question: 'Do you prefer River or Meadow?', header: 'Choice',
            options: [{ label: 'River', description: 'River' }, { label: 'Meadow', description: 'Meadow' }], multiSelect: false }] };
        const sessions = Object.fromEntries(['first', 'second'].map((id, index) => [id, createSessionFixture({
            id, serverId, active: true, activeAt: now, updatedAt: now,
            metadata: { path: '/tmp', host: 'test', flavor: 'claude' },
            agentState: AgentStateSchema.parse({ requests: { [id]: {
                tool: 'AskUserQuestion', kind: 'user_action', arguments: input, createdAt: now - 20 + index,
            } } }),
        })]));
        if (nextKind === 'permission') sessions.second = createSessionFixture({
            ...sessions.second!,
            metadata: { path: '/tmp', host: 'test', flavor: 'codex' },
            agentState: AgentStateSchema.parse({ requests: { second: {
                tool: 'Bash', kind: 'permission', arguments: { command: 'cat /tmp/note.txt' }, createdAt: now - 19,
            } } }),
        });
        sessions.origin = createSessionFixture({ id: 'origin', serverId, active: true,
            metadata: { path: '/tmp', host: 'test', flavor: 'claude' }, agentState: AgentStateSchema.parse({ requests: {} }) });
        sessions.inactive = createSessionFixture({ id: 'inactive', serverId, active: false, activeAt: now - 1_000,
            metadata: { path: '/tmp', host: 'test', flavor: 'claude' },
            agentState: AgentStateSchema.parse({ requests: { inactive: { tool: 'AskUserQuestion', kind: 'user_action',
                source: 'claude_unified_terminal_dialog_choice', arguments: input, createdAt: now - 1_000 } } }) });
        const actionConfirmationsV1 = SessionActionConfirmationsV1Schema.parse({ v: 1, completedRequests: {}, requests: {
            shared: { tool: 'Happier Action confirmation', kind: 'user_action', source: 'happier_action', turnId: 'turn-shared', createdAt: now - 10,
                arguments: { actionId: 'session.title.set', sessionId: 'shared', turnId: 'turn-shared', preview: { summary: 'Name the session' } },
                responseTarget: { kind: 'happier_action_confirmation_v1', requestId: 'shared', actionId: 'session.title.set',
                    inputDigestV1: `sha256:${'0'.repeat(64)}`, runtimeAccountId: accountId, sessionId: 'shared', turnId: 'turn-shared' } },
        } });
        sessions.shared = createSessionFixture({ id: 'shared', serverId, active: false, metadataLayoutVersion: 1,
            ownerMetadataView: { path: '/tmp', host: 'test', flavor: 'claude' },
            // The real layout-1 reader bridges strict shared metadata to the legacy Session metadata type.
            metadata: projectSessionSharedMetadataV1({ metadata: { path: '/tmp', host: 'test', flavor: 'claude', actionConfirmationsV1 } }) as unknown as Session['metadata'],
            agentState: AgentStateSchema.parse({ requests: {} }) });
        const sharedWire = createPlainSessionCurrentProjectionRecordFixture({ metadata: {
            path: '/tmp', host: 'test', flavor: 'claude', actionConfirmationsV1,
        } });
        // Project both the live sequence-less placeholder and the persisted native
        // transcript through the real normalizer/reducer, never a hand-built ToolCall.
        const transcript = Object.fromEntries(Object.values(sessions).map(session => {
            const reducerState = createReducer();
            const request = session.agentState?.requests?.[session.id];
            const raw = nativeTranscript ? [
                normalizeRawMessage(`${session.id}-prompt`, null, now - 30, {
                    role: 'user', content: { type: 'text', text: 'Ask whether I prefer River or Meadow.' },
                }, { seq: 1 }),
                normalizeRawMessage(`${session.id}-native`, null, now - 20, {
                    role: 'agent', content: session.id === 'second' && nextKind === 'permission'
                        ? { type: 'codex', data: { type: 'tool-call', callId: session.id,
                            name: request!.tool, input: request!.arguments } }
                        : { type: 'output', data: { type: 'assistant', uuid: `${session.id}-native`,
                        message: { role: 'assistant', content: [{ type: 'tool_use', id: session.id,
                            name: request?.tool ?? 'AskUserQuestion', input: request?.arguments ?? input }] },
                    } },
                }, { seq: 2 }),
            ] : [];
            const { messages } = reducer(reducerState, raw.filter(message => message !== null), session.agentState);
            return [session.id, createSessionMessagesFixture({ isLoaded: true, reducerState,
                messageIdsOldestFirst: messages.map(message => message.id),
                messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
            })];
        }));
        function publish() {
            const wires = Object.values(sessions).map(session => {
                const shared = session.id === 'shared';
                const waiting = shared ? 1 : Object.keys(session.agentState?.requests ?? {}).length;
                const permission = shared || (session.id === 'second' && nextKind === 'permission');
                session.pendingPermissionRequestCount = permission ? waiting : 0;
                session.pendingUserActionRequestCount = permission ? 0 : waiting;
                session.pendingRequestObservedAt = now;
                session.viewer = createSessionViewerFixture({ relevance: { relevant: true, reasons: ['owned_by_me'] },
                    ...(waiting ? { attention: { needsAttention: true, reasons: [permission ? 'permission_required' : 'user_action_required'],
                        primary: permission ? 'permission_required' : 'user_action_required', presentation: 'full' } } : {}),
                });
                return SessionCurrentProjectionRecordV1Schema.parse({ ...session, metadataLayoutVersion: session.metadataLayoutVersion ?? 0,
                    ...(shared ? { ownerMetadata: sharedWire.ownerMetadata } : {}),
                    metadata: JSON.stringify(session.metadata), agentState: JSON.stringify(session.agentState),
                    dataEncryptionKey: null, share: null,
                    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
                    responsibleAccountId: null, responsibleAccount: null,
                });
            });
            for (const wire of wires) homes.answer(serverId, `/v2/sessions/${wire.id}`, { body: { session: wire } });
            homes.answer(serverId, '/v2/sessions/active', { body: { sessions: wires, hasNext: false, nextCursor: null } });
            storage.setState({ isDataReady: true, profileScope: { serverId, accountId }, sessions: { ...sessions },
                sessionMessages: transcript,
                settings: { ...initialState.settings, transcriptGroupingMode: 'turns', transcriptGroupToolCalls: true },
                sessionListRowsByServerId: { [serverId]: Object.fromEntries(Object.values(sessions)
                    .map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
                ordinarySessionListMembershipByServerId: { [serverId]: Object.keys(sessions) },
            });
        }
        publish();
        answerRpc = request => {
            if (!request.method.endsWith('session.user_action.answer')) throw new Error(`Unexpected Session RPC: ${request.method}`);
            sessions.first = { ...sessions.first!, agentState: AgentStateSchema.parse({ requests: {} }) };
            publish();
            return { ok: true };
        };
        let currentId = 'origin';
        let loaded = false;
        let bindingReady = false;
        let landing: ReturnType<typeof usePendingNavigationLanding> = null;
        const routes: string[] = [];
        function Destination() {
            bindingReady = useServerCredentialAccountScopeBindings([serverId]).get(serverId)?.isCurrent() === true;
            landing = usePendingNavigationLanding({ serverId, sessionId: currentId });
            return <><PendingNavigationPill address={{ serverId, sessionId: currentId }} presentation="composer" />
                {loaded ? <ChatList session={sessions[currentId]!} sessionSurfaceKey={`next:${currentId}`} /> : null}</>;
        }
        // The registration belongs to the app shell, outside the keyed Session
        // viewer scope that is replaced when a different destination opens.
        const tree = () => <InjectedAuthProvider credentials={connection!.credentials}><DestinationInstanceHost tabId="app-shell"
            ref={{ kind: 'newSession', params: {} }} pathname="/new" focused visible
            navigation={{ push: href => { routes.push(String(href)); }, replace: () => {}, back: () => {} }}>
            <AppPaneProvider><KeyboardShortcutProvider handlers={{}}><NextPendingNavigationHost />
                <DestinationInstanceHost tabId="next-transcript"
                    ref={{ kind: 'session', params: { id: currentId, serverId } }} pathname={`/session/${currentId}`} focused visible
                    navigation={{ push: href => { routes.push(String(href)); }, replace: () => {}, back: () => {} }}>
                    <AppSessionTranscriptSourceProvider sessionId={currentId} serverId={serverId}><Destination /></AppSessionTranscriptSourceProvider>
                </DestinationInstanceHost>
            </KeyboardShortcutProvider></AppPaneProvider>
        </DestinationInstanceHost></InjectedAuthProvider>;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await React.act(async () => root!.render(tree()));
        await waitForHomeGovernance(() => expect(bindingReady).toBe(true));
        // Account restoration publishes settings asynchronously; enable the real
        // shortcut only after that boundary has settled.
        await React.act(async () => storage.setState({ settings: { ...storage.getState().settings } }));
        const chord = new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
        await React.act(async () => {
            window.dispatchEvent(chord);
            await vi.waitFor(() => expect(routes.at(-1)).toBe(`/session/first?serverId=${encodeURIComponent(serverId)}`));
        });
        expect(chord.defaultPrevented).toBe(true);
        currentId = 'first';
        await React.act(async () => root!.render(tree()));
        expect(landing).toMatchObject({ requestId: 'first', focusTarget: 'prompt' });
        loaded = true;
        await React.act(async () => root!.render(tree()));
        await vi.waitFor(() => {
            const answer = container!.querySelector('[data-testid="ask-user-question.option:0:0"]');
            expect(answer).not.toBeNull();
            expect(document.activeElement).toBe(answer);
        });
        expect(landing).toMatchObject({ requestId: 'first', focusTarget: 'transcript' });
        expect(responses).toHaveLength(0);
        await React.act(async () => container!.querySelector<HTMLElement>('[data-testid="ask-user-question.option:0:0"]')!.click());
        await React.act(async () => container!.querySelector<HTMLElement>('[data-testid="ask-user-question.submit"]')!.click());
        await vi.waitFor(() => expect(container!.querySelector('[data-testid="pending-navigation-composer"]')).not.toBeNull());
        expect(responses).toHaveLength(1);
        await React.act(async () => {
            const go = container!.querySelector<HTMLElement>('[data-testid="pending-navigation-composer"]')!;
            go.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
            go.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            go.focus();
            expect(document.activeElement).toBe(go);
            go.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
            go.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            go.click();
        });
        await vi.waitFor(() => expect(routes.at(-1)).toBe(`/session/second?serverId=${encodeURIComponent(serverId)}`));
        currentId = 'second';
        await React.act(async () => root!.render(tree()));
        const nextAnswerTestId = nextKind === 'permission' ? 'permission-footer.allow' : 'ask-user-question.option:0:0';
        await vi.waitFor(() => {
            const answer = container!.querySelector(`[data-testid="${nextAnswerTestId}"]`);
            expect(answer).not.toBeNull();
            expect(document.activeElement).toBe(answer);
        });
        expect(landing).toMatchObject({ requestId: 'second', focusTarget: 'transcript' });
        if (!nativeTranscript && nextKind === 'permission') {
            // The pending placeholder lands first; the native transcript then supplies
            // its persisted ordering coordinates without issuing another Next intent.
            const previous = transcript.second!;
            const raw = normalizeRawMessage('second-native', null, now - 20, {
                role: 'agent', content: { type: 'codex', data: {
                    type: 'tool-call', callId: 'second', name: 'Bash', input: { command: 'cat /tmp/note.txt' },
                } },
            }, { seq: 2 });
            if (!raw || !previous.reducerState) throw new Error('Missing native transcript fixture');
            const hydrated = reducer(previous.reducerState, [raw], sessions.second!.agentState);
            const messagesById = { ...previous.messagesById,
                ...Object.fromEntries(hydrated.messages.map(message => [message.id, message])) };
            transcript.second = createSessionMessagesFixture({ ...previous,
                messageIdsOldestFirst: Object.keys(messagesById), messagesById,
                messagesVersion: previous.messagesVersion + 1,
            });
            await React.act(async () => publish());
            await vi.waitFor(() => {
                const answer = container!.querySelector('[data-testid="permission-footer.allow"]');
                expect(answer).not.toBeNull();
                expect(document.activeElement).toBe(answer);
            });
        }
        expect(responses).toHaveLength(1);
        await React.act(async () => expect(await invokeNextPendingRequest({ excluding: { serverId, sessionId: 'second' } })).toEqual({ status: 'opened' }));
        expect(routes.at(-1)).toBe(`/session/shared?serverId=${encodeURIComponent(serverId)}`);
    });
});
