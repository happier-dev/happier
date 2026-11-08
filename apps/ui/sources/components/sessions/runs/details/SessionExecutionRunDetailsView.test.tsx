import * as React from 'react';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema, SessionConsumptionReplaceAckV1Schema } from '@happier-dev/protocol/sessions/sessionConsumptionV1';
import { t } from '@/text';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ExecutionRunCancelTurnRequestSchema} from '@happier-dev/protocol/execution/runs/cancelTurn';
import { ExecutionRunEnsureRequestSchema,
    ExecutionRunSendRequestSchema,
    ExecutionRunStopRequestSchema} from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunGetRequestSchema,
    ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    SessionAgentActivityHeadlineV1Schema} from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { SessionMessagesPageV1Schema} from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { SessionStoredMessageContentSchema} from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, SocketRpcRequestIdSchema } from '@happier-dev/protocol/socketRpc';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { Message } from '@happier-dev/session-core/messages';

import { createDeferred, createMachineFixture, createPendingMessageFixture, createSessionFixture, flattenTestStyle,
    renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox, executeOwnMachineApprovalDecisionBoundary } from '@/dev/testkit/harness/approvalInbox';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { createScmRunActionHttpBoundary } from '@/dev/testkit/harness/scmActionTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { readComposerText } from '@/dev/testkit/readComposerText';
import { AgentInput } from '@/components/sessions/agentInput';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { SessionExecutionRunInfoCard } from './SessionExecutionRunInfoCard';
import { SessionExecutionRunDetailsView, type SessionExecutionRunDetailsViewHandle } from './SessionExecutionRunDetailsView';
import { SessionBrowserContextRuntimeProvider, useSessionBrowserContextRuntime,
    type SessionBrowserContextRuntime } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { Modal } from '@/modal';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { resolveCompactAppDestinations, useDestinationInstanceTitles } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { BrowserContextItemV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { attachBrowserContextToComposer, createBrowserContextState, markBrowserContextViewNavigation } from '@/sync/domains/browser/context';

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
// The native recycler needs measured cells; retain the real transcript and render its rows at this platform boundary.
const recyclerBoundary = vi.hoisted(() => ({ measured: false }));
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        get renderItems() { return recyclerBoundary.measured; } }).module;
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
const routeBoundary = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeBoundary.pathname }).module;
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

const boundary = vi.hoisted(() => {
    const requests: Array<Readonly<{ serverUrl: string; targetId: string; method: string; payload: unknown }>> = [];
    const messages: Array<Readonly<{ serverUrl: string; payload: unknown }>> = [];
    const frames: Array<Readonly<{ serverUrl: string; event: string; payload: unknown }>> = [];
    return { call: vi.fn<(method: string, input: unknown) => Promise<unknown>>(), requests, messages, frames };
});
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (serverUrl: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emit.mockImplementation((event, payload) => { boundary.frames.push({ serverUrl, event, payload }); });
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event === 'message') boundary.messages.push({ serverUrl, payload: raw });
            boundary.frames.push({ serverUrl, event, payload: raw });
            if (event === SESSION_CONSUMPTION_REPLACE_EVENT) {
                return SessionConsumptionReplaceAckV1Schema.parse({ ok: true, ...SessionConsumptionReplaceV1Schema.parse(raw) });
            }
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
let approvalArtifacts: ArtifactStoreBoundary;
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
let sessionMetadata: ReturnType<typeof createSessionMetadataHttpBoundary>;
let initialHistoryResponse: Promise<Response> | undefined;
let pendingAdmissionResponse: Promise<void> | undefined;
let sidechainHistory: ReturnType<typeof SessionMessagesPageV1Schema.parse> | undefined;
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
async function loaded() { await vi.waitFor(() => expect(screen.findAllByType(SessionExecutionRunInfoCard), screen.getTextContent()).toHaveLength(1)); }
async function refresh() {
    await act(async () => notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'run_1' }));
    await vi.waitFor(() => expect(info().run).toEqual(runState));
}
async function menu() {
    await screen.pressByTestIdAsync('session-run-details-actions-menu');
    // Test Renderer cannot emit the native layout event that reveals measured portal content.
    await act(async () => reportPopoverContentLayout(screen, { width: 340, height: 300 }));
}
async function setActionPolicy(actionsSettingsV1: NonNullable<typeof settingsDefaults.actionsSettingsV1>) {
    const { sync } = await import('@/sync/sync');
    await sync.prepareAccountSettingsForDaemonSpawn();
    expect(getStorage().getState().settingsScope).toEqual({ serverId, accountId: 'account-1' });
    expect(getStorage().getState().settingsVersion).not.toBeNull();
    sync.applySettings({ actionsSettingsV1 }, { expectedSettingsScope: getStorage().getState().settingsScope });
    await sync.prepareAccountSettingsForDaemonSpawn();
    expect(getStorage().getState().settings.actionsSettingsV1).toMatchObject(actionsSettingsV1);
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
const animationFrames = new Set<ReturnType<typeof setTimeout>>();
beforeEach(async ({ task }) => {
    const commandSuite = task.suite?.name === 'Teammate command Action admission';
    const walkthroughConversation = task.name.startsWith('sends a walkthrough conversation through');
    const stopFallbackPolicySuite = task.suite?.name === 'Session Stop fallback Action policy';
    const portableIdentity = 'srv_run_details_' + (sequence + 1);
    const stopPolicy = (commandSuite || task.suite?.name === 'Neighboring user Run Stop admission') && task.name.startsWith('refuses ')
        ? { actionsSettingsV1: { v: 1 as const, actions: {
            [commandSuite ? 'session.message.send' : 'execution.run.stop']: {
                enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [],
            },
        } } } : {};
    // A composed real transcript needs browser frames to be asynchronous: the
    // popover-only harness's immediate default recursively re-enters held intent.
    restorePopoverWebGlobals = withPopoverWebGlobals({ frameScheduler: callback => {
        const timer = setTimeout(() => { animationFrames.delete(timer); callback(performance.now()); }, 0);
        animationFrames.add(timer);
        return Number(timer);
    } });
    resetSessionDraftRepositoryForTests();
    browserRuntime = null;
    recyclerBoundary.measured = false;
    latestToolResult = undefined;
    structuredMeta = undefined;
    httpSessionAvailable = true;
    initialHistoryResponse = undefined;
    pendingAdmissionResponse = undefined;
    sidechainHistory = undefined;
    pendingRows.length = 0;
    runState = createRun();
    getReply = async () => wireResult();
    stopReply = async () => ({ ok: true });
    cancelReply = async () => ({ ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' });
    resumeReply = async () => ({ ok: true });
    boundary.call.mockReset();
    boundary.requests.length = 0;
    boundary.messages.length = 0;
    boundary.frames.length = 0;
    vi.mocked(Modal.alert).mockReset();
    vi.mocked(Modal.confirm).mockReset();
    // The alert is a presentation boundary: keep recovery choices open until
    // their public button is pressed, just as ModalManager.alertAsync does.
    vi.mocked(Modal.alertAsync).mockImplementation((title, message, buttons) => new Promise(resolve => {
        Modal.alert(title, message, buttons?.map(button => ({ ...button, onPress: () => {
            button.onPress?.();
            resolve();
        } })));
    }));
    boundary.call.mockImplementation(async (method, input) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) { ExecutionRunGetRequestSchema.parse(input); return getReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) { ExecutionRunStopRequestSchema.parse(input); return stopReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1) { ExecutionRunCancelTurnRequestSchema.parse(input); return cancelReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE) { ExecutionRunEnsureRequestSchema.parse(input); return resumeReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND) return { ok: true };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [runState] };
        if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { available: true, protocolVersion: 2,
                features: { detachedScope: true, startAndWait: true, exactInputResults: true },
                backends: { codex: { available: true, intents: ['review', 'delegate'] } } } },
        } };
        if (method === RPC_METHODS.STOP_SESSION) return StopSessionResultSchema.parse({ status: 'stopped' });
        if (method === RPC_METHODS.KILL_SESSION) return { status: 'requested' };
        return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    });
    httpReads.length = 0;
    sessionMetadata = createSessionMetadataHttpBoundary(() => getStorage().getState().sessions);
    approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-1', encryptionMode: 'plain' });
    // Batch and single reads observe the same persisted tuple and refusal fixtures.
    const sessionReads = createSessionReadBatchHttpBoundary(request => {
            if (stopFallbackPolicySuite) {
                const artifactResponse = approvalArtifacts.handle(request.url.pathname + request.url.search, {
                    method: request.method, headers: request.headers, signal: request.signal,
                    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
                });
                if (artifactResponse) return artifactResponse;
            }
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { session: { pendingInput: { protocolVersion: 3 } },
                    serverIdentity: { serverIdentityId: portableIdentity },
                    accountStoredContentCompatibility: { v: 1, currentProtocolVersion: 3, minimumProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
            }));
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === managedMachineActionEndpointPathV1('machines.managed.list')) {
                return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
            }
            if (request.path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'm1', accountId: 'account-1' })]);
            if (request.path === '/v1/machines/m1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-1' }) });
            if (request.path === '/v1/machines/read-batch') {
                const { machineIds } = MachineReadBatchRequestV1Schema.parse(request.body);
                return Response.json(MachineReadBatchResponseV1Schema.parse({ results: machineIds.map(machineId => machineId === 'm1'
                    ? { machineId, status: 'found', machine: createPlainMachineRowFixture({ id: machineId, accountId: 'account-1' }) }
                    : { machineId, status: 'not_found' }) }));
            }
            if (request.path === '/v2/sessions/s1' && !httpSessionAvailable) return Response.json({ error: 'Session not found' }, { status: 404 });
            if (request.path === '/v2/sessions/s1') {
                // The real Session Stop first commits its explicit-stop metadata.
                // Serve that tuple's CAS through the shared persistence boundary.
                if (request.method === 'GET' && sessionMetadata.writes.length === 0) sessionMetadata.replaceSession('s1', {
                    ...createPlainSessionCurrentProjectionRecordFixture({ id: 's1', active: getStorage().getState().sessions.s1?.active ?? true,
                        metadata: readSessionOwnerMetadataView(getStorage().getState().sessions.s1 ?? {}) ?? { path: '/worktree', host: 'localhost' },
                    }),
                    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                        capabilities: getStorage().getState().sessions.s1!.access!.capabilities },
                    ...(commandSuite || walkthroughConversation || task.name.startsWith('clears an admitted Run draft') ? { pendingVersion: 1, pendingCount: 0 } : {}),
                });
                return sessionMetadata.handle(request.url, { method: request.method,
                    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) }) ?? undefined;
            }
            if (request.method === 'POST' && (request.path === '/v2/sessions/s1/pending'
                || request.path === '/v2/sessions/s1/execution-runs/run_1/pending')) {
                const body = request.body as Readonly<{ localId: string; requestedAction: unknown; recipient?: unknown }>;
                if (pendingAdmissionResponse) return pendingAdmissionResponse.then(() => Response.json({
                    requestedAction: body.requestedAction, pending: { localId: body.localId, recipient: body.recipient }, didWrite: true,
                }));
                return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId }, didWrite: true });
            }
            if (request.path.includes('/messages') || request.path.includes('/pending')) {
                httpReads.push(request);
                if (request.url.searchParams.get('scope') === 'sidechain' && sidechainHistory) return Response.json(sidechainHistory);
                if (request.path.includes('/messages') && initialHistoryResponse) return initialHistoryResponse;
                return Response.json(request.path.endsWith('/pending')
                    ? { pending: request.path.includes('/execution-runs/run_1/') ? pendingRows : [],
                        discarded: [], pendingVersion: 1, pendingCount: pendingRows.length }
                    : SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false, nextBeforeSeq: null }));
            }
            if (request.path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
            if (request.path === '/v1/artifacts') return Response.json([]);
            return undefined;
    });
    // These Actions cross the Home/daemon boundary with requester custody. Keep
    // their real UI admission and the canonical private-box fixture beneath it.
    const accountActions = await createScmRunActionHttpBoundary({
        serverUrl: 'https://run-details-' + (sequence + 1) + '.test', serverIdentityId: portableIdentity!,
        accountId: 'account-1', machineId: 'm1',
        actionIds: walkthroughConversation
            ? ['scm.diffSummary.result.read', 'scm.diffSummary.discuss', 'execution.run.get', 'execution.run.send']
            : ['execution.run.get', 'execution.run.send', 'execution.run.action'],
        execute(actionId, input) {
            const method = getActionSpec(actionId).bindings?.rpcMethod;
            if (!method) throw new Error(`Missing fixture RPC for ${actionId}`);
            return boundary.call(method, input);
        },
    });
    home = await serveActionHomes({
        homes: [{ key: 'home', serverUrl: 'https://run-details-' + (++sequence) + '.test',
            serverIdentityId: 'srv_run_details_' + sequence, accountId: 'account-1', settings: stopPolicy,
            currentAccount: true }],
        route: async request => {
            if (stopFallbackPolicySuite && request.path === '/v1/actions/approval.request.decide') {
                return Response.json(await executeOwnMachineApprovalDecisionBoundary({ serverId: portableIdentity,
                    machineId: 'm1', body: request.body, signal: request.signal }));
            }
            const response = await accountActions.handle(request.url, { method: request.method,
                ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) });
            return response ?? sessionReads.handle(request);
        },
    });
    const { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl(home.homes.home!.serverUrl, portableIdentity);
    serverId = resolveServerProfileScopeIdForIdentifier(home.homes.home!.id);
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl))!);
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now(), storageMode: 'plain' });
    getStorage().setState({
        sessions: {},
        machines: { m1: machine }, machineListByServerId: { [serverId]: [machine] },
        sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true }) },
        sessionPending: { s1: { messages: [], discarded: [], isLoaded: true } },
        settings: settingsParse({ ...settingsDefaults, backendEnabledByTargetKey: {}, ...stopPolicy }),
        settingsScope: { serverId, accountId: 'account-1' }, profileScope: { serverId, accountId: 'account-1' },
    });
    getStorage().getState().applySessions([createSessionFixture({ id: 's1', serverId, active: true,
        metadata: { path: '/repo', host: 'tester.local', machineId: 'm1', flavor: 'codex' } })]);
    await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account-1' });
});
afterEach(async () => {
    routeBoundary.pathname = '/';
    standardCleanup();
    for (const timer of animationFrames) clearTimeout(timer);
    animationFrames.clear();
    restorePopoverWebGlobals?.();
    await disconnectActiveServerConnection();
    await home?.dispose();
});

