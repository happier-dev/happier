import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ExecutionRunCancelTurnRequestSchema, ExecutionRunEnsureRequestSchema, ExecutionRunGetRequestSchema,
    ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema,
    ExecutionRunStopRequestSchema, FeaturesResponseSchema,
    SessionAgentActivityHeadlineV1Schema, SessionStoredMessageContentSchema, V2SessionByIdResponseSchema,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { createMachineFixture, createPendingMessageFixture, createSessionFixture, flattenTestStyle,
    renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { SessionExecutionRunInfoCard } from './SessionExecutionRunInfoCard';
import { SessionExecutionRunDetailsView, type SessionExecutionRunDetailsViewHandle } from './SessionExecutionRunDetailsView';
import { SessionBrowserContextRuntimeProvider, useSessionBrowserContextRuntime,
    type SessionBrowserContextRuntime } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Modal } from '@/modal';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, values) => values
        ? key + '(' + Object.entries(values).map(([name, value]) => name + '=' + String(value)).join(',') + ')' : key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

const boundary = vi.hoisted(() => {
    const requests: Array<Readonly<{ serverUrl: string; targetId: string; method: string; payload: unknown }>> = [];
    return { call: vi.fn<(method: string, input: unknown) => Promise<unknown>>(), requests };
});
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (serverUrl: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: ['s1'] };
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                throw new Error('Malformed Socket RPC boundary request');
            }
            const separator = raw.method.indexOf(':');
            const method = raw.method.slice(separator + 1);
            boundary.requests.push({ serverUrl, targetId: raw.method.slice(0, separator), method, payload: raw.params });
            return { ok: true, result: await boundary.call(method, raw.params) };
        });
        return socket;
    } };
});
// Only Socket, HTTP, credentials, local persistence and native/browser adapters are replaced.
// App bootstrap, exact Home/Account admission, store, Run operations, roster, transcript,
// composer, state transitions, result projection and rendered controls are all real.
await loadSyncSingletonForTests();

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let screen: Screen;
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let serverId: string;
let sequence = 0;
let runState: ExecutionRunPublicState;
let getReply: () => Promise<unknown>;
let stopReply: () => Promise<unknown>;
let cancelReply: () => Promise<unknown>;
let resumeReply: () => Promise<unknown>;
let latestToolResult: unknown;
let structuredMeta: unknown;
let browserRuntime: SessionBrowserContextRuntime | null = null;
const httpReads: ServedHomeRequest[] = [];
let httpSessionAvailable = true;
const pendingRows: Array<Readonly<{
    localId: string; recipient: { kind: 'execution_run'; runId: string }; messageRole: 'user';
    content: ReturnType<typeof SessionStoredMessageContentSchema.parse>;
    status: 'queued'; position: number; createdAt: number; updatedAt: number;
}>> = [];
const mutationMethods = [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, SESSION_RPC_METHODS.EXECUTION_RUN_SEND];