describe('SessionExecutionRunDetailsView — real Home, transcript and interaction owners', () => {
    it('clears an admitted Run draft after a review follow-up page closes before the RPC acknowledgement', async () => {
        runState = liveRun({ turnInFlight: false });
        await setActionPolicy(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'execution.run.action': ['ui'] } }));
        const acknowledgement = createDeferred<unknown>();
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation((method, input) => method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION
            ? acknowledgement.promise : original(method, input));
        const page = <ReviewFindingsMessageCard serverId={serverId} sessionId="s1" canSendMessages presentation="page" payload={{
            runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex', retentionPolicy: 'resumable' },
            summary: 'Review complete', overviewMarkdown: 'One finding', generatedAtMs: 1,
            findings: [{ id: 'f1', title: 'Check ownership', severity: 'high', category: 'correctness',
                summary: 'Check the retained draft', filePath: 'owner.ts', startLine: 1 }],
            questions: [], assumptions: [],
        }} />;
        screen = await renderScreen(page);
        const prompt = 'Explain the ownership finding';
        await vi.waitFor(() => expect(screen.findAllByType(AgentInput)).toHaveLength(1));
        const input = screen.findAllByTestId('new-session-composer-input').find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => input.props.onChangeText(prompt));
        expect(readComposerText(screen.findByType(AgentInput))).toBe(prompt);
        await act(async () => screen.findByType(AgentInput).props.onSend({ inputTextOverride: prompt }));
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)).toHaveLength(1));
        await act(async () => screen.tree.unmount());
        await act(async () => acknowledgement.resolve({ ok: true }));
        screen = await renderScreen(page);
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe(''));
    });
    it.each(['loading', 'error', 'loaded'] as const)('keeps partial review acceptance visible while the Run is %s', async state => {
        const held = createDeferred<unknown>();
        if (state === 'loading') getReply = () => held.promise;
        if (state === 'error') getReply = async () => ({ ok: false, error: 'host_unavailable' });
        try {
            await mount({ reviewersNotStarted: ['codex'] });
            if (state === 'error') await vi.waitFor(() => expect(screen.findByTestId('session-run-details-load-error')).not.toBeNull());
            if (state === 'loaded') await loaded();
            expect(screen.findByTestId('session-run-details-review-partial')).not.toBeNull();
            expect(screen.getTextContent()).toContain(t('runPage.review.reviewerNotStarted', { reviewer: 'codex' }));
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally {
            await act(async () => held.resolve(wireResult()));
        }
    });
    it('names a discovered native model from the exact Home, Machine and checkout catalog in the Run header', async () => {
        const { buildDynamicModelProbeCacheKey } = await import('@/sync/domains/models/dynamicModelProbeCacheKey');
        const { writeDynamicModelProbeCacheSuccess, resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
        const { buildBackendTargetKeyV2, readBackendTargetRefV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
        const targetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(runState.backendTarget));
        const write = (homeId: string, cwd: string, name: string) => writeDynamicModelProbeCacheSuccess(
            buildDynamicModelProbeCacheKey({ serverId: homeId, machineId: 'm1', targetKey, providerConnectionId: null, cwd })!,
            { availableModels: [{ id: 'gpt-6-luna', name, capabilities: { structuredOutput: 'supported' } }], supportsFreeform: false });
        resetDynamicModelProbeCacheForTests();
        try {
            write(serverId, '/other-checkout', 'Wrong checkout model');
            write('another-home', '/repo', 'Wrong Home model');
            write(serverId, '/repo', 'GPT-6-Luna');
            runState = liveRun({ resolvedSelection: { source: 'explicit', modelId: 'gpt-6-luna' } });
            await mount();
            await loaded();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('GPT-6-Luna'));
            expect(screen.getTextContent()).not.toContain('gpt-6-luna');
            expect(screen.getTextContent()).not.toContain('Wrong checkout model');
            expect(screen.getTextContent()).not.toContain('Wrong Home model');
            await act(async () => publishMarker());
            expect(screen.getTextContent()).toContain('GPT-6-Luna');
            // The already-admitted catalog supplies this display; no discovery request is required.
            expect(boundary.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)
                .flatMap(request => (request.payload as { requests?: Array<{ id: string }> }).requests ?? [])
                .filter(request => request.id.includes('models'))).toEqual([]);
        } finally {
            standardCleanup();
            resetDynamicModelProbeCacheForTests();
        }
    });
    it('says plainly that a listed Run lost its details with its removed Session, and closes the panel', async () => {
        getReply = async () => ({ ok: false, error: 'Not found', errorCode: 'execution_run_not_found' });
        const close = vi.fn();
        await mount({ sessionId: null, workspace: { machineId: 'm1' }, sessionRemoved: true, onRequestClose: close });
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-gone')).not.toBeNull());
        const text = screen.getTextContent();
        expect(text).toContain('runPage.gone.sessionRemoved.title');
        expect(text).not.toContain('runPage.gone.title');
        expect(text).toContain('common.close');
        expect(text).not.toContain('runPage.gone.closeTab');
        await screen.pressByTestIdAsync('session-run-details-gone-action');
        expect(close).toHaveBeenCalledOnce();
    });
    it('reads and replies to a detached Run through its exact Machine without Session input', async () => {
        runState = liveRun();
        latestToolResult = { text: 'The selected line is safe.' };
        await mount({ sessionId: null, workspace: { machineId: 'm1' } });
        await loaded();
        expect(info().run.runId).toBe('run_1');
        expect(boundary.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && request.targetId === 'm1')).toBe(true);
        const input = screen.findAllByTestId('new-session-composer-input').find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => { input.props.onChangeText('Explain the next line'); });
        await screen.pressByTestIdAsync('new-session-composer-send');
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toHaveLength(1));
        expect(JSON.stringify(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND))).toContain('Explain the next line');
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe(''));
        await act(async () => { input.props.onChangeText('And the following line?'); });
        await screen.pressByTestIdAsync('new-session-composer-send');
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toHaveLength(2));
        const inputIds = calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND).map(([, payload]) => ExecutionRunSendRequestSchema.parse(payload).localInputId);
        expect(inputIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(inputIds).size).toBe(2);
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND)
            .every(request => request.targetId === 'm1')).toBe(true);
        expect(httpReads.filter(request => request.path.includes('/sessions/'))).toEqual([]);
    });
    it.each([false, true])('reads and replies to a detached Run without inheriting unavailable Session browser authority (detached=%s)', async detached => {
        runState = liveRun();
        await mount(detached ? { sessionId: null, workspace: { machineId: 'm1', cwd: '/repo' } } : {}, true);
        await loaded();
        const runtime = browserRuntime;
        if (!runtime) throw new Error('Expected the parent Session browser owner');
        const item = BrowserContextItemV1Schema.parse({ v: 1, contextId: 'parent-browser-context', kind: 'browserScreenshot',
            sourceViewId: 'parent-browser-view', sourceAdapterKind: 'chromiumSidecar', fidelity: 'cdp', capturedAtMs: 1,
            navigationGeneration: 1, lifecycleState: 'available', redactionLevel: 'metadataOnly',
            media: { mediaId: 'parent-browser-media', mediaKind: 'image', width: 10, height: 10, sizeBytes: 100 } });
        const attached = attachBrowserContextToComposer({ ...createBrowserContextState(),
            itemsById: { [item.contextId]: item }, itemOrder: [item.contextId] }, {
            attachmentId: 'parent-browser-attachment', contextId: item.contextId,
        });
        if (attached.status !== 'attached') throw new Error('Expected the parent browser attachment');
        await act(async () => runtime.browserShellContext.onStateChange(markBrowserContextViewNavigation(attached.state,
            { viewId: item.sourceViewId, navigationGeneration: 2 })));
        await vi.waitFor(() => expect(composer().some(node => node.props.canSendMessages === true)).toBe(true));
        const inputId = detached ? 'new-session-composer-input' : 'session-composer-input';
        await vi.waitFor(() => expect(screen.findAllByTestId(inputId).some(node => typeof node.props.onChangeText === 'function')).toBe(true));
        const input = screen.findAllByTestId(inputId).find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => input.props.onChangeText('Explain only the selected file text'));
        await screen.pressByTestIdAsync(detached ? 'new-session-composer-send' : 'session-composer-send');
        if (detached) {
            await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toHaveLength(1));
            expect(JSON.stringify(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND))).not.toContain('parent-browser-context');
            await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe(''));
        } else {
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable'));
            expect(readComposerText(screen.findByType(AgentInput))).toBe('Explain only the selected file text');
            expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toEqual([]);
        }
        expect(home.requests.some(request => request.method === 'POST' && request.path.includes('/pending'))).toBe(false);
    });
    it('publishes the loaded Run identity and its rename to the workspace, not the parent Agents chrome', async () => {
        routeBoundary.pathname = '/session/s1/runs/run_1';
        // The popover fixture supplies measurement, not a browser URL. Install
        // the actual route at the browser boundary before the Provider reads it.
        const events = new EventTarget();
        Object.assign(window, { location: { pathname: routeBoundary.pathname, search: '', hash: '' },
            history: { state: null, pushState: () => {}, replaceState: () => {} }, sessionStorage: { getItem: () => 'main' },
            addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events) });
        runState = createRun({ display: { title: 'Reviewer Atlas' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        function Body(props: Readonly<{ navigation: WorkspaceNavigationContextValue }>) {
            const group = props.navigation.state.groups[props.navigation.state.focusedGroupId];
            const tab = props.navigation.state.tabs[group.activeTabId];
            const entries = React.useMemo(() => [{ key: tab.id, ref: tab.target }], [tab]);
            const titles = useDestinationInstanceTitles(catalog, entries);
            return <>
                {React.createElement('RunTabTitles', { titles, target: tab.target, navigation: props.navigation, tabId: tab.id })}
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={routeBoundary.pathname} focused visible navigation={props.navigation.navigationForTab(tab.id)}>
                    <Stack.Screen options={{ headerTitle: 'Agents' }} />
                    <SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId={tab.target.params.runId ?? 'run_1'} presentation="screen" />
                </DestinationInstanceHost>
            </>;
        }
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <WorkspaceProvider enabled catalog={catalog}>{navigation => <Body navigation={navigation} />}</WorkspaceProvider>
        </InjectedAuthProvider>);
        await loaded();
        expect(screen.root.findByType('RunTabTitles').props.target).toMatchObject({ kind: 'sessions',
            params: { workspacePathname: routeBoundary.pathname } });
        const titles = () => [...(screen.root.findByType('RunTabTitles').props.titles as ReadonlyMap<string, string>).values()];
        expect(titles()).toEqual(['Reviewer Atlas']);
        runState = createRun({ display: { title: 'Reviewer renamed' } });
        await refresh();
        expect(titles()).toEqual(['Reviewer renamed']);
        let finishRetarget: ((value: unknown) => void) | undefined;
        getReply = () => new Promise(resolve => { finishRetarget = resolve; });
        const tab = screen.root.findByType('RunTabTitles').props as { navigation: WorkspaceNavigationContextValue; tabId: string };
        await act(async () => { tab.navigation.openHref(`/session/s1/runs/run_2?serverId=${serverId}`, { tabId: tab.tabId }); });
        const retargeted = screen.root.findByType('RunTabTitles').props;
        expect(retargeted.navigation.readDestinationTitles?.()[retargeted.tabId]).toMatchObject({ ref: retargeted.target, title: null });
        // Unnamed registered destinations use their catalog title after the old page withdraws its identity.
        expect(titles()).toEqual(['tabs.sessions']);
        if (!finishRetarget) throw new Error('Retarget must start a new exact Run read');
        runState = createRun({ runId: 'run_2', display: { title: 'New exact Run' } });
        await act(async () => { finishRetarget?.(wireResult()); });
        await vi.waitFor(() => expect(titles()).toEqual(['New exact Run']));
    });
    async function mountHistorySource() {
        const source: { current: SessionTranscriptSource | null } = { current: null };
        function Probe() { source.current = useSessionTranscriptSource(); return null; }
        screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="s1" serverId={serverId}>
            <Probe />
        </AppSessionTranscriptSourceProvider>);
        if (!source.current?.history.loadOlder) throw new Error('App history must be readable');
        return source.current.history.loadOlder;
    }
    it('hydrates initial app history on the exact Home, then does not refetch loaded exhausted history', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        const loadOlder = await mountHistorySource();
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more', hasMore: false }));
        const initialReads = httpReads.filter(request => request.path.includes('/messages'));
        expect(initialReads.length).toBeGreaterThan(0);
        expect(initialReads.every(request => request.accountId === 'account-1' && request.home === 'home'
            && request.url.origin === home.homes.home!.serverUrl)).toBe(true);
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more', hasMore: false }));
        expect(httpReads.filter(request => request.path.includes('/messages'))).toEqual(initialReads);
    });
    it('fails closed on refused initial app hydration instead of paging a previously exhausted cursor', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        const loadOlder = await mountHistorySource();
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more' }));
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        httpSessionAvailable = false;
        httpReads.length = 0;
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'not_ready', hasMore: true }));
        expect(httpReads.filter(request => request.path.includes('/messages'))).toEqual([]);
    });
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
    it.each([false, true])('lets the transcript tool own a failed Run result with sidechain=%s instead of rendering it twice', async (withSidechain) => {
        runState = createRun({ status: 'failed', finishedAtMs: 2,
            error: { code: 'codex_tool_restriction_unsupported_auth', message: 'private diagnostic' } });
        latestToolResult = { ...runState, summary: 'private diagnostic' };
        publishMarker('failed');
        if (withSidechain) getStorage().getState().applyMessages('s1', [{
            id: 'sc-agent', localId: null, createdAt: 2, seq: 3, role: 'agent',
            isSidechain: true, sidechainId: 'toolu_1',
            content: [{ type: 'text', text: 'Checking the changes', uuid: 'sc-text', parentUUID: null }],
        }]);
        await mount(); await loaded();
        expect(screen.findAllByType(SessionMessageDetailsView)).toHaveLength(1);
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('private diagnostic');
        // SessionMessageDetailsView intentionally defers its body; inspect the mounted result.
        await vi.waitFor(() => expect(screen.getTextContent().split('toolView.actionOutcome.cause.toolPolicyUnsupportedAuth')).toHaveLength(2));
    });
    it.each(['session', 'machine'] as const)('presents the failed native turn cause and recovery through its %s scope', async scope => {
        runState = createRun({ status: 'running', turnInFlight: false, inputTurns: { occurrenceId: 'quota-occurrence', last: {
            turnId: 'quota-turn', inputIds: ['quota-input'], state: 'failed', error: { code: 'usage_limit', runtimeIssueV1: {
                v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1, code: 'usage_limit', source: 'usage_limit', agentId: 'codex',
                sanitizedPreview: 'Usage limit reached',
                usageLimit: { v: 1, recoverability: 'wait', quotaScope: 'account', resetAtMs: 1794056400000, retryAfterMs: null,
                    connectedService: { serviceId: 'openai-codex', profileId: 'quota-profile', groupId: null } },
                failureCause: { phase: 'turn', failureReason: 'usage_limit', requestId: 'req-quota-fixture', retryable: false },
            } },
        } } });
        await mount(scope === 'machine' ? { sessionId: null, workspace: { machineId: 'm1' } } : {}); await loaded();
        expect(screen.getTextContent()).toContain('Usage limit reached');
        expect(screen.getTextContent()).toContain('usage.board.plans.capacityResets');
        expect(screen.getTextContent()).toContain('session.usageLimitRecovery.actions.switchAccountNow');
        expect(screen.getTextContent()).toContain('req-quota-fixture');
        expect(screen.findByTestId('session-run-details-turn-failure')).not.toBeNull();
    });
    it('says a failed Run\'s typed cause once, with its account action, instead of a raw tool-result block', async () => {
        const preview = 'Codex usage limit reached. Try another connected account or try again after your limit resets.';
        runState = createRun({ status: 'failed', finishedAtMs: 2, error: { code: 'usage_limit', message: preview, runtimeIssueV1: {
            v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1, code: 'usage_limit', source: 'usage_limit', agentId: 'codex',
            sanitizedPreview: preview,
            usageLimit: { v: 1, recoverability: 'switch_account', quotaScope: 'account', resetAtMs: 1794056400000, retryAfterMs: null,
                connectedService: { serviceId: 'openai-codex', profileId: 'quota-profile', groupId: null } } } } });
        latestToolResult = preview;
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-turn-failure')).not.toBeNull();
        expect(screen.getTextContent()).toContain('usage.board.plans.capacityResets');
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(0);
        await screen.pressByTestIdAsync('session-run-details-turn-failure-action');
        const { router } = await import('expo-router');
        expect(vi.mocked(router.push)).toHaveBeenCalledWith('/(app)/settings/connected-services');
    });
    it.each([
        ['provider_authorization_changed', 'settingsProviders.errors'],
        ['mystery_runner_code', 'runs.runDetails.failedWithoutCause'],
    ])('never leaves a failed Run without a sentence when it recorded only a code (%s)', async (code, expected) => {
        runState = createRun({ status: 'failed', finishedAtMs: 2, error: { code, message: code } });
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-turn-failure')).not.toBeNull();
        expect(screen.getTextContent()).toContain(expected);
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
        // "To:" names the Run by what it is for, never by its id.
        const recipientChip = composer()[0]!.props.extraActionChips.find((chip: { controlId?: string }) => chip.controlId === 'recipient');
        expect(recipientChip?.collapsedOptionsPopover?.label).toEqual(expect.any(String));
        expect(recipientChip.collapsedOptionsPopover.label).not.toContain('run_1');
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
        await act(async () => publishMarker());
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
    });
    it('does not announce waiting for updates for a finished empty Run', async () => {
        runState = createRun({ status: 'succeeded', finishedAtMs: 2 });
        await mount(); await loaded();
        expect(info().run.status).toBe('succeeded');
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
        expect(screen.getTextContent()).not.toContain('status.awaitingUpdates');
        expect(composer()).toHaveLength(0);
    });
    it.each([false, true])('shows the person’s committed question in the Run transcript with a tool marker=%s', async (withMarker) => {
        recyclerBoundary.measured = true;
        runState = liveRun();
        if (withMarker) publishMarker();
        getStorage().getState().applyMessages('s1', [{ id: 'run-question', localId: 'question-input', createdAt: 2, seq: 23,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'Captured evidence for the Run. Why keep the selection?' },
            meta: { displayText: 'Why keep the selection?', happier: { kind: 'participant_message.v1', payload: { recipient: { kind: 'execution_run', runId: 'run_1' } } } },
        }, { id: 'run-answer', localId: null, createdAt: 3, seq: 25, role: 'agent', isSidechain: true, sidechainId: 'toolu_1',
            content: [{ type: 'text', text: 'It survives refresh.', uuid: 'answer-text', parentUUID: null }],
        }]);
        getStorage().getState().applyMessagesLoaded('s1');
        await mount(); await loaded();
        await vi.waitFor(() => {
            const list = screen.findByType(ChainTranscriptList);
            expect(list.props.messages.map((message: Message) => message.kind)).toEqual(['user-text', 'agent-text']);
            expect(list.props.messages[0]).toMatchObject({ kind: 'user-text', localId: 'question-input', displayText: 'Why keep the selection?' });
            // On the Run's own page the question reads as the person's message, not a "To: <Run>" card.
            expect(list.props.messages[0].meta?.happier).toBeUndefined();
        });
        expect(screen.getTextContent()).toContain('Why keep the selection?');
        expect(screen.getTextContent()).not.toContain('Captured evidence for the Run.');
    });

    it('keeps a saved walkthrough receipt navigable inside the tool-marker Run transcript', async () => {
        recyclerBoundary.measured = true;
        runState = liveRun();
        publishMarker();
        const { ScmDiffSummaryGenerateSuccessSchema } = await import('@happier-dev/protocol/scm');
        const payload = ScmDiffSummaryGenerateSuccessSchema.parse({ success: true, sourceKey: 'receipt-comparison', resultId: 'receipt-result', revision: 1,
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'receipt-comparison' },
            comparison: { id: 'receipt-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
                inventory: { state: 'complete', reasons: [], files: [] } }, requestedOutputs: ['walkthrough'],
            outputs: { walkthrough: { state: 'complete', value: { title: 'Saved reading', intro: '', stops: [], otherChangeRefs: [] } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
        getStorage().getState().applyMessages('s1', [{ id: 'receipt-message', localId: null, createdAt: 3, seq: 3,
            role: 'agent', isSidechain: true, sidechainId: 'toolu_1',
            content: [{ type: 'text', text: 'Walkthrough written.', uuid: 'receipt-text', parentUUID: null }],
            meta: { happier: { kind: 'scm_diff_summary.v1', payload },
                scmResultUpdate: { status: 'published', canUndo: false, outputs: [{ kind: 'walkthrough', change: 'created' }] } },
        }]);
        await mount(); await loaded();
        await vi.waitFor(() => expect(screen.findByType(ChainTranscriptList).props.messages).toEqual([
            expect.objectContaining({ kind: 'agent-text', meta: expect.objectContaining({ scmResultUpdate: expect.anything() }) }),
        ]));
        expect(screen.findByTestId('scm-result-receipt')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('scm-result-receipt-open')).not.toBeNull());
        await screen.pressByTestIdAsync('scm-result-receipt-open');
        const { router } = await import('expo-router');
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(expect.stringContaining('details=scmReview'));
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(expect.stringContaining('receipt-comparison'));
        const href = vi.mocked(router.push).mock.calls.at(-1)?.[0];
        expect(typeof href).toBe('string');
        const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const params = Object.fromEntries(new URL(String(href), 'https://happier.test').searchParams);
        if (!payload.comparison) throw new Error('Expected the saved receipt fixture to include its comparison');
        expect(parseSessionPaneUrlState(params)?.details).toMatchObject({ comparison: {
            comparisonId: payload.comparison.id,
            savedResult: { cwd: payload.comparison.repository.rootPath, resultId: payload.resultId },
        } });
    });

    it.each([false, true])('names a walkthrough conversation recipient before and after its tool marker=%s', async withMarker => {
        runState = liveRun({ intent: 'scm_diff_summary' });
        if (withMarker) publishMarker();
        const title = vi.fn();
        await mount({ openingTitle: 'Change summary', onTitleResolved: title }); await loaded();
        await vi.waitFor(() => expect(composer()).toHaveLength(1));
        expect(composer()[0]!.props.recipient).toMatchObject({ label: 'walkthrough.eyebrow' });
        expect(title).toHaveBeenCalledWith('walkthrough.conversationTitle');
    });

    it.each(['direct', 'tool-marker', 'detached'] as const)('sends a walkthrough conversation through the current saved result Action from %s', async entrance => {
        const detached = entrance === 'detached';
        const { ScmDiffSummaryResultSchema } = await import('@happier-dev/protocol/scm/diffSummaryResult');
        const current = ScmDiffSummaryResultSchema.parse({ resultId: 'conversation-result', revision: 7, canUndo: true,
            output: { success: true, resultId: 'conversation-result', revision: 7, runId: 'run_1', sourceKey: 'comparison',
                metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
                comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/worktree' }, endpoints: {},
                    inventory: { state: 'complete', reasons: [], files: [] } }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'complete', value: { title: 'My current title', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        runState = liveRun({ intent: 'scm_diff_summary' });
        structuredMeta = { kind: 'scm_diff_summary.v1', payload: { ...current.output, revision: 1 } };
        if (entrance === 'tool-marker') publishMarker();
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => {
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) return { success: true, result: current };
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS) return { success: true, result: current, runId: 'run_1', inputId: 'refine-input' };
            return original(method, input);
        });
        await mount(detached ? { sessionId: null, workspace: { machineId: 'm1', cwd: '/worktree' } } : {}); await loaded();
        const inputId = detached ? 'new-session-composer-input' : 'session-composer-input';
        const sendId = detached ? 'new-session-composer-send' : 'session-composer-send';
        await vi.waitFor(() => expect(screen.findAllByTestId(inputId).some(node => typeof node.props.onChangeText === 'function')).toBe(true));
        const input = screen.findAllByTestId(inputId).find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => input.props.onChangeText('Explain this in ordinary prose; leave the saved walkthrough unchanged.'));
        await screen.pressByTestIdAsync(sendId);
        await vi.waitFor(() => expect(calls(RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(1));
        expect(calls(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toHaveLength(1);
        expect(calls(RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS)[0]![1]).toMatchObject({ resultId: current.resultId,
            expectedRevision: current.revision, message: 'Explain this in ordinary prose; leave the saved walkthrough unchanged.' });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toHaveLength(0);
        expect(boundary.messages).toHaveLength(0);
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe(''));
        expect(vi.mocked(Modal.alert)).not.toHaveBeenCalled();
        if (!detached) {
            const props = composer()[0]!.props as React.ComponentProps<typeof SessionParticipantComposer>;
            const picker = props.extraActionChips?.find(chip => chip.controlId === 'recipient')?.collapsedOptionsPopover;
            const lead = picker?.presentation === 'list' ? picker.rootStep?.sections.flatMap(section =>
                section.kind === 'static' ? section.options : []).find(option => option.id === 'lead') : undefined;
            if (!lead?.onSelect) throw new Error('Expected the shared Session recipient option');
            await act(async () => lead.onSelect!());
            expect(composer()[0]!.props.recipient).toBeNull();
            expect(composer()[0]!.props.submitPreparedMessage).toBeUndefined();
            const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
            observeMachinePresenceForTest({ serverId, accountId: 'account-1' }, ['m1']);
            getStorage().getState().applySessions([{ ...getStorage().getState().sessions.s1!, pendingVersion: 1, pendingCount: 0 }]);
            getStorage().setState(state => ({ settings: { ...state.settings, sessionMessageSendMode: 'server_pending' } }));
            const before = home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/s1/pending').length;
            await act(async () => input.props.onChangeText('Ask the Session agent instead'));
            await screen.pressByTestIdAsync(sendId);
            await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'POST'
                && request.path === '/v2/sessions/s1/pending'), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(before + 1));
            expect(calls(RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS)).toHaveLength(1);
        }
    });

    it('restores full-content transcript demand when returning to a running Run panel', async () => {
        const { readMountedSessionRealtimeTranscriptConsumerSessionIds } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        runState = liveRun({ intent: 'agent', ioMode: 'request_response', turnInFlight: true });
        await mount(); await loaded();
        await vi.waitFor(() => expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId)).toContain('s1'));
        await screen.unmount();
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId)).not.toContain('s1');
        await mount(); await loaded();
        await vi.waitFor(() => expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId)).toContain('s1'));
    });

    it('clears an admitted Run draft after navigation while preserving a newer draft on return', async () => {
        runState = liveRun({ intent: 'agent', ioMode: 'request_response', turnInFlight: false });
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { getSessionDraftSnapshot, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { getSessionDraftDocumentField } = await import('@/sync/ops/sessionDrafts/sessionDraftDocumentFields');
        const scope = { serverId, accountId: 'account-1' };
        const address = { kind: 'run' as const, sessionId: 's1', runId: 'run_1' };
        const draftText = () => getSessionDraftDocumentField(getSessionDraftSnapshot(scope, address)?.document ?? null,
            { kind: 'composer', field: 'text' })?.value ?? '';
        observeMachinePresenceForTest(scope, ['m1']);
        getStorage().getState().applySessions([{ ...getStorage().getState().sessions.s1!, pendingVersion: 1, pendingCount: 0 }]);
        getStorage().setState(state => ({ settings: { ...state.settings, sessionMessageSendMode: 'server_pending' } }));
        writeExistingSessionDraft({ scope, sessionId: 's1', runId: 'run_1', patch: { text: 'An unsent Run draft' } });
        const admission = createDeferred<void>();
        pendingAdmissionResponse = admission.promise;
        await mount(); await loaded();
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe('An unsent Run draft'));
        await vi.waitFor(() => expect(composer().some(node => node.props.canSendMessages === true)).toBe(true));
        await vi.waitFor(() => expect(screen.findAllByTestId('session-composer-input').some(node => typeof node.props.onChangeText === 'function')).toBe(true));
        const input = screen.findAllByTestId('session-composer-input').find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => input.props.onChangeText('Continue this conversation'));
        expect(draftText()).toBe('Continue this conversation');
        expect(readComposerText(screen.findByType(AgentInput))).toBe('Continue this conversation');
        // Test Renderer has no mounted native editor to flush; deliver its public
        // send event with the live text while retaining the real admission path.
        await act(async () => screen.findByType(AgentInput).props.onSend({ inputTextOverride: 'Continue this conversation' }));
        await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'POST'
            && request.path === '/v2/sessions/s1/execution-runs/run_1/pending')).toHaveLength(1));
        await screen.unmount();
        await act(async () => admission.resolve());
        await vi.waitFor(() => expect(draftText()).toBe(''));
        await mount(); await loaded();
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe(''));
        await vi.waitFor(() => expect(composer().some(node => node.props.canSendMessages === true)).toBe(true));
        // A later edit belongs to the new mounted composer and survives an old admission.
        const laterAdmission = createDeferred<void>();
        pendingAdmissionResponse = laterAdmission.promise;
        const nextInput = screen.findAllByTestId('session-composer-input').find(node => typeof node.props.onChangeText === 'function')!;
        await act(async () => nextInput.props.onChangeText('Another submitted input'));
        await act(async () => screen.findByType(AgentInput).props.onSend({ inputTextOverride: 'Another submitted input' }));
        await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'POST'
            && request.path === '/v2/sessions/s1/execution-runs/run_1/pending')).toHaveLength(2));
        await screen.unmount();
        writeExistingSessionDraft({ scope, sessionId: 's1', runId: 'run_1', patch: { text: 'A newer unsent edit' } });
        await act(async () => laterAdmission.resolve());
        await mount(); await loaded();
        await vi.waitFor(() => expect(readComposerText(screen.findByType(AgentInput))).toBe('A newer unsent edit'));
    });

    it('hydrates both retained Run turns from the canonical sidechain on a cold open', async () => {
        recyclerBoundary.measured = true;
        runState = liveRun({ intent: 'agent', ioMode: 'request_response', turnInFlight: false });
        const before = getStorage().getState().sessionMessages.s1!;
        const mainMessagesVersion = before.messagesVersion;
        const reducerVersion = before.reducerVersion;
        sidechainHistory = SessionMessagesPageV1Schema.parse({
            messages: [
                { role: 'user', text: 'Reply exactly QAC68_INITIAL_OK.' },
                { role: 'agent', text: 'QAC68_INITIAL_OK' },
                { role: 'user', text: 'Reply exactly QAC68_CONTINUE_OK.' },
                { role: 'agent', text: 'QAC68_CONTINUE_OK' },
            ].map(({ role, text }, index) => ({
                id: `cold-row-${index}`, seq: index + 6, createdAt: index + 6,
                sidechainId: runState.sidechainId, messageRole: role,
                content: { t: 'plain', v: {
                    role,
                    content: role === 'user' ? { type: 'text', text } : {
                        type: 'acp', agentId: 'codex', data: { type: 'message', message: text, sidechainId: runState.sidechainId },
                    },
                    isSidechain: true, sidechainId: runState.sidechainId,
                } },
            })), hasMore: false, nextBeforeSeq: null,
        });
        await mount(); await loaded();
        await vi.waitFor(() => expect(httpReads.filter(request => request.url.searchParams.get('scope') === 'sidechain'
            && request.url.searchParams.get('sidechainId') === runState.sidechainId)).toHaveLength(1));
        await vi.waitFor(() => expect(getStorage().getState().sessionMessages.s1?.reducerState?.sidechains.get(runState.sidechainId)
            ?.map(row => row.text)).toEqual([
            'Reply exactly QAC68_INITIAL_OK.', 'QAC68_INITIAL_OK', 'Reply exactly QAC68_CONTINUE_OK.', 'QAC68_CONTINUE_OK',
        ]));
        expect(getStorage().getState().sessionMessages.s1?.messagesVersion).toBe(mainMessagesVersion);
        expect(getStorage().getState().sessionMessages.s1?.reducerVersion).toBeGreaterThan(reducerVersion ?? 0);
        await vi.waitFor(() => expect(screen.findByType(ChainTranscriptList).props.messages).toEqual([
            expect.objectContaining({ kind: 'user-text', text: 'Reply exactly QAC68_INITIAL_OK.' }),
            expect.objectContaining({ kind: 'agent-text', text: 'QAC68_INITIAL_OK' }),
            expect.objectContaining({ kind: 'user-text', text: 'Reply exactly QAC68_CONTINUE_OK.' }),
            expect.objectContaining({ kind: 'agent-text', text: 'QAC68_CONTINUE_OK' }),
        ]));
        expect(screen.getTextContent()).toContain('QAC68_INITIAL_OK');
        expect(screen.getTextContent()).toContain('QAC68_CONTINUE_OK');
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
        expect(httpReads.filter(request => request.url.searchParams.get('scope') === 'sidechain'
            && request.url.searchParams.get('sidechainId') === runState.sidechainId)).toHaveLength(1);
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
        runState = liveRun();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(0);
        await mount(); await loaded();
        const mountedComposer = composer()[0]!;
        const before = calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET).length;
        expect(before).toBe(1);
        for (let index = 0; index < 1_000; index += 1) {
            await act(async () => {
                if (index % 2 === 0) notifyExecutionRunActivity({ sessionId: `other-session-${index}`, serverId }, { runId: 'run_1' });
                else notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: `other-run-${index}` });
            });
        }
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(before);
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        await refresh(); expect(composer()[0]).toBe(mountedComposer);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(before + 1);
        runState = liveRun({ status: 'succeeded' }); await refresh();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(before + 2);
        expect(screen.findByTestId('session-run-details-loading')).toBeNull(); expect(composer()).toHaveLength(0);
        console.info('flows.F.G1 selected Run reads', { beforeOpen: 0, onOpen: before, unrelatedActivity: 1_000,
            unrelatedReads: 0, relevantActivityReads: calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET).length - before });
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
    it.each([SESSION_RPC_METHODS.EXECUTION_RUN_GET, RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST])(
        'cancels an unanswered %s when the Run view unmounts', async method => {
            const original = boundary.call.getMockImplementation()!;
            let release!: () => void;
            const pending = new Promise<void>(resolve => { release = resolve; });
            boundary.call.mockImplementation(async (candidate, input) => {
                if (candidate === method) await pending;
                return original(candidate, input);
            });
            try {
                await mount();
                await vi.waitFor(() => expect(calls(method).length).toBeGreaterThan(0));
                const frame = boundary.frames.find(frame => frame.event === SOCKET_RPC_EVENTS.CALL
                    && frame.payload !== null && typeof frame.payload === 'object'
                    && String(Reflect.get(frame.payload, 'method')).endsWith(`:${method}`));
                if (!frame || !frame.payload || typeof frame.payload !== 'object') throw new Error('Missing issued Run read');
                const requestId = Reflect.get(frame.payload, 'requestId');
                await screen.unmount();
                expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)).toContainEqual({
                    serverUrl: home.homes.home!.serverUrl, event: SOCKET_RPC_EVENTS.CANCEL,
                    payload: { requestId: requestId ?? expect.any(String) },
                });
            } finally { release(); }
        },
    );
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
    it('offers explicit recoverable Resume, with pending accessibility state', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        let settle!: (value: unknown) => void;
        resumeReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded();
        const target = screen.findByTestId('session-run-details-resume')!;
        screen.pressByTestId('session-run-details-resume');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-resume')?.props.accessibilityState).toMatchObject({ disabled: true, busy: true }));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)[0]![1]).toEqual({ runId: 'run_1', resume: true });
        await act(async () => settle({ ok: true }));
    });
    it('refuses Resume through Action policy before issuing its transport', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        await setActionPolicy(normalizeActionsSettingsV1({
            v: 1, actions: { 'execution.run.ensure': { disabledSurfaces: ['ui'] } },
        }));
        await mount(); await loaded();
        await screen.pressByTestIdAsync('session-run-details-resume');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('action_disabled'));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)).toHaveLength(0);
    });
    it.each([
        ['execution.run.stop', 'session-run-details-stop', SESSION_RPC_METHODS.EXECUTION_RUN_STOP],
        ['execution.run.cancel_turn', 'session-run-details-cancel-turn', SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1],
    ] as const)('refuses %s through Action policy before issuing its transport', async (actionId, testId, method) => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: {
            turnId: 'turn-1', inputIds: ['input-1'], state: 'active',
        } } });
        await setActionPolicy(normalizeActionsSettingsV1({
            v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } },
        }));
        await mount(); await loaded(); await menu();
        await screen.pressByTestIdAsync(testId);
        if (actionId === 'execution.run.stop') {
            await vi.waitFor(() => expect(info().stopAction?.stopping).toBe(false));
            expect(calls(method)).toHaveLength(0);
        }
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('action_disabled'));
        expect(calls(method)).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-stop-failed')).toBeNull();
    });
    it.each(['android', 'ios', 'web'] as const)('draws Resume at its padded label on %s, reached by hit area and never a drawn minimum', async (platform) => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        const originalPlatform = Platform.OS;
        try {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
            await mount(); await loaded();
            const target = screen.findByTestId('session-run-details-resume');
            expect(target).not.toBeNull();
            const drawn = flattenTestStyle(target!.props.style);
            expect(drawn.minWidth).toBeUndefined();
            expect(drawn.minHeight).toBeUndefined();
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
        const accountReads = home.requests.filter(request => request.path !== '/v1/features');
        expect(accountReads.length).toBeGreaterThan(0);
        expect(accountReads.every(request => request.accountId === 'account-1')).toBe(true);
        // Features is the canonical anonymous discovery endpoint; every private
        // request must still authenticate as this Run's exact Account.
        expect(home.requests.filter(request => request.accountId !== 'account-1'
            && !(request.path === '/v1/features' && request.accountId === null))
            .map(request => ({ path: request.path, accountId: request.accountId }))).toEqual([]);
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
    it.each(['panel', 'screen'] as const)('opens a stopped Run from Work transcript evidence in the %s after its parent stops', async presentation => {
        runState = createRun({ status: 'cancelled', finishedAtMs: 2 });
        publishMarker('cancelled');
        getStorage().getState().applySessions([{ ...getStorage().getState().sessions.s1!, active: false }]);
        getReply = async () => ({ ok: false, error: 'RPC target unavailable', errorCode: 'target_unavailable' });
        await mount({ presentation }); await loaded();
        expect(info().run).toMatchObject({ runId: 'run_1', status: 'cancelled' });
        expect(screen.findAllByType(SessionMessageDetailsView)).toHaveLength(1);
        expect(composer()).toHaveLength(0);
        expect(info().stopAction).toBeNull();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual([]);
        expect(calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toEqual([]);
        expect(mutationMethods.flatMap(method => calls(method))).toEqual([]);
    });
    it('loads main transcript history before failing closed on an absent Run, then offers a way out', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        getReply = async () => ({ ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
        let respond!: (response: Response) => void;
        initialHistoryResponse = new Promise(resolve => { respond = resolve; });
        const { sync } = await import('@/sync/sync');
        // Opening the real Session route admits its initial page; the older-page
        // reader deliberately cannot fabricate pagination before this response.
        const hydration = sync.ensureSessionVisibleForMessageRoute('s1', {
            forceRefresh: true, serverId, awaitMessageHydration: true,
        });
        await vi.waitFor(() => expect(httpReads.some(request => request.path.includes('/messages')
            && request.url.searchParams.get('scope') === 'main')).toBe(true));
        const close = vi.fn();
        await mount({ onRequestClose: close });
        expect(screen.findByTestId('session-run-details-gone')).toBeNull();
        expect(close).not.toHaveBeenCalled();
        await act(async () => {
            respond(Response.json(SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false, nextBeforeSeq: null })));
            expect(await hydration).toMatchObject({ kind: 'available' });
        });
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
            findings: [
                { id: 'retry', title: 'Retry charges twice', severity: 'high', category: 'correctness', summary: 'Retry repeats the purchase.' },
                { id: 'pending', title: 'Pending state is unclear', severity: 'low', category: 'correctness', summary: 'The banner hides progress.' },
            ], generatedAtMs: 2,
        } };
        await mount(); await loaded();
        expect(screen.getTextContent()).toContain('The retry banner can double-charge.');
        expect(screen.getTextContent()).toContain('Retry charges twice');
        expect(screen.getTextContent()).toContain('Pending state is unclear');
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
        expect(screen.findByTestId('session-run-details-steps')).not.toBeNull();
        expect(composer()).toHaveLength(0);
    });
    it('keeps a walkthrough conversation as the page: no result-first steps disclosure for a kind without a result page', async () => {
        runState = createRun({ status: 'succeeded', intent: 'scm_diff_summary' });
        structuredMeta = { kind: 'scm_diff_summary.v1', payload: { success: true, summaryMarkdown: 'Saved.' } };
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-steps')).toBeNull();
    });
    it('states the other live agents affected before an unconfirmed Run stop falls back to Session stop', async () => {
        runState = liveRun();
        // Execution Runs are locally projected from transcript/registry evidence,
        // not published in the provider workflow-only activity headline.
        const markers = Array.from({ length: 4 }, (_, index) => createToolCallMessageFixture({
            id: 'tool-msg-' + (index + 1), tool: {
                id: 'toolu_' + (index + 1), name: 'SubAgentRun', state: 'running',
                input: { ...runState, runId: 'run_' + (index + 1), label: 'Run ' + (index + 1) },
                createdAt: 1, startedAt: 1, completedAt: null, description: null,
            },
        }));
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: markers.map(marker => marker.id),
            messagesById: Object.fromEntries(markers.map(marker => [marker.id, marker])) }) } });
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('count=3');
        await screen.pressByTestIdAsync('session-run-details-stop-failed-secondary-action');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).toBeNull());
        expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1);
    });
});