function createRun(patch: Partial<ExecutionRunPublicState> = {}): ExecutionRunPublicState {
    return ExecutionRunPublicStateSchema.parse({
        runId: 'run_1', callId: 'toolu_1', sidechainId: 'toolu_1', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming',
        status: 'running', startedAtMs: 1, ...patch,
    });
}
function liveRun(patch: Partial<ExecutionRunPublicState> = {}) {
    return createRun({ runClass: 'long_lived', retentionPolicy: 'resumable',
        lifecycle: { v: 1, state: 'current' }, interaction: {
            kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn', 'steer'], cancel: true },
        }, ...patch });
}
function wireResult() {
    return ExecutionRunGetResponseSchema.parse({ run: runState,
        ...(latestToolResult !== undefined ? { latestToolResult } : {}),
        ...(structuredMeta !== undefined ? { structuredMeta } : {}) });
}
function calls(method: string) { return boundary.call.mock.calls.filter(([candidate]) => candidate === method); }
function composer() { return screen.findAllByType(SessionParticipantComposer); }
function info() { return screen.findByType(SessionExecutionRunInfoCard).props; }
async function mount(props: Partial<React.ComponentProps<typeof SessionExecutionRunDetailsView>> = {}, browser = false) {
    function BrowserOwner({ children }: React.PropsWithChildren) {
        const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 's1', scopeKey: serverId });
        browserRuntime = runtime;
        return <SessionBrowserContextRuntimeProvider runtime={runtime}>{children}</SessionBrowserContextRuntimeProvider>;
    }
    const view = <SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId="run_1" presentation="panel" {...props} />;
    screen = await renderScreen(browser ? <BrowserOwner>{view}</BrowserOwner> : view);
    return screen;
}
async function loaded() { await vi.waitFor(() => expect(screen.findAllByType(SessionExecutionRunInfoCard)).toHaveLength(1)); }
async function refresh() {
    await act(async () => notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'run_1' }));
    await vi.waitFor(() => expect(info().run).toEqual(runState));
}
async function menu() {
    await screen.pressByTestIdAsync('session-run-details-actions-menu');
}
function publishMarker(status: ExecutionRunPublicState['status'] = 'running') {
    const marker: NormalizedMessage = {
        id: 'tool-msg-1', localId: null, createdAt: 1, seq: 1, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-call', id: 'toolu_1', name: 'SubAgentRun', description: null,
            uuid: 'run-marker', parentUUID: null, input: {
                runId: 'run_1', backendTarget: runState.backendTarget, intent: runState.intent,
                runClass: runState.runClass, ioMode: runState.ioMode, permissionMode: runState.permissionMode,
                retentionPolicy: runState.retentionPolicy, label: 'Reviewer A',
            } }],
    };
    const result: NormalizedMessage = {
        id: 'tool-result-1', localId: null, createdAt: 2, seq: 2, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-result', tool_use_id: 'toolu_1', content: { ...runState, status },
            is_error: false, uuid: 'run-result', parentUUID: 'run-marker' }],
    };
    getStorage().getState().applyMessages('s1', [marker, result]);
    getStorage().getState().applyMessagesLoaded('s1');
}
let restorePopoverWebGlobals: (() => void) | undefined;
beforeEach(async () => {
    restorePopoverWebGlobals = withPopoverWebGlobals();
    resetSessionDraftRepositoryForTests();
    browserRuntime = null;
    latestToolResult = undefined;
    structuredMeta = undefined;
    httpSessionAvailable = true;
    pendingRows.length = 0;
    runState = createRun();
    getReply = async () => wireResult();
    stopReply = async () => ({ ok: true });
    cancelReply = async () => ({ ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' });
    resumeReply = async () => ({ ok: true });
    boundary.call.mockReset();
    boundary.requests.length = 0;
    boundary.call.mockImplementation(async (method, input) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) { ExecutionRunGetRequestSchema.parse(input); return getReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) { ExecutionRunStopRequestSchema.parse(input); return stopReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1) { ExecutionRunCancelTurnRequestSchema.parse(input); return cancelReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE) { ExecutionRunEnsureRequestSchema.parse(input); return resumeReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [runState] };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { available: true, protocolVersion: 2,
                backends: { codex: { available: true, intents: ['review', 'delegate'] } } } },
        } };
        if (method === RPC_METHODS.STOP_SESSION) return { ok: true };
        return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    });
    httpReads.length = 0;
    home = await serveActionHomes({
        homes: [{ key: 'home', serverUrl: 'https://run-details-' + (++sequence) + '.test', accountId: 'account-1' }],
        route(request) {
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { session: { pendingInput: { protocolVersion: 3 } },
                    accountStoredContentCompatibility: { v: 1, currentProtocolVersion: 3, minimumProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
            }));
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === '/v2/sessions/s1' && !httpSessionAvailable) return new Response(null, { status: 404 });
            if (request.path === '/v2/sessions/s1') return Response.json(V2SessionByIdResponseSchema.parse({ session: {
                id: 's1', encryptionMode: 'plain', metadata: JSON.stringify(getStorage().getState().sessions.s1?.metadata ?? {}),
                metadataVersion: 1, agentState: null, agentStateVersion: 1, dataEncryptionKey: null, active: true,
                activeAt: 1, createdAt: 1, updatedAt: 1, seq: 1,
            } }));
            if (request.path.includes('/messages') || request.path.includes('/pending')) {
                httpReads.push(request);
                return Response.json(request.path.endsWith('/pending')
                    ? { pending: request.path.includes('/execution-runs/run_1/') ? pendingRows : [],
                        discarded: [], pendingVersion: 1, pendingCount: pendingRows.length }
                    : { messages: [], hasMore: false, nextCursor: null });
            }
            if (request.path === '/v1/artifacts') return Response.json([]);
            return undefined;
        },
    });
    serverId = home.homes.home!.id;
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl))!);
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now(), storageMode: 'plain' });
    getStorage().setState({
        sessions: { s1: createSessionFixture({ id: 's1', serverId, active: true,
            metadata: { path: '/repo', host: 'tester.local', machineId: 'm1', flavor: 'codex' } }) },
        machines: { m1: machine }, machineListByServerId: { [serverId]: [machine] },
        sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true }) },
        sessionPending: { s1: { messages: [], discarded: [], isLoaded: true } },
        settings: { ...settingsDefaults, backendEnabledByTargetKey: {} },
        settingsScope: { serverId, accountId: 'account-1' }, profileScope: { serverId, accountId: 'account-1' },
    });
    await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account-1' });
});
afterEach(async () => {
    standardCleanup();
    restorePopoverWebGlobals?.();
    await disconnectActiveServerConnection();
    home?.dispose();
});

describe('SessionExecutionRunDetailsView — real Home, transcript and interaction owners', () => {
    it('reads the Run waiting on a person from the real roster, rather than Run status alone', async () => {
        const question = createToolCallMessageFixture({ id: 'question', tool: {
            id: 'question-tool', name: 'AskUserQuestion', state: 'running', input: {}, createdAt: 1,
            startedAt: 1, completedAt: null, description: null,
            permission: { id: 'question-permission', status: 'pending', kind: 'user_action' },
        } });
        const marker = createToolCallMessageFixture({ id: 'tool-msg-1', tool: {
            id: 'toolu_1', name: 'SubAgentRun', state: 'running', input: { ...runState, label: 'Reviewer A' },
            createdAt: 1, startedAt: 1, completedAt: null, description: null,
        }, children: [question] });
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: [marker.id], messagesById: { [marker.id]: marker } }) } });
        await mount(); await loaded();
        expect(info().attention).toMatchObject({ label: 'sessionAgentActivity.attention.userAction' });
    });
    it('renders the actual info and tool transcript under the app Session source, carrying mounted browser context', async () => {
        publishMarker();
        await mount({}, true); await loaded();
        const details = screen.findByType(SessionMessageDetailsView);
        expect(info().run).toMatchObject({ runId: 'run_1', backendTarget: runState.backendTarget });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual(
            expect.arrayContaining([expect.objectContaining({ serverUrl: home.homes.home!.serverUrl, targetId: 's1',
                payload: { runId: 'run_1', includeStructured: true } })]),
        );
        expect(details.props).toMatchObject({ sessionId: 's1', recipientOverride: { kind: 'execution_run', runId: 'run_1' } });
        expect(details.props.browserContextState).toBe(browserRuntime?.composerContext.state);
        expect(details.props).not.toHaveProperty('presentation');
    });
    it.each([false, 0, '', null])('shows a defined latest result %j, and hides it only when absent', async (result) => {
        latestToolResult = result;
        await mount(); await loaded();
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(1);
        latestToolResult = undefined; await refresh();
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(0);
    });
    it('projects a recognizable result while keeping raw JSON subordinate', async () => {
        latestToolResult = { stdout: 'Four checks passed', exitCode: 0, marker: 'plugin-private-field' };
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-latest-tool-result-raw')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-latest-tool-result-raw-toggle');
        expect(screen.getTextContent()).toContain('Four checks passed');
    });
    it('mounts the exact retained Run composer before any tool marker, with canonical queue/steer controls', async () => {
        runState = liveRun();
        await mount({ retryInputLocalId: 'first-input-1' }); await loaded();
        await vi.waitFor(() => expect(composer()).toHaveLength(1));
        expect(composer()[0]!.props).toMatchObject({ sessionId: 's1', serverId, canSendMessages: true,
            recipient: { kind: 'execution_run', runId: 'run_1' }, initialLocalId: 'first-input-1',
            executionRunRequestedAction: { v: 1, kind: 'enqueue' },
            extraActionChips: expect.arrayContaining([expect.objectContaining({ key: 'execution-run-requested-action', controlId: 'delivery' })]),
        });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toEqual([]);
        await vi.waitFor(() => expect(httpReads.some(request => request.path === '/v2/sessions/s1/execution-runs/run_1/pending')).toBe(true));
    });
    it('shows a canonical waiting state before a Run has a transcript marker or queued rows', async () => {
        // Current public Run state always names its transcript IDs, even before their rows arrive.
        runState = createRun();
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-pre-marker-state')).not.toBeNull();
        expect(screen.getTextContent()).toContain('status.awaitingUpdates');
        expect(composer()).toHaveLength(0);
    });
    it('renders committed direct-start sidechain rows and the exact Run pending queue with one mounted composer', async () => {
        runState = liveRun();
        const child: NormalizedMessage = { id: 'sc-agent', localId: null, createdAt: 2, seq: 2, role: 'agent',
            isSidechain: true, sidechainId: 'toolu_1', content: [{ type: 'text', text: 'Working on it', uuid: 'sc-text', parentUUID: null }] };
        getStorage().getState().applyMessages('s1', [child]);
        getStorage().getState().applyMessagesLoaded('s1');
        const pending = createPendingMessageFixture({ id: 'queued-1', localId: 'queued-1',
            recipient: { kind: 'execution_run', runId: 'run_1' }, text: 'Continue this run' });
        pendingRows.push({ localId: pending.localId!, recipient: { kind: 'execution_run', runId: 'run_1' },
            messageRole: 'user', content: SessionStoredMessageContentSchema.parse({ t: 'plain', v: {
                role: 'user', content: { type: 'text', text: pending.text }, meta: {},
            } }), status: 'queued', position: 0, createdAt: 1, updatedAt: 1 });
        getStorage().getState().applyPendingSnapshot('s1', { messages: [pending], discarded: [] });
        await mount(); await loaded();
        await vi.waitFor(() => expect(screen.findByType(ChainTranscriptList).props.pendingMessages).toEqual(
            expect.arrayContaining([expect.objectContaining({ localId: 'queued-1', text: 'Continue this run' })]),
        ));
        const list = screen.findByType(ChainTranscriptList);
        expect(list.props).toMatchObject({ sessionId: 's1', serverId, pendingRecipient: { kind: 'execution_run', runId: 'run_1' } });
        expect(list.props.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Working on it' })]));
        expect(composer()).toHaveLength(1);
        const input = composer()[0];
        await screen.update(<SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId="run_1" presentation="panel" />);
        expect(composer()).toHaveLength(1); expect(composer()[0]).toBe(input);
    });
    it.each([
        ['unproven long-lived', { runClass: 'long_lived', retentionPolicy: 'resumable' }],
        ['bounded in-flight', { turnInFlight: true }],
        ['finished', { status: 'succeeded', turnInFlight: false }],
    ] satisfies ReadonlyArray<readonly [string, Partial<ExecutionRunPublicState>]>)
    ('keeps %s history read-only without a daemon-proven live retained interaction', async (_name, patch) => {
        runState = createRun(patch); publishMarker();
        await mount(); await loaded();
        expect(composer()).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
    });
    it('does not expose input from an ambient same-ID Session in another Home', async () => {
        runState = liveRun();
        httpSessionAvailable = false;
        getStorage().setState(state => ({ sessions: { s1: { ...state.sessions.s1!, serverId: 'another-home' } } }));
        await mount();
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-load-error')).not.toBeNull());
        expect(composer()).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual([]);
    });
    it('keeps a body-only host from mounting a second composer or a redundant info card', async () => {
        runState = liveRun(); publishMarker();
        await mount({ showSendComposer: false, showInfoCard: false });
        await vi.waitFor(() => expect(screen.findAllByType(SessionMessageDetailsView)).toHaveLength(1));
        expect(composer()).toHaveLength(0); expect(screen.findAllByType(SessionExecutionRunInfoCard)).toHaveLength(0);
    });
    it('applies only exact Run activity and preserves the loaded composer through live refresh and completion', async () => {
        runState = liveRun(); await mount(); await loaded();
        const mountedComposer = composer()[0]!;
        const before = calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET).length;
        await act(async () => {
            notifyExecutionRunActivity({ sessionId: 'other-session', serverId }, { runId: 'run_1' });
            notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'other-run' });
        });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(before);
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        await refresh(); expect(composer()[0]).toBe(mountedComposer);
        runState = liveRun({ status: 'succeeded' }); await refresh();
        expect(screen.findByTestId('session-run-details-loading')).toBeNull(); expect(composer()).toHaveLength(0);
    });
    it('ignores a Run response that resolves after a newer exact-address response', async () => {
        await mount(); await loaded();
        let resolveOlder!: (value: unknown) => void;
        const old = new Promise<unknown>(resolve => { resolveOlder = resolve; });
        getReply = () => old;
        await act(async () => notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'run_1' }));
        runState = createRun({ status: 'succeeded' }); getReply = async () => wireResult(); await refresh();
        await act(async () => resolveOlder({ run: createRun({ status: 'running' }) }));
        expect(info().run.status).toBe('succeeded');
    });
    it('cancels only the witnessed current turn through the rendered Run menu, not the whole Run', async () => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        await mount(); await loaded(); await menu();
        expect(screen.findByTestId('session-run-details-resume')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-cancel-turn');
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)).toHaveLength(1));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)[0]![1]).toEqual({ runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
                payload: { runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' } },
        ]);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)).toEqual([]);
    });
    it('does not expose turn cancellation without the exact current occurrence and turn witness', async () => {
        runState = liveRun(); await mount(); await loaded(); await menu();
        expect(screen.findByTestId('session-run-details-cancel-turn')).toBeNull();
        expect(screen.findByTestId('session-run-details-stop')).not.toBeNull();
    });
    it('disables only the pending turn interaction while preserving the whole-Run stop affordance', async () => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        let settle!: (value: unknown) => void;
        cancelReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded(); await menu(); screen.pressByTestId('session-run-details-cancel-turn');
        await vi.waitFor(() => expect(info().cancelResponseAction?.pending).toBe(true));
        expect(info().stopAction?.stopping).toBe(false);
        await act(async () => settle({ ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' }));
        await vi.waitFor(() => expect(info().cancelResponseAction?.pending).toBe(false));
    });
    it('offers explicit recoverable Resume, with pending accessibility state and shared target sizes', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        let settle!: (value: unknown) => void;
        resumeReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded();
        const target = screen.findByTestId('session-run-details-resume')!;
        const size = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(flattenTestStyle(target.props.style)).toMatchObject({ minWidth: size, minHeight: size });
        screen.pressByTestId('session-run-details-resume');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-resume')?.props.accessibilityState).toMatchObject({ disabled: true, busy: true }));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)[0]![1]).toEqual({ runId: 'run_1', resume: true });
        await act(async () => settle({ ok: true }));
    });
    it('refuses Resume through Action policy before issuing its transport', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        getStorage().setState(state => ({ settings: { ...state.settings, actionsSettingsV1: {
            v: 1, actions: { 'execution.run.ensure': { disabledSurfaces: ['ui'] } },
        } } }));
        await mount(); await loaded();
        await screen.pressByTestIdAsync('session-run-details-resume');
        await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('action_disabled'));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)).toHaveLength(0);
    });
    it.each([
        ['execution.run.stop', 'session-run-details-stop', SESSION_RPC_METHODS.EXECUTION_RUN_STOP],
        ['execution.run.cancel_turn', 'session-run-details-cancel-turn', SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1],
    ] as const)('refuses %s through Action policy before issuing its transport', async (actionId, testId, method) => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: {
            turnId: 'turn-1', inputIds: ['input-1'], state: 'active',
        } } });
        getStorage().setState(state => ({ settings: { ...state.settings, actionsSettingsV1: {
            v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } },
        } } }));
        await mount(); await loaded(); await menu();
        await screen.pressByTestIdAsync(testId);
        await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('action_disabled'));
        expect(calls(method)).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-stop-failed')).toBeNull();
    });
    it.each(['android', 'ios', 'web'] as const)('keeps the view-owned Resume target accessible on %s', async (platform) => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        const originalPlatform = Platform.OS;
        try {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
            await mount(); await loaded();
            const target = screen.findByTestId('session-run-details-resume');
            expect(target).not.toBeNull();
            const size = resolveMinimumInteractiveTargetSize(platform);
            expect(flattenTestStyle(target!.props.style)).toMatchObject({ minWidth: size, minHeight: size });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
    it('stops on the exact Home and reloads terminal state when Stop races with completion', async () => {
        runState = liveRun();
        stopReply = async () => { runState = liveRun({ status: 'succeeded' }); return { ok: false, error: 'Already finished', errorCode: 'execution_run_not_allowed' }; };
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(info().run.status).toBe('succeeded'));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)[0]![1]).toEqual({ runId: 'run_1' });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
                payload: { runId: 'run_1' } },
        ]);
        expect(info().stopAction).toBeNull();
        expect(home.requests.every(request => request.accountId === 'account-1')).toBe(true);
    });
    it('keeps whole-Run Stop busy until its actual transport request settles', async () => {
        runState = liveRun();
        let settle!: (value: unknown) => void;
        stopReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded(); await menu(); screen.pressByTestId('session-run-details-stop');
        await vi.waitFor(() => expect(info().stopAction?.stopping).toBe(true));
        await act(async () => settle({ ok: true }));
        await vi.waitFor(() => expect(info().stopAction?.stopping).toBe(false));
    });
    it('falls back to retained transcript history, withholding mutable controls and daemon-marker queries without an exact Home', async () => {
        publishMarker('succeeded');
        getReply = async () => ({ ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
        await mount({ serverId: undefined }); await loaded();
        expect(info().run).toMatchObject({ runId: 'run_1', status: 'succeeded' });
        expect(composer()).toHaveLength(0);
        expect(mutationMethods.flatMap(method => calls(method))).toEqual([]);
        expect(calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toEqual([]);
    });
    it('loads main transcript history before failing closed on an absent Run, then offers a way out', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        getReply = async () => ({ ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
        const close = vi.fn();
        await mount({ onRequestClose: close });
        await vi.waitFor(() => expect(httpReads.some(request => request.path.includes('/messages'))).toBe(true));
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-gone')).not.toBeNull());
        expect(screen.findByTestId('session-run-details-loading')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-gone-action'); expect(close).toHaveBeenCalledOnce();
        expect(mutationMethods.flatMap(method => calls(method))).toEqual([]);
    });
    it('names the opening wait and reading source, then recovers a failed load in place', async () => {
        let settle!: (value: unknown) => void;
        getReply = () => new Promise(resolve => { settle = resolve; });
        await mount({ openingTitle: 'Review the settings modal fix' });
        expect(screen.findByTestId('session-run-details-loading')).not.toBeNull();
        expect(screen.getTextContent()).toContain('surfaceState.opening(name=Review the settings modal fix)');
        await act(async () => settle({ ok: false, error: 'Home unreachable', errorCode: 'unavailable' }));
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-load-error-action')).not.toBeNull());
        getReply = async () => wireResult();
        await screen.pressByTestIdAsync('session-run-details-load-error-action'); await loaded();
        expect(screen.findByTestId('session-run-details-load-error-action')).toBeNull();
    });
    it('announces one semantic status change without repeating an unchanged refresh', async () => {
        const ref = React.createRef<SessionExecutionRunDetailsViewHandle>();
        await mount({ ref }); await loaded();
        runState = createRun({ status: 'succeeded', finishedAtMs: 2 });
        await act(async () => ref.current?.reload());
        const status = screen.findByTestId('session-run-details-accessibility-status');
        expect(status?.props.children.props.children).toContain('succeeded');
        const before = status?.props.children;
        await act(async () => ref.current?.reload());
        expect(screen.findByTestId('session-run-details-accessibility-status')?.props.children).toBe(before);
    });
    it('shows a finished review result without mounting a conversation composer', async () => {
        runState = createRun({ status: 'succeeded' });
        structuredMeta = { kind: 'review_findings.v2', payload: {
            runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex' },
            summary: 'Two findings, one high.', overviewMarkdown: 'The retry banner can double-charge.',
            findings: [], generatedAtMs: 2,
        } };
        await mount(); await loaded();
        expect(screen.getTextContent()).toContain('Two findings, one high.');
        expect(composer()).toHaveLength(0);
    });
    it('states the other live agents affected before an unconfirmed Run stop falls back to Session stop', async () => {
        runState = liveRun();
        const headline = SessionAgentActivityHeadlineV1Schema.parse({ v: 1, backendId: 'codex', updatedAt: 1,
            activeEntries: Array.from({ length: 4 }, (_, index) => ({ entryId: 'execution_run:run_' + (index + 1),
                kind: 'execution_run', title: 'Run ' + (index + 1), status: 'running', updatedAt: 1 })) });
        getStorage().setState(state => ({ sessions: { s1: { ...state.sessions.s1!, metadata: {
            ...state.sessions.s1!.metadata!, sessionAgentActivityHeadlineV1: headline,
        } } } }));
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('count=3');
        await screen.pressByTestIdAsync('session-run-details-stop-failed-secondary-action');
        expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1);
    });
});

describe('Neighboring user Run Stop admission', () => {
    async function mountStopSurface(surface: 'runs' | 'machine' | 'subagent') {
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const profile = await setServerProfileIdentityForUrl(home.homes.home!.serverUrl, serverId);
        expect(profile?.serverIdentityId).toBe(serverId);
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST
            ? { runs: [{ ...runState,
                happyHomeDir: '/tmp/happier', happySessionId: 's1', pid: 123 }] }
            : original(method, input));
        getStorage().setState({ machineListStatusByServerId: { [serverId]: 'idle' } });
        if (surface === 'subagent') {
            const { useSessionSubagentActions } = await import('@/components/sessions/agents/actions/useSessionSubagentActions');
            let select: ((id: string) => void) | undefined;
            function SubagentStop() {
                select = useSessionSubagentActions({ sessionId: 's1', serverId, onOpenFull: null, onOpenAdvanced: null,
                    subagent: { id: 'execution_run:run_1', kind: 'execution_run', status: 'running',
                        display: { title: 'Reviewer' }, transcript: { sidechainId: 'toolu_1' },
                        runRef: { runId: 'run_1', backendId: 'codex', intent: 'review' },
                        recipient: { kind: 'execution_run', runId: 'run_1' }, timestamps: {},
                        capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false,
                            canDelete: false, canOpenAdvancedRun: true } } }).select;
                return null;
            }
            screen = await renderScreen(<SubagentStop />);
            return async () => { await act(async () => select?.('stop')); };
        }
        const { router } = await import('expo-router');
        router.setParams(surface === 'machine' ? { id: 'm1', serverId } : {});
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        const Screen = surface === 'runs' ? (await import('@/app/(app)/runs')).default
            : (await import('@/app/(app)/machine/[id]')).default;
        screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider><Screen /></AppPaneProvider></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length,
            screen.getTextContent()).toBeGreaterThan(0));
        return async () => { await act(async () => {
            await screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress();
        }); };
    }

    it.each(['runs', 'machine', 'subagent'] as const)('refuses %s Stop through Action policy before transport or Session fallback', async surface => {
        getStorage().setState(state => ({ settings: { ...state.settings, actionsSettingsV1: { v: 1, actions: {
            'execution.run.stop': { enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [] },
        } } } }));
        const stop = await mountStopSurface(surface);
        const listsBeforeStop = calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).length;
        await stop();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalled());
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        expect(calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toHaveLength(listsBeforeStop);
    });

    it.each(['runs', 'machine', 'subagent'] as const)('sends admitted %s Stop to the exact Session and Home', async surface => {
        const stop = await mountStopSurface(surface);
        await stop();
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1));
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
                payload: { runId: 'run_1' } },
        ]);
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
    });

    it.each(['runs', 'machine'] as const)('preserves %s explicit Session fallback after an issued Run Stop fails', async surface => {
        stopReply = async () => ({ ok: false, error: 'Unsupported response from session RPC' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        const stop = await mountStopSurface(surface);
        await stop();
        await vi.waitFor(() => expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1);
        expect(vi.mocked(Modal.confirm)).toHaveBeenCalledOnce();
    });
});