describe('Workflow activity Session-stop fallback', () => {
    it('states the other live workflow agents affected before an unconfirmed Run stop falls back to Session stop', async () => {
        runState = liveRun();
        const headline = SessionAgentActivityHeadlineV1Schema.parse({ v: 1, backendId: 'codex', updatedAt: 1,
            activeEntries: Array.from({ length: 3 }, (_, index) => ({ entryId: 'workflow_agent:workflow_1:agent_' + index,
                kind: 'workflow_agent', title: 'Agent ' + index, status: 'running', updatedAt: 1 })) });
        const session = getStorage().getState().sessions.s1!;
        getStorage().getState().applySessions([{ ...session, metadata: {
            ...session.metadata!, sessionAgentActivityHeadlineV1: headline,
        } }]);
        publishMarker();
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('count=3');
        await screen.pressByTestIdAsync('session-run-details-stop-failed-secondary-action');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).toBeNull());
        expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1);
    });
});

describe('Neighboring user Run Stop admission', () => {
    it.each(['attached', 'detached'] as const)('cancels the captured %s Stop request after real Socket issuance', async target => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const controller = new AbortController();
        let issued = false;
        let settle!: (result: unknown) => void;
        stopReply = () => new Promise(resolve => { settle = resolve; });
        const result = execute('execution.run.stop', { sessionId: target === 'attached' ? 's1' : null, runId: 'run_1' }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId, expectedAccountId: 'account-1', executionRunTargetMachineId: 'm1',
            signal: controller.signal, onTransportIssued: () => { issued = true; },
        });
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1));
        const targetId = target === 'attached' ? 's1' : 'm1';
        const frame = boundary.frames.find(frame => frame.event === SOCKET_RPC_EVENTS.CALL
            && frame.payload !== null && typeof frame.payload === 'object'
            && Reflect.get(frame.payload, 'method') === `${targetId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`);
        expect(frame).toBeDefined();
        if (!frame || !frame.payload || typeof frame.payload !== 'object') throw new Error('The issued Stop must carry a Socket request');
        const requestId = SocketRpcRequestIdSchema.parse(Reflect.get(frame.payload, 'requestId'));
        expect(issued).toBe(true);
        controller.abort();
        expect(await result).toMatchObject({ ok: false,
            errorCode: expect.stringMatching(/\S/), error: expect.stringMatching(/\S/) });
        expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)).toContainEqual({
            serverUrl: home.homes.home!.serverUrl, event: SOCKET_RPC_EVENTS.CANCEL, payload: { requestId },
        });
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        await act(async () => settle({ ok: true }));
    });

    it('refuses a pre-aborted detached Stop before any Socket issuance', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const controller = new AbortController();
        controller.abort();
        let issued = false;
        await expect(createFrontDoorActionExecute()('execution.run.stop', { sessionId: null, runId: 'run_1' }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId, expectedAccountId: 'account-1', executionRunTargetMachineId: 'm1',
            signal: controller.signal, onTransportIssued: () => { issued = true; },
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(issued).toBe(false);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)).toEqual([]);
    });

    async function mountStopSurface(surface: 'runs' | 'machine' | 'subagent') {
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const profile = getServerProfileById(serverId);
        expect(profile?.serverIdentityId).toBe(serverId);
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST
            ? { runs: [{ ...runState,
                happyHomeDir: '/tmp/happier', happySessionId: 's1', pid: 123 }] }
            : original(method, input));
        getStorage().setState({ machineListStatusByServerId: { [serverId]: 'idle' } });
        if (surface === 'subagent') {
            const { SessionSubagentRow } = await import('@/components/sessions/agents/list/SessionSubagentRow');
            const row: React.ComponentProps<typeof SessionSubagentRow>['row'] = {
                subagent: { id: 'execution_run:run_1', kind: 'execution_run', status: 'running',
                        display: { title: 'Reviewer' }, transcript: { sidechainId: 'toolu_1' },
                        runRef: { runId: 'run_1', backendId: 'codex', intent: 'review' },
                        recipient: { kind: 'execution_run', runId: 'run_1' }, timestamps: {},
                        capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false,
                            canDelete: false, canOpenAdvancedRun: true } },
                entry: { id: 'execution_run:run_1', kind: 'execution_run', status: 'running', title: 'Reviewer',
                    metaDetail: null, startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded',
                    parentId: null, runId: 'run_1', sidechainId: 'toolu_1', subagentId: 'execution_run:run_1', attentionKinds: [] },
            };
            screen = await renderScreen(<SessionSubagentRow sessionId="s1" serverId={serverId} row={row}
                onPress={() => {}} onOpenFull={null} onOpenAdvanced={null} />);
            return async () => { await act(async () => screen.findByTestId('session-subagent-actions:execution_run:run_1')!.props.onSelect('stop')); };
        }
        const { router } = await import('expo-router');
        // Project work, including Runs, lives on the Machine Overview.
        router.setParams(surface === 'machine' ? { id: 'm1', tab: 'overview', serverId } : {});
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        const Screen = surface === 'runs' ? (await import('@/app/(app)/runs')).default
            : (await import('@/app/(app)/machines/[id]/index')).WorkspaceRouteBody;
        screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider><Screen /></AppPaneProvider></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length,
            screen.getTextContent()).toBeGreaterThan(0));
        return async () => { await act(async () => {
            await screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress();
        }); };
    }

    it.each(['runs', 'machine', 'subagent'] as const)('refuses %s Stop through Action policy before transport or Session fallback', async surface => {
        await setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: {
            'execution.run.stop': { enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [] },
        } }));
        const stop = await mountStopSurface(surface);
        const listsBeforeStop = calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).length;
        await stop();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'action_disabled'));
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
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
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
    });

    it.each(['runs', 'machine'] as const)('preserves %s explicit Session fallback after an issued Run Stop fails', async surface => {
        stopReply = async () => ({ ok: false, error: 'Unsupported response from session RPC' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await mountStopSurface(surface);
        let operation!: Promise<void>;
        await act(async () => {
            operation = screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress();
        });
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('runs.stop.stopRunFailedTitle',
            'runs.stop.stopRunFailedBody', expect.any(Array)));
        await pressSessionStopRecovery();
        await operation;
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        // Both surfaces reach the real daemon Session-stop producer. A valid
        // stopped response must not fall through to a second runner stop.
        const method = RPC_METHODS.STOP_SESSION;
        await vi.waitFor(() => expect(calls(method)).toHaveLength(1));
        expect(boundary.requests.filter(request => request.method === method)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 'm1', method, payload: { sessionId: 's1' } },
        ]);
        expect(vi.mocked(Modal.alert).mock.calls.filter(([title]) => title === 'common.error')).toEqual([]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
    });

    it('retires a captured Runs Stop callback when its Home signs into another Account', async () => {
        await mountStopSurface('runs');
        const stop = screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress;
        await home.switchAccount('home', 'account-2');
        await act(async () => { await stop(); });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
    });

    it.each(['runs', 'machine'] as const)('withdraws %s issued Stop failure recovery when its Home Account retires', async surface => {
        let settle!: (result: unknown) => void;
        stopReply = () => new Promise(resolve => { settle = resolve; });
        await mountStopSurface(surface);
        const onPress = screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress;
        let operation!: Promise<void>;
        await act(async () => { operation = onPress(); });
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1));
        const frame = boundary.frames.find(frame => frame.event === SOCKET_RPC_EVENTS.CALL
            && frame.payload !== null && typeof frame.payload === 'object'
            && Reflect.get(frame.payload, 'method') === `s1:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`);
        if (!frame || !frame.payload || typeof frame.payload !== 'object') throw new Error('Stop must reach the real Socket before retirement');
        const requestId = SocketRpcRequestIdSchema.parse(Reflect.get(frame.payload, 'requestId'));
        await act(async () => { await home.switchAccount('home', 'account-2'); await operation; });
        expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)).toContainEqual({
            serverUrl: home.homes.home!.serverUrl, event: SOCKET_RPC_EVENTS.CANCEL, payload: { requestId },
        });
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        expect(vi.mocked(Modal.alert)).not.toHaveBeenCalled();
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        await act(async () => settle({ ok: false, error: 'The retired Run Stop was not confirmed', errorCode: 'rpc_timeout' }));
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
    });
});

function sessionStopRecovery() {
    const recovery = vi.mocked(Modal.alert).mock.calls.find(([title]) => title === 'runs.stop.stopRunFailedTitle');
    const stop = recovery?.[2]?.find(button => button.text === 'runs.stop.stopSession');
    expect(stop?.onPress).toBeTypeOf('function');
    return stop!.onPress!;
}
async function pressSessionStopRecovery() {
    await act(async () => { await sessionStopRecovery()(); });
}

describe('Session Stop fallback Action policy', () => {
    const cases = (['runs', 'details', 'machine'] as const).flatMap(surface => [
        { surface, policy: 'Off', stops: 0, stopStatus: 'stopped' },
        { surface, policy: 'Ask rejected', stops: 0, stopStatus: 'stopped' },
        { surface, policy: 'Ask approved', stops: 1, stopStatus: 'stopped' },
        { surface, policy: 'Allowed', stops: 1, stopStatus: 'stopped' },
        { surface, policy: 'Allowed pending', stops: 1, stopStatus: 'requested' },
    ]);
    it.each(cases)('honors $policy for the $surface Session fallback after an issued Run Stop fails', async ({ surface, policy, stops, stopStatus }) => {
        await setActionPolicy(normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': policy === 'Off'
            ? { enabled: false } : policy.startsWith('Ask') ? { approvalRequiredSurfaces: ['ui'] } : {} } }));
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST
            ? { runs: [{ ...runState, happyHomeDir: '/tmp/happier', happySessionId: 's1', pid: 123 }] }
            : method === RPC_METHODS.STOP_SESSION ? StopSessionResultSchema.parse({ status: stopStatus })
            : original(method, input));
        let operation: Promise<void> | undefined;
        if (surface !== 'details') {
            const { router } = await import('expo-router');
            router.setParams(surface === 'machine' ? { id: 'm1', tab: 'overview', serverId } : {});
            const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
            const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
            const Runs = surface === 'runs' ? (await import('@/app/(app)/runs')).default
                : (await import('@/app/(app)/machines/[id]/index')).WorkspaceRouteBody;
            screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider><Runs /></AppPaneProvider></InjectedAuthProvider>);
            await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length).toBeGreaterThan(0));
            await act(async () => { operation = screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress(); });
            await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('runs.stop.stopRunFailedTitle',
                'runs.stop.stopRunFailedBody', expect.any(Array)));
        } else {
            await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
            await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        }
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1);
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const fallback = surface !== 'details' ? sessionStopRecovery()
            : screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'session-run-details-stop-failed')!.props.secondaryAction.onPress;
        let fallbackOperation!: Promise<void>;
        await act(async () => { fallbackOperation = Promise.resolve(fallback()); });
        if (policy.startsWith('Ask')) {
            await vi.waitFor(() => expect(approvalArtifacts.list()).toHaveLength(1));
            expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
            const artifactId = approvalArtifacts.list()[0]!.id;
            const decision = await decideApprovalAsInbox(serverId, artifactId, policy === 'Ask approved' ? 'approve' : 'reject');
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: policy === 'Ask approved' ? 'executed' : 'rejected' } });
        } else {
            expect(approvalArtifacts.list()).toEqual([]);
        }
        await act(async () => { await fallbackOperation; });
        if (operation) await act(async () => { await operation; });
        expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(stops);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        if (policy === 'Off') expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'action_disabled');
        if (stops) expect(boundary.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 'm1', method: RPC_METHODS.STOP_SESSION, payload: { sessionId: 's1' } },
        ]);
        if (stops) expect(vi.mocked(Modal.alert).mock.calls.filter(([title]) => title === 'common.error')).toEqual([]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
    });
});

describe('Session Stop fallback custody', () => {
    const cases = (['runs', 'details'] as const).flatMap(surface => (['daemon', 'runner'] as const).map(transport => ({ surface, transport })));
    it.each(cases)('retires the $surface fallback observer without retracting its issued $transport Session Stop', async ({ surface, transport }) => {
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        let settle!: (result: unknown) => void;
        const stopMethod = transport === 'daemon' ? RPC_METHODS.STOP_SESSION : RPC_METHODS.KILL_SESSION;
        const stopTarget = transport === 'daemon' ? 'm1' : 's1';
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => method === stopMethod
            ? new Promise(resolve => { settle = resolve; }) : method === RPC_METHODS.STOP_SESSION
                ? StopSessionResultSchema.parse({ status: 'not_found' }) : method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST
                ? { runs: [{ ...runState, happyHomeDir: '/tmp/happier', happySessionId: 's1', pid: 123 }] }
                : original(method, input));
        if (surface === 'runs') {
            const { router } = await import('expo-router');
            router.setParams({});
            const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
            const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
            const Runs = (await import('@/app/(app)/runs')).default;
            screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider><Runs /></AppPaneProvider></InjectedAuthProvider>);
            await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length).toBeGreaterThan(0));
        } else {
            await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
            await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        }
        let settled = false;
        let operation!: Promise<void>;
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        await act(async () => {
            const onPress = surface === 'runs'
                ? screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress
                : screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'session-run-details-stop-failed')!.props.secondaryAction.onPress;
            operation = Promise.resolve(onPress()).finally(() => { settled = true; });
        });
        if (surface === 'runs') {
            await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('runs.stop.stopRunFailedTitle',
                'runs.stop.stopRunFailedBody', expect.any(Array)));
            await pressSessionStopRecovery();
        }
        await vi.waitFor(() => expect(calls(stopMethod)).toHaveLength(1));
        const issued = boundary.frames.find(frame => frame.event === SOCKET_RPC_EVENTS.CALL
            && frame.payload !== null && typeof frame.payload === 'object'
            && Reflect.get(frame.payload, 'method') === `${stopTarget}:${stopMethod}`);
        if (!issued?.payload || typeof issued.payload !== 'object') throw new Error('Missing issued Session Stop');
        try {
            await screen.unmount();
            await vi.waitFor(() => expect(settled).toBe(true));
            const requestId = SocketRpcRequestIdSchema.parse(Reflect.get(issued.payload, 'requestId'));
            expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)
                .some(frame => frame.payload && typeof frame.payload === 'object' && Reflect.get(frame.payload, 'requestId') === requestId)).toBe(false);
            await home.switchAccount('home', 'account-2');
            await vi.waitFor(() => expect(boundary.frames.filter(frame => frame.event === SOCKET_RPC_EVENTS.CANCEL)).toContainEqual({
                serverUrl: home.homes.home!.serverUrl, event: SOCKET_RPC_EVENTS.CANCEL, payload: { requestId },
            }));
            expect(vi.mocked(Modal.alert).mock.calls.filter(([title]) => title === 'common.error')).toEqual([]);
            expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1);
            expect(calls(RPC_METHODS.KILL_SESSION)).toHaveLength(transport === 'runner' ? 1 : 0);
        } finally { await act(async () => settle({ status: 'stopped' })); await operation; }
    });
});

describe('Teammate command Action admission', () => {
    beforeEach(() => vi.mocked(Modal.alert).mockClear());
    function sentInputs() {
        return home.requests.filter(request => request.method === 'POST'
            && (request.path === '/v2/sessions/s1/pending' || request.path === '/v2/sessions/s1/messages'));
    }
    it('delivers an Action-authored shutdown through the real scoped input sender', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const result = await execute('session.message.send', { sessionId: 's1', kind: 'sessionSubagentCommand',
            command: { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' },
            localId: 'shutdown-action-1' }, { serverId, expectedAccountId: 'account-1', surface: 'ui',
            authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'shutdown-action-1' } });
        expect(sentInputs()).toHaveLength(1);
        expect(sentInputs()[0]!.body).toMatchObject({ localId: 'shutdown-action-1', requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Shutdown teammate alpha · qa-team' },
                meta: { displayText: 'Shutdown teammate alpha · qa-team', happier: { kind: 'subagent_command.v1',
                    payload: { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' } } },
            } } });
    });
    async function mountCommandSurface(surface: 'member' | 'team') {
        const { SessionSubagentRow } = await import('@/components/sessions/agents/list/SessionSubagentRow');
        const { SessionSubagentGroup } = await import('@/components/sessions/agents/list/SessionSubagentGroup');
        const row: React.ComponentProps<typeof SessionSubagentRow>['row'] = {
            subagent: { id: 'agent_team_member:qa-team:alpha', kind: 'agent_team_member', status: 'running',
                display: { title: 'alpha', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolMessageRouteId: 'message_2', sidechainId: 'toolu_2', toolId: 'toolu_2' },
                recipient: { kind: 'agent_team_member', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false,
                    canDelete: true, canOpenAdvancedRun: false }, timestamps: {} },
            entry: { id: 'agent_team_member:qa-team:alpha', kind: 'agent_team_member', status: 'running', title: 'alpha',
                metaDetail: null, startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded',
                parentId: null, runId: null, sidechainId: 'toolu_2', subagentId: 'agent_team_member:qa-team:alpha', attentionKinds: [] },
        };
        screen = await renderScreen(surface === 'member'
            ? <SessionSubagentRow sessionId="s1" serverId={serverId} row={row} onPress={() => {}}
                onOpenFull={null} onOpenAdvanced={null} />
            : <SessionSubagentGroup sessionId="s1" serverId={serverId} label="qa-team" rows={[row]}
                activityPreviewById={new Map()} onOpenPreview={() => {}} onOpenFull={() => {}} onOpenAdvanced={() => {}} />);
        return async () => { await act(async () => {
            const menu = surface === 'member'
                ? screen.findByTestId('session-subagent-actions:agent_team_member:qa-team:alpha')!
                : screen.findByType(DropdownMenu);
            menu.props.onSelect(surface === 'member' ? 'delete' : 'delete-team');
        }); };
    }
    it.each(['member', 'team'] as const)('refuses %s shutdown through Action policy before input delivery', async surface => {
        const send = await mountCommandSurface(surface);
        await send();
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'action_disabled'));
        expect(sentInputs()).toEqual([]);
        expect(boundary.messages).toEqual([]);
    });
    it.each(['member', 'team'] as const)('delivers admitted %s shutdown with its exact text and structured envelope', async surface => {
        const send = await mountCommandSurface(surface);
        await send();
        await vi.waitFor(() => expect(sentInputs(), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(1));
        const input = sentInputs()[0]!;
        expect(input.home).toBe('home');
        expect(input.accountId).toBe('account-1');
        expect(input.body).toMatchObject({ requestedAction: { v: 1, kind: 'send_now' }, content: { t: 'plain', v: {
            role: 'user', content: { type: 'text', text: surface === 'member' ? 'Shutdown teammate alpha · qa-team' : 'Delete team qa-team' },
            meta: { happier: { kind: 'subagent_command.v1', payload: surface === 'member'
                ? { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' }
                : { kind: 'agent_team_delete', teamId: 'qa-team' } },
            },
        } } });
        expect(vi.mocked(Modal.alert)).not.toHaveBeenCalled();
    });
});
