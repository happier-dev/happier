import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
    MachineAgentInventoryItemSchema,
    PluginProjectionV2Schema,
    type PluginProjectedComposerAttachmentEntryV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen, findTestInstanceByTypeWithProps } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { Session, PendingMessage } from '@/sync/domains/state/storageTypes';
import type { ResumeSessionResult } from '@/sync/ops/sessions';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import sodium from 'libsodium-wrappers';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';

// The shell statically imports Sync before the pane harness can bind its Socket.
vi.mock('socket.io-client', async (importOriginal) => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
// Substitute Metro's lazy loader only; the public factory and Action admission remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const routerPushSpy = vi.hoisted(() => vi.fn());
const modalMockState = vi.hoisted(() => ({
    current: null as ReturnType<typeof createModalModuleMock> | null,
}));
const themeColors = vi.hoisted(() => ({
    text: '#000',
    textSecondary: '#666',
    textLink: '#00f',
    surface: '#fff',
    surfaceHigh: '#f5f5f5',
    divider: '#ddd',
    border: '#ddd',
    indigo: '#5856D6',
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#ddd' },
    input: { background: '#f5f5f5' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    radio: { active: '#007AFF' },
    shadow: { color: '#000', opacity: 0.2 },
    box: {
        warning: {
            background: '#fffbe6',
            border: '#ffe58f',
            text: '#8c6d1f',
        },
    },
    groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
    useIsFocused: () => true,
}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Easing: {
                bezier: vi.fn(() => ({})),
                linear: {},
            },
            Animated: {
                View: 'Animated.View',
                Value: class {
                    private _value: number;

                    constructor(value: number) {
                        this._value = value;
                    }

                    interpolate() {
                        return this;
                    }
                },
                timing: () => ({
                    start: (callback?: any) => callback?.({ finished: true }),
                }),
            },
            AccessibilityInfo: {
                isReduceMotionEnabled: vi.fn(async () => false),
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                        ? (spec as any).ios
                        : (spec as any).default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            router: {
                push: (...args: any[]) => routerPushSpy(...args),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock({ confirmResult: true });
        modalMockState.current = modalMock;
        return modalMock.module;
    },
});

 // The shared shell helper's legacy domain stubs are not boundaries. Load the
 // actual owners before the runtime harness and SessionView import them.
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => React.createElement('AgentInput', props),
}));

// Remaining presentation-only stubs are P2-deferred. No queue, custody,
// lifecycle, feature policy, projection, or Account owner is replaced here.
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: () => () => {},
}));

type HttpWrite = Readonly<{ url: URL; method: string; body: Record<string, unknown>; authorization: string | null }>;
type RpcCall = Readonly<{ targetId: string; method: string; payload: unknown; token: unknown }>;
const httpWrites: HttpWrite[] = [];
const rpcCalls: RpcCall[] = [];
let enqueueResponse: (write: HttpWrite) => Promise<Response>;
let resumeResponse: (call: RpcCall) => Promise<ResumeSessionResult>;
let sessionOpenDisabled = false;
let sessionOpenAskFirst = false;
let managedInspectAskFirst = false;
let managedWakeMachine: ManagedMachineV1 | null = null;
let approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let projection: PluginProjectionV2 = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {} });

function configureSocket(socket: Socket) {
    // Socket.IO is the external transport boundary. Its actual listener and
    // acknowledgement owners remain in use; no Sync or lifecycle method is spied.
    socket.connected = true;
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        queueMicrotask(() => { for (const listener of socket.listeners('connect')) listener(); });
        return socket;
    });
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    // Fire-and-forget presence/demand packets also cross this cold Socket
    // boundary; no Engine.IO connection is created by the fixture.
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed Socket RPC fixture request');
        const separator = payload.method.indexOf(':');
        const call: RpcCall = {
            targetId: payload.method.slice(0, separator), method: payload.method.slice(separator + 1),
            payload: payload.params, token: typeof socket.auth === 'object' ? socket.auth.token : undefined,
        };
        rpcCalls.push(call);
        if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection }) };
        }
        if (call.method === RPC_METHODS.CAPABILITIES_DETECT) {
            const { agentId: _agentId, title: _title, ...data } = MachineAgentInventoryItemSchema.parse({
                agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: '1',
                update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'status_only' },
                platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
            });
            return { ok: true, result: { protocolVersion: 1, results: {
                'cli.codex': { ok: true, checkedAt: Date.now(), data },
            } } };
        }
        if (call.method === RPC_METHODS.SPAWN_HAPPY_SESSION || call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
            return { ok: true, result: await resumeResponse(call) };
        }
        if (call.method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1) {
            const request = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(call.payload);
            return { ok: true, result: { ok: true, text: request.text, structuredInput: request.structuredInput, stagedMediaHandles: [] } };
        }
        if (call.method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1
            || call.method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1) {
            return { ok: true, result: { ok: true } };
        }
        return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    });
}

const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { storage } = await import('@/sync/domains/state/storageStore');
const { clearSessionDraftValuesForSession, readSessionDraftValue, writeSessionDraftValue } = await import('@/dev/testkit/sessionDraftRepositoryTestkit');
const runtime = installSessionPaneRuntimeTestHarness({
    configureSocket,
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    features: () => {
        const response = createRootLayoutFeaturesResponse();
        return { ...response, capabilities: { ...response.capabilities, session: {
            ...response.capabilities.session, pendingInput: { protocolVersion: 3 },
        } } };
    },
    request: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (url.pathname === '/v1/machines/managed/actions/get' && managedWakeMachine) return Response.json(managedWakeMachine);
        if (url.pathname === '/v2/account/settings' && (sessionOpenDisabled || sessionOpenAskFirst || managedInspectAskFirst)) return Response.json({
            version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: {
                    ...(sessionOpenDisabled || sessionOpenAskFirst ? { 'session.open': sessionOpenDisabled
                        ? { disabledSurfaces: ['ui'] } : { approvalRequiredSurfaces: ['ui'] } } : {}),
                    ...(managedInspectAskFirst ? { 'machines.managed.inspect': { approvalRequiredSurfaces: ['ui'] } } : {}),
                } },
            } },
        });
        const artifactResponse = approvalArtifacts.handle(url.pathname, init);
        if (artifactResponse) return artifactResponse;
        if (url.pathname === '/v1/machines/m-target') return Response.json({
            machine: { id: 'm-target', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
        });
        if (method === 'POST' || method === 'PATCH') {
            const body: unknown = JSON.parse(String(init?.body ?? '{}'));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Malformed HTTP write fixture');
            const write: HttpWrite = { url, method, body: body as Record<string, unknown>,
                authorization: new Headers(init?.headers).get('authorization') };
            httpWrites.push(write);
            if (url.pathname === '/v1/actions/machines.managed.inspect' && managedWakeMachine) {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
                if (managedInspectAskFirst) {
                    // The native daemon, not a client-local policy mock, owns this
                    // Ask receipt. Persist its real signed origin through the Home Artifact codec.
                    await sodium.ready;
                    const [{ captureLazyActionAccountContext }, { readOriginalAccountActionAuthentication }] = await Promise.all([
                        import('@/sync/ops/actions/actionAccountContext'), import('@/sync/api/externalActionAccountTransport'),
                    ]);
                    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7));
                    const account = await captureLazyActionAccountContext(runtime.serverId);
                    let artifactId: string;
                    try {
                        const controller = managedWakeMachine.controller;
                        const authorization = { v: 1 as const, token: 'native-inspect-authorization', binding: {
                            accountId: 'account-a', authentication: readOriginalAccountActionAuthentication(account.credentials.token),
                            serverIdentityId: managedWakeMachine.homeId, machineId: controller.machineId,
                            custodianAccountId: 'account-a', installationId: controller.installationId,
                            actionId: 'machines.managed.inspect' as const, requestId: envelope.requestId, target: envelope.target,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        } };
                        const request = StoredApprovalRequestSchema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'machines.managed.inspect',
                            actionArgs: envelope.input, summary: 'Inspect the retained Machine',
                            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                                serverId: runtime.serverId, serverIdentityId: managedWakeMachine.homeId, accountId: 'account-a',
                                machineId: controller.machineId, target: envelope.target, actionId: 'machines.managed.inspect',
                                requestId: envelope.requestId, externalActionExecutionAuthorization: authorization,
                                externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                                    actionId: 'machines.managed.inspect', input: envelope.input, target: envelope.target,
                                    privateKey: installationKey.privateKey }) } });
                        artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request));
                    } finally { account.dispose(); }
                    return Response.json({ v: 1, actionId: 'machines.managed.inspect', requestId: envelope.requestId,
                        execution: { ok: true, result: { kind: 'approval_request_created', artifactId, actionId: 'machines.managed.inspect' } } });
                }
                return Response.json({ v: 1, actionId: 'machines.managed.inspect', requestId: envelope.requestId,
                    execution: { ok: true, result: { machine: managedWakeMachine } } });
            }
            if (url.pathname === '/v2/sessions/s1/pending/wake-message/withdraw') return Response.json({ ok: true, outcome: 'removed' });
            if (url.pathname === '/v2/sessions/s1/pending' && method === 'POST') return enqueueResponse(write);
            if (url.pathname.startsWith('/v2/sessions/s1/pending/') && method === 'PATCH') return Response.json({ didUpdate: true });
        }
        return null;
    },
});
const { SessionView } = await import('./SessionView');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { emitSessionResumeRequest } = await import('@/components/sessions/model/sessionResumeRequests');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { patchAgentInputLocalUiState, readAgentInputLocalUiState, clearAgentInputLocalUiState } = await import('@/sync/domains/input/draftValues/agentInputLocalUiStateStore');
const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { loadPendingOutboxForSession, removePendingOutboxMessage } = await import('@/sync/domains/state/pendingOutboxPersistence');

function scope() { return { serverId: runtime.serverId, accountId: 'account-a' }; }
const draftOwner = { kind: 'session', sessionId: 's1' } as const;
function currentSession() { return storage.getState().sessions.s1; }
function updateSession(patch: Partial<Session>) {
    storage.getState().applySessions([{ ...currentSession(), ...patch }]);
}
function setMachineOnline(online: boolean) {
    storage.getState().applyMachines([createMachineFixture({
        id: 'm-target', storageMode: 'plain', active: online, activeAt: online ? Date.now() : 0,
    })], true, { sourceServerId: runtime.serverId });
}
function pendingWrites() { return httpWrites.filter(write => write.url.pathname === '/v2/sessions/s1/pending' && write.method === 'POST'); }
function actionWrites() { return httpWrites.filter(write => write.url.pathname.startsWith('/v2/sessions/s1/pending/') && write.method === 'PATCH'); }
function resumeCalls() { return rpcCalls.filter(call => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION || call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE); }
function acceptedEnqueue(write: HttpWrite) {
    return Response.json({ requestedAction: write.body.requestedAction, pending: { localId: write.body.localId } });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}
const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue', pluginId: 'acme.issues', identity: { pluginId: 'acme.issues', localId: 'issue' },
    occurrenceId: 'issues-generation-1',
    definition: { id: 'issue', title: 'Issue', icon: 'file', cardinality: 'many',
        valueSchema: { type: 'object', required: ['issueId'], properties: { issueId: { type: 'integer' } }, additionalProperties: false } },
} satisfies PluginProjectedComposerAttachmentEntryV1;
const composerAttachments = [{
    v: 1 as const, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
    key: '42', value: { issueId: 42 }, presentation: { label: 'Issue #42', typeLabel: 'Issue' },
}];
async function setComposerAttachmentProjection(entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>>, generation = 1) {
    if (!storage.getState().machines['m-target']) setMachineOnline(true);
    projection = PluginProjectionV2Schema.parse({ v: 2, generation, familiesById: {
        composerAttachments: { family: 'composerAttachments', entriesById },
    } });
    publishMachineContributionRegistryProjectionInvalidation({ machineId: 'm-target', serverId: runtime.serverId });
    await loadDaemonMergedProjectionCacheEntry({ machineId: 'm-target', serverId: runtime.serverId });
    await flushHookEffects();
}
function durablePendingRow(localId: string, action: 'send_now' | 'enqueue' = 'send_now'): PendingMessage {
    return { id: `pending-${localId}`, localId, createdAt: 200, updatedAt: 200, source: 'server_pending', messageRole: 'user',
        pendingDeliveryStatus: 'server_queued', pendingRequestedAction: { v: 1, kind: action }, text: 'parked input',
        rawRecord: { role: 'user', content: { type: 'text', text: 'parked input' } } };
}
async function publishDurablePendingState(row: PendingMessage, authorization: Session['pendingActivationAuthorization'] = null) {
    await act(async () => {
        updateSession({ active: false, presence: 0, pendingActivationAuthorization: authorization ? {
            ...authorization, requestedAt: Math.max(authorization.requestedAt, currentSession().activeAt + 1),
        } : null });
        storage.getState().applyPendingSnapshot('s1', { messages: [row], discarded: [] });
    });
}

describe('SessionView (sendMessage resumeInactive pendingQueue)', () => {
    async function renderSessionView(props: { routeServerId?: string } = {}) {
        if (!storage.getState().machines['m-target']) setMachineOnline(true);
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="queue-session" ref={{ kind: 'session', params: {
                id: 's1', ...(props.routeServerId ? { serverId: props.routeServerId } : {}),
            } }} pathname="/session/s1" focused visible navigation={{
                push: routerPushSpy, pushRetainingCurrent: routerPushSpy, replace: vi.fn(), back: vi.fn(),
            }}>
                <SessionView id="s1" routeServerId={props.routeServerId} />
            </DestinationInstanceHost>,
            { wrapper: runtime.Wrapper },
        );
        await flushHookEffects();
        return screen;
    }
    function findAgentInput(screen: Awaited<ReturnType<typeof renderSessionView>>) {
        const inputs = screen.tree.findAllByType('AgentInput' as any);
        return inputs[inputs.length - 1] ?? findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {});
    }
    async function changeText(screen: Awaited<ReturnType<typeof renderSessionView>>, text: string) {
        await act(async () => { findAgentInput(screen).props.onChangeText(text); });
    }
    async function send(screen: Awaited<ReturnType<typeof renderSessionView>>, options?: Record<string, unknown>) {
        await act(async () => { findAgentInput(screen).props.onSend(options); });
    }
    async function waitForSubmittedDraft(screen: Awaited<ReturnType<typeof renderSessionView>>) {
        await vi.waitFor(() => expect(findAgentInput(screen).props.isSending).toBe(false));
        await flushHookEffects();
    }
    beforeEach(async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        httpWrites.length = 0;
        rpcCalls.length = 0;
        sessionOpenDisabled = false;
        sessionOpenAskFirst = false;
        managedInspectAskFirst = false;
        managedWakeMachine = null;
        approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {} });
        clearDaemonMergedProjectionCacheForTests();
        enqueueResponse = async write => acceptedEnqueue(write);
        resumeResponse = async () => ({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE', errorMessage: 'Daemon RPC is not available' });
        storage.setState({ settings: { ...storage.getState().settings,
            experiments: true, featureToggles: {}, sessionMessageSendMode: 'server_pending',
            sessionBusySteerSendPolicy: 'steer_immediately', sessionInactiveResumePolicy: 'when_available',
        }, localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false } });
        storage.getState().applySessions([createSessionFixture({
            id: 's1', serverId: runtime.serverId, active: false, activeAt: 100, presence: 0, seq: 0,
            pendingVersion: 2, metadata: { machineId: 'm-target', host: 'tester.local', flavor: 'codex', version: '999.0.0',
                path: '/tmp/target', homeDir: '/tmp', codexSessionId: 'codex-session-1' },
        })]);
        storage.getState().applyPendingSnapshot('s1', { messages: [], discarded: [] });
        clearSessionDraftValuesForSession(scope(), 's1', { reason: 'composerClear' });
        clearAgentInputLocalUiState(scope(), draftOwner);
        routerPushSpy.mockReset();
        modalMockState.current?.spies.alert.mockReset();
        modalMockState.current?.spies.confirm.mockReset();
        modalMockState.current?.spies.confirm.mockResolvedValue(true);
    });
    afterEach(async () => {
        sessionOpenDisabled = false;
        sessionOpenAskFirst = false;
        for (const row of await loadPendingOutboxForSession('s1', scope())) await removePendingOutboxMessage('s1', row.localId, scope());
        clearSessionDraftValuesForSession(scope(), 's1', { reason: 'composerClear' });
        clearAgentInputLocalUiState(scope(), draftOwner);
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    it.each(['waiting', 'starting', 'connecting', 'resuming', 'storageLost', 'resourceAbsent', 'unknown', 'unavailable', 'deliveryUnknown', 'agentStartFailed'] as const)(
        'mounts the managed %s badge and its observed-stage popover instead of a generic pending banner', async kind => {
        const controller = { machineId: 'controller', installationId: 'controller-installation' };
        managedWakeMachine = ManagedMachineV1Schema.parse({ id: 'managed-guest', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
            controller, enrolledMachineId: 'm-target', creationState: 'active', allocation: 'bound',
            desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            ...(kind === 'unknown' ? {} : { observation: { observedAt: 10,
                availability: kind === 'resourceAbsent' ? 'absent' as const : kind === 'unavailable' ? 'unavailable' as const : 'present' as const,
                power: kind === 'resourceAbsent' || kind === 'unavailable' ? 'unknown' as const
                    : kind === 'waiting' || kind === 'starting' ? 'stopped' as const : 'running' as const,
                storage: kind === 'storageLost' ? 'lost' as const : 'retained' as const,
                daemon: kind === 'resuming' || kind === 'agentStartFailed' ? 'connected' as const : 'disconnected' as const } }),
            ...(kind === 'starting' ? { submittedNativeEffect: { intent: 'start', intentRevision: 1, requestId: 'start-a', controller } } : {}) });
        setMachineOnline(kind === 'resuming' || kind === 'agentStartFailed');
        storage.getState().applyMachines([createMachineFixture({ id: 'controller', active: false, activeAt: 0,
            metadata: { host: 'Controller Mac', displayName: 'Controller Mac' } })], false, { sourceServerId: runtime.serverId });
        const row = { ...durablePendingRow('wake-message'), displayText: 'Original typed wake request' };
        await publishDurablePendingState(kind === 'deliveryUnknown' ? { ...row, pendingDeliveryStatus: 'server_delivering' } : row, {
            requestId: row.localId!, requestedAt: 200, status: kind === 'agentStartFailed' ? 'failed' : 'waiting',
            ...(kind === 'agentStartFailed' ? { failureCode: 'runtime_start_failed' as const } : {}),
            managedWakeTargetV1: { homeId: runtime.serverIdentityId, managedId: 'managed-guest', enrolledMachineId: 'm-target', expectedIntentRevision: 1, controller,
                reason: 'admitted-work', origin: { kind: 'session-input', session: { homeId: runtime.serverIdentityId, sessionId: 's1' },
                    pendingRequestId: row.localId!, requestedAt: 200 } },
        });
        if (kind === 'waiting') writeExistingSessionDraft({ scope: scope(), sessionId: 's1', patch: { text: 'Another unsent draft' } });
        const screen = await renderSessionView();
        if (kind === 'resuming') await act(async () => { storage.getState().markSessionResuming('s1'); });
        let badge: AgentInputStatusBadge | undefined;
        await vi.waitFor(() => {
            badge = (findAgentInput(screen).props.statusBadges as AgentInputStatusBadge[]).find(candidate => candidate.key === 'session-managedWake');
            expect(badge?.testID).toBe(`session.managedWake.${kind}.badge`);
        });
        expect(badge?.renderPopover).toBeTypeOf('function');
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
        expect(resumeCalls()).toHaveLength(0);
        const content = badge!.renderPopover!({ open: true, anchorRef: { current: null }, onRequestClose: () => {} });
        expect(React.isValidElement<{ projection: { kind: string }; controllerName: string }>(content)).toBe(true);
        if (React.isValidElement<{ projection: { kind: string }; controllerName: string; onRetry?: () => void; onWithdraw?: () => void; onCheckNow?: () => void }>(content)) {
            expect(content.props.projection.kind).toBe(kind);
            expect(content.props.controllerName).toBe('Controller Mac');
            expect(typeof content.props.onRetry).toBe(kind === 'agentStartFailed' ? 'function' : 'undefined');
            expect(typeof content.props.onWithdraw).toBe(kind === 'deliveryUnknown' ? 'undefined' : 'function');
            expect(content.props.onCheckNow).toBeTypeOf('function');
            if (kind === 'waiting') {
                await act(async () => { content.props.onCheckNow?.(); });
                await vi.waitFor(() => expect({ failures: modalMockState.current?.spies.alert.mock.calls,
                    nativeRequest: httpWrites.find(write => write.url.pathname === '/v1/actions/machines.managed.inspect')?.body })
                    .toMatchObject({ failures: [], nativeRequest: { v: 1, target: { kind: 'machine', machineId: 'controller' },
                        input: { homeId: runtime.serverIdentityId, managedId: 'managed-guest' } } }));
                expect(findAgentInput(screen).props.value).toBe('Another unsent draft');
                expect(storage.getState().sessionPending.s1.messages).toMatchObject([{ localId: 'wake-message', pendingDeliveryStatus: 'server_queued' }]);
                expect(pendingWrites()).toHaveLength(0);
                expect(actionWrites()).toHaveLength(0);
                expect(httpWrites.filter(write => write.url.pathname.endsWith('/power.set'))).toHaveLength(0);
                expect(resumeCalls()).toHaveLength(0);
                await vi.waitFor(() => {
                    const current = (findAgentInput(screen).props.statusBadges as AgentInputStatusBadge[])
                        .find(candidate => candidate.key === 'session-managedWake')?.renderPopover?.({ open: true, anchorRef: { current: null }, onRequestClose: () => {} });
                    expect(React.isValidElement<{ busy: boolean }>(current) && current.props.busy).toBe(false);
                });
                managedInspectAskFirst = true;
                await act(async () => {
                    content.props.onCheckNow?.();
                });
                await vi.waitFor(() => expect(approvalArtifacts.list()).toHaveLength(1));
                const approvalBody = approvalArtifacts.readPlainBody(approvalArtifacts.list()[0]!.id);
                if (approvalBody === null) throw new Error('Missing managed inspection approval');
                expect(StoredApprovalRequestSchema.parse(JSON.parse(approvalBody))).toMatchObject({
                    status: 'open', actionId: 'machines.managed.inspect',
                    actionArgs: { homeId: runtime.serverIdentityId, managedId: 'managed-guest' },
                });
                await vi.waitFor(() => {
                    const current = (findAgentInput(screen).props.statusBadges as AgentInputStatusBadge[])
                        .find(candidate => candidate.key === 'session-managedWake')?.renderPopover?.({ open: true, anchorRef: { current: null }, onRequestClose: () => {} });
                    expect(React.isValidElement<{ busy: boolean }>(current) && current.props.busy).toBe(true);
                });
                expect(httpWrites.filter(write => write.url.pathname === '/v1/actions/machines.managed.inspect')).toHaveLength(2);
                expect(modalMockState.current?.spies.alert.mock.calls).toEqual([]);
                expect(findAgentInput(screen).props.value).toBe('Another unsent draft');
                expect(storage.getState().sessionPending.s1.messages).toMatchObject([{ localId: 'wake-message', pendingDeliveryStatus: 'server_queued' }]);
            }
            if (kind === 'agentStartFailed') {
                resumeResponse = async () => ({ type: 'success', sessionId: 's1' });
                await act(async () => { content.props.onRetry?.(); });
                await vi.waitFor(() => expect({ failures: modalMockState.current?.spies.alert.mock.calls, calls: resumeCalls() })
                    .toMatchObject({ failures: [], calls: [expect.objectContaining({ targetId: 'm-target',
                        payload: expect.objectContaining({ resume: 'codex-session-1', directory: '/tmp/target' }) })] }));
                expect(storage.getState().sessionPending.s1.messages).toMatchObject([{ localId: 'wake-message', pendingDeliveryStatus: 'server_queued' }]);
                expect(pendingWrites()).toHaveLength(0);
                expect(actionWrites()).toHaveLength(0);
                expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
            }
            if (kind === 'storageLost') {
                await act(async () => { content.props.onWithdraw?.(); });
                await vi.waitFor(() => expect(findAgentInput(screen).props.value).toBe('Original typed wake request'));
                expect(storage.getState().sessionPending.s1.messages).toEqual([]);
                expect(httpWrites.find(write => write.url.pathname === '/v2/sessions/s1/pending/wake-message/withdraw')?.body).toEqual({});
                expect(pendingWrites()).toHaveLength(0);
                expect(resumeCalls()).toHaveLength(0);
            }
        }
        await screen.unmount();
    });

    it('passes persisted composer UI state and expansion controls to AgentInput', async () => {
        writeExistingSessionDraft({ scope: scope(), sessionId: 's1', patch: { text: 'hello' } });
        patchAgentInputLocalUiState(scope(), draftOwner, { expanded: false, scrollY: 12, selection: { start: 1, end: 1 }, textLength: 5, fontScale: 1 });
        const screen = await renderSessionView();
        const input = findAgentInput(screen);
        expect(input.props.inputPersistence).toMatchObject({
            initialScrollY: 12, initialSelection: { start: 1, end: 1 }, restoreToken: expect.any(String),
        });
        expect(input.props.inputExpansion).toMatchObject({ expanded: false, collapsedMaxHeight: expect.any(Number) });
        await act(async () => { input.props.inputExpansion.onToggle(); });
        expect(findAgentInput(screen).props.inputExpansion.expanded).toBe(true);
        expect(readAgentInputLocalUiState(scope(), draftOwner)?.expanded).toBe(true);
        await screen.unmount();
    });

    it('submits an attachment-only contentless composer draft through the structured-input envelope', async () => {
        await setComposerAttachmentProjection({ [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry });
        writeSessionDraftValue(scope(), 's1', 'structuredInput.composerAttachments', composerAttachments);
        const screen = await renderSessionView();
        expect(findAgentInput(screen).props.hasSendableAttachments).toBe(true);
        await send(screen);
        await vi.waitFor(() => expect(pendingWrites()).toHaveLength(1));
        await waitForSubmittedDraft(screen);
        expect(pendingWrites()[0]?.body).toMatchObject({
            content: { t: 'plain', v: { meta: { happierStructuredInputV1: { v: 1, composerAttachments } } } },
        });
        expect(readSessionDraftValue(scope(), 's1', 'structuredInput.composerAttachments') ?? []).toEqual([]);
        expect(findAgentInput(screen).props.hasSendableAttachments).toBe(false);
        await screen.unmount();
    });

    it('keeps an uninstalled or incompatible persisted attachment visible, refuses its text send, and retains the draft until the exact current generation returns', async () => {
        await setComposerAttachmentProjection({ [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry });
        writeSessionDraftValue(scope(), 's1', 'structuredInput.composerAttachments', composerAttachments);
        const screen = await renderSessionView();
        expect(findAgentInput(screen).props.hasSendableAttachments).toBe(true);
        await act(async () => { await setComposerAttachmentProjection({}, 2); });
        let input = findAgentInput(screen);
        expect(input.props.hasSendableAttachments).toBe(false);
        expect(input.props.attachmentRowItems).toEqual(expect.arrayContaining([expect.objectContaining({ availability: 'unavailable', onRemove: expect.any(Function) })]));
        await changeText(screen, 'Keep this unavailable Session draft');
        await send(screen);
        await waitForSubmittedDraft(screen);
        expect(pendingWrites()).toHaveLength(0);
        expect(httpWrites.filter(write => write.url.pathname.includes('/messages'))).toHaveLength(0);
        expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'common.unavailable');
        expect(findAgentInput(screen).props.value).toBe('Keep this unavailable Session draft');
        expect(readSessionDraftValue(scope(), 's1', 'structuredInput.composerAttachments')).toEqual(composerAttachments);
        const reinstalled = { ...issueAttachmentCatalogEntry, occurrenceId: 'issues-generation-2' };
        await act(async () => { await setComposerAttachmentProjection({ [reinstalled.id]: reinstalled }, 3); });
        expect(findAgentInput(screen).props.hasSendableAttachments).toBe(true);
        const incompatible = { ...issueAttachmentCatalogEntry, occurrenceId: 'issues-generation-3', definition: {
            ...issueAttachmentCatalogEntry.definition,
            valueSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } }, additionalProperties: false },
        } } satisfies PluginProjectedComposerAttachmentEntryV1;
        await act(async () => { await setComposerAttachmentProjection({ [incompatible.id]: incompatible }, 4); });
        input = findAgentInput(screen);
        expect(input.props.hasSendableAttachments).toBe(false);
        expect(input.props.attachmentRowItems).toEqual(expect.arrayContaining([expect.objectContaining({ availability: 'invalid', onRemove: expect.any(Function) })]));
        await changeText(screen, 'Keep this invalid Session draft');
        modalMockState.current?.spies.alert.mockClear();
        await send(screen);
        await waitForSubmittedDraft(screen);
        expect(pendingWrites()).toHaveLength(0);
        expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'common.unavailable');
        expect(findAgentInput(screen).props.value).toBe('Keep this invalid Session draft');
        expect(readSessionDraftValue(scope(), 's1', 'structuredInput.composerAttachments')).toEqual(composerAttachments);
        await screen.unmount();
    });

    it('retries the durable failed-activation banner through the canonical resume action', async () => {
        const screen = await renderSessionView();
        await changeText(screen, 'hello');
        await send(screen);
        await vi.waitFor(() => expect(resumeCalls()).toHaveLength(1));
        await waitForSubmittedDraft(screen);
        expect(pendingWrites()).toHaveLength(1);
        expect(pendingWrites()[0]?.body).toMatchObject({ content: { t: 'plain', v: { content: { text: 'hello' } } } });
        expect(resumeCalls()[0]).toMatchObject({ targetId: 'm-target', payload: { directory: '/tmp/target', initialTranscriptAfterSeq: 0 } });
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        await publishDurablePendingState(durablePendingRow('pending-1', 'enqueue'), {
            requestId: 'pending-1', requestedAt: 200, status: 'failed', failureCode: 'runtime_start_failed',
        });
        expect(storage.getState().profileScope).toEqual(scope());
        expect(currentSession().pendingActivationAuthorization).toMatchObject({
            requestId: 'pending-1', status: 'failed', failureCode: 'runtime_start_failed',
        });
        expect(currentSession().pendingActivationAuthorization!.requestedAt).toBeGreaterThan(currentSession().activeAt);
        expect(screen.findByTestId('session-pendingActivation')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.failed.title');
        expect(screen.findByTestId('session-pendingActivation-retry')).toBeTruthy();
        resumeResponse = async () => ({ type: 'success', sessionId: 's1' });
        await screen.pressByTestIdAsync('session-pendingActivation-retry');
        await vi.waitFor(() => expect(resumeCalls()).toHaveLength(2));
        expect(actionWrites()).toHaveLength(0);
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
        await screen.unmount();
    });

    it('renders the canonical resuming lifecycle through pending-queue wake acceptance', async () => {
        updateSession({ metadata: { ...currentSession().metadata!, version: '0.1.0' }, presence: 'online', activeAt: Date.now() });
        const wake = deferred<ResumeSessionResult>();
        resumeResponse = async () => wake.promise;
        let acceptedPendingLocalId: unknown;
        enqueueResponse = async write => {
            acceptedPendingLocalId = write.body.localId;
            return acceptedEnqueue(write);
        };
        const screen = await renderSessionView();
        try {
            expect(findAgentInput(screen).props.connectionStatus?.text).not.toBe('session.resuming');
            await changeText(screen, 'hello');
            await send(screen);
            await vi.waitFor(() => expect(resumeCalls()).toHaveLength(1));
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
            expect(getActiveServerAccountScope()).toEqual(scope());
            expect(storage.getState().profileScope).toEqual(scope());
            expect(storage.getState().settingsScope).toEqual(scope());
            expect(storage.getState().machines['m-target']?.storageMode).toBe('plain');
            expect(isMachineOnline(storage.getState().machines['m-target']!)).toBe(true);
            expect(pendingWrites()).toHaveLength(1);
            expect(acceptedPendingLocalId).toEqual(expect.any(String));
            expect(pendingWrites()[0]?.body.localId).toBe(acceptedPendingLocalId);
            expect(pendingWrites()[0]?.authorization).toMatch(/^Bearer /);
            expect(resumeCalls()[0]?.token).toEqual(expect.any(String));
            expect(storage.getState().sessionPending.s1?.messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ localId: acceptedPendingLocalId, deliveryStatus: 'accepted', text: 'hello' }),
            ]));
            expect(await loadPendingOutboxForSession('s1', scope())).toEqual([]);
            expect(findAgentInput(screen).props.value).toBe('');
            expect(findAgentInput(screen).props.isSending).toBe(false);
            const resumingAt = currentSession().resumingAt;
            expect(resumingAt).toEqual(expect.any(Number));
            expect(currentSession().active).toBe(false);
            // Canonical awareness animates only a live runtime, not an inactive attach gap.
            expect(findAgentInput(screen).props.connectionStatus).toMatchObject({ text: 'session.resuming', isPulsing: false });
            expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
            await act(async () => { wake.resolve({ type: 'success', sessionId: 's1' }); });
            await flushHookEffects();
            // A daemon RPC acknowledgement is not authoritative provider attachment.
            expect(currentSession().active).toBe(false);
            expect(currentSession().resumingAt).toBe(resumingAt);
            expect(findAgentInput(screen).props.connectionStatus).toMatchObject({ text: 'session.resuming', isPulsing: false });
        } finally {
            await act(async () => { wake.resolve({ type: 'success', sessionId: 's1' }); });
            await waitForSubmittedDraft(screen);
            await screen.unmount();
        }
    });

    it('wakes a server-pending inactive session through the cached owning server when the route server id is absent', async () => {
        updateSession({ metadata: { ...currentSession().metadata!, version: '0.1.0' } });
        const screen = await renderSessionView();
        await changeText(screen, 'hello');
        await send(screen);
        await vi.waitFor(() => expect(resumeCalls()).toHaveLength(1));
        expect(pendingWrites()).toHaveLength(1);
        expect(pendingWrites()[0]?.url.origin).toBe('https://session-pane.test');
        expect(resumeCalls()[0]).toMatchObject({ targetId: 'm-target', payload: { directory: '/tmp/target' } });
        expect(typeof resumeCalls()[0]?.token).toBe('string');
        expect(currentSession().serverId).toBe(runtime.serverId);
        await screen.unmount();
    });

    it('does not project a focused runtime ensure onto a same-id Session from another Home', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ensureSessionRuntimeForPendingInput } = await import('@/sync/ops/sessions');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Missing admitting Account lifetime');
        setMachineOnline(true);
        updateSession({ serverId: 'another-home' });
        resumeResponse = async () => ({ type: 'success', sessionId: 's1' });

        await expect(ensureSessionRuntimeForPendingInput({
            sessionId: 's1', machineId: 'm-target', directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            serverId: runtime.serverId, accountLifetime,
        })).resolves.toMatchObject({ type: 'success', sessionId: 's1' });

        expect(accountLifetime.isCurrent()).toBe(true);
        expect(resumeCalls()).toHaveLength(1);
        expect(resumeCalls()[0]).toMatchObject({ targetId: 'm-target', token: expect.any(String) });
        expect(currentSession().serverId).toBe('another-home');
        expect(currentSession().resumingAt ?? null).toBeNull();
    });

    it('does not clear a replacement Account resume projection when the focused wake retires', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { ensureSessionRuntimeForPendingInput } = await import('@/sync/ops/sessions');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Missing admitting Account lifetime');
        setMachineOnline(true);
        const wake = deferred<ResumeSessionResult>();
        resumeResponse = async () => wake.promise;
        const ensure = ensureSessionRuntimeForPendingInput({
            sessionId: 's1', machineId: 'm-target', directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            serverId: runtime.serverId, accountLifetime,
        });
        try {
            await vi.waitFor(() => expect(resumeCalls()).toHaveLength(1));
            expect(currentSession().resumingAt).toEqual(expect.any(Number));
            const replacementScope = { serverId: runtime.serverId, accountId: 'replacement-account' };
            storage.getState().activateProfileScope(replacementScope);
            expect(accountLifetime.isCurrent()).toBe(false);
            storage.setState({ sessions: {} });
            storage.getState().applySessions([createSessionFixture({
                id: 's1', serverId: runtime.serverId, active: false,
            })]);
            storage.getState().markSessionResuming('s1');
            const replacementResumingAt = currentSession().resumingAt;
            expect(replacementResumingAt).toEqual(expect.any(Number));
            wake.resolve({ type: 'success', sessionId: 's1' });
            await expect(ensure).resolves.toMatchObject({ type: 'error' });
            expect(storage.getState().profileScope).toEqual(replacementScope);
            expect(currentSession().resumingAt).toBe(replacementResumingAt);
        } finally {
            wake.resolve({ type: 'success', sessionId: 's1' });
            await ensure;
        }
    });

    it('persists a send_now Pending action when the send action is forced immediate', async () => {
        storage.getState().applyMachines([createMachineFixture({ id: 'm-target', storageMode: 'plain',
            active: true, activeAt: Date.now(), daemonStateVersion: 1,
            daemonState: { daemonPendingSessionActivationSupported: true },
        })], true, { sourceServerId: runtime.serverId });
        updateSession({ active: true, activeAt: Date.now(), presence: 'online', agentStateVersion: 1, metadata: { ...currentSession().metadata!, version: '0.1.0' } });
        const handoff = deferred<Response>();
        enqueueResponse = async () => handoff.promise;
        const screen = await renderSessionView({ routeServerId: runtime.serverId });
        await changeText(screen, 'hello now');
        patchAgentInputLocalUiState(scope(), draftOwner, { scrollY: 12, textLength: 9, fontScale: 1 });
        await send(screen, { forceImmediate: true });
        await vi.waitFor(() => expect(pendingWrites()).toHaveLength(1));
        expect(findAgentInput(screen).props.value).toBe('hello now');
        expect(readAgentInputLocalUiState(scope(), draftOwner)?.scrollY).toBe(12);
        // The real durable outbox creates its local projection before HTTP handoff.
        expect(await loadPendingOutboxForSession('s1', scope())).toEqual(expect.arrayContaining([expect.objectContaining({ localId: pendingWrites()[0]?.body.localId })]));
        expect(pendingWrites()[0]?.body).toMatchObject({
            requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { meta: { happierDeliveryIntentV1: 'explicit_immediate' } } },
        });
        await act(async () => { handoff.resolve(acceptedEnqueue(pendingWrites()[0]!)); });
        await waitForSubmittedDraft(screen);
        expect(findAgentInput(screen).props.value).toBe('');
        expect(readAgentInputLocalUiState(scope(), draftOwner)?.scrollY).toBeUndefined();
        expect(resumeCalls()).toHaveLength(0);
        expect(httpWrites.filter(write => write.url.pathname.includes('/messages'))).toHaveLength(0);
        await screen.unmount();
    });

    it('keeps the submitted draft clear while an ambiguous enqueue retains Pending custody', async () => {
        updateSession({ active: true, presence: 'online', agentStateVersion: 1 });
        enqueueResponse = async () => { throw new TypeError('Failed to fetch after issuing the Pending handoff'); };
        const screen = await renderSessionView({ routeServerId: runtime.serverId });
        await changeText(screen, 'owned by pending');
        patchAgentInputLocalUiState(scope(), draftOwner, { scrollY: 12, textLength: 16, fontScale: 1 });
        await send(screen, { forceImmediate: true });
        await vi.waitFor(() => expect(pendingWrites()).toHaveLength(1));
        await waitForSubmittedDraft(screen);
        expect(findAgentInput(screen).props.value).toBe('');
        expect(readAgentInputLocalUiState(scope(), draftOwner)?.scrollY).toBeUndefined();
        expect(await loadPendingOutboxForSession('s1', scope())).toEqual(expect.arrayContaining([expect.objectContaining({ localId: pendingWrites()[0]?.body.localId })]));
        await screen.unmount();
    });

    it('keeps the submitted draft when send_now enqueue fails before durable acceptance', async () => {
        updateSession({ active: true, presence: 'online', agentStateVersion: 1 });
        enqueueResponse = async () => Response.json({ error: 'enqueue rejected' }, { status: 403 });
        const screen = await renderSessionView({ routeServerId: runtime.serverId });
        await changeText(screen, 'retry me');
        patchAgentInputLocalUiState(scope(), draftOwner, { scrollY: 12, textLength: 8, fontScale: 1 });
        await send(screen, { forceImmediate: true });
        await vi.waitFor(() => expect(pendingWrites()).toHaveLength(1));
        await waitForSubmittedDraft(screen);
        expect(findAgentInput(screen).props.value).toBe('retry me');
        expect(readAgentInputLocalUiState(scope(), draftOwner)?.scrollY).toBe(12);
        expect(httpWrites.filter(write => write.url.pathname.includes('/messages'))).toHaveLength(0);
        await screen.unmount();
    });

    it('enqueues signed-in locally attached input when the send action explicitly requests the server pending queue', async () => {
        setMachineOnline(true);
        const { useMachineAgent } = await import('@/agents/machineAgents/useMachineAgents');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, agentsById: {
            codex: { id: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                catalogAgentId: 'codex', isBuiltIn: true,
                capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
            },
        } });
        storage.setState({ settings: { ...storage.getState().settings, sessionMessageSendMode: 'agent_queue' } });
        updateSession({ active: true, presence: 'online', agentStateVersion: 1, agentState: {
            controlledByUser: true, capabilities: { inFlightSteer: true, inFlightSteerSupported: true, inFlightSteerAvailable: true },
        } });
        const auth = await renderHook(() => useMachineAgent({ serverId: runtime.serverId, machineId: 'm-target', agentId: 'codex' }));
        try {
            await vi.waitFor(() => expect(auth.getCurrent()?.signIn.status).toBe('signedIn'));
            const screen = await renderSessionView({ routeServerId: runtime.serverId });
            try {
                await changeText(screen, 'queue me');
                await send(screen, { deliveryIntent: 'server_pending' });
                await vi.waitFor(() => expect(pendingWrites()).toHaveLength(1));
                await waitForSubmittedDraft(screen);
                expect(pendingWrites()[0]?.body).toMatchObject({ content: { t: 'plain', v: { content: { text: 'queue me' } } } });
                expect(rpcCalls.filter(call => call.targetId === 's1' && call.method !== SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1)).toHaveLength(0);
                expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
            } finally { await screen.unmount(); }
        } finally {
            await auth.unmount();
        }
    });

    it('shows an offline queued banner and authorizes the exact durable row for processing when online', async () => {
        setMachineOnline(false);
        const screen = await renderSessionView();
        await publishDurablePendingState(durablePendingRow('queued-row', 'enqueue'));
        expect(screen.findByTestId('session-pendingActivation')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.queued_offline.title');
        expect(screen.findByTestId('session-pendingActivation-process_when_online')).toBeTruthy();
        expect(screen.findByTestId('session-pendingActivation-settings')).toBeTruthy();
        await screen.pressByTestIdAsync('session-pendingActivation-process_when_online');
        await vi.waitFor(() => expect(actionWrites()).toHaveLength(1));
        expect(actionWrites()[0]?.url.pathname).toContain('queued-row');
        expect(actionWrites()[0]?.body).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true });
        expect(resumeCalls()).toHaveLength(0);
        await screen.unmount();
    });

    it('resumes through the canonical session action from the online queued banner', async () => {
        resumeResponse = async () => ({ type: 'success', sessionId: 's1' });
        const screen = await renderSessionView();
        await publishDurablePendingState(durablePendingRow('queued-row', 'enqueue'));
        expect(screen.findByTestId('session-pendingActivation-resume')).toBeTruthy();
        await screen.pressByTestIdAsync('session-pendingActivation-resume');
        await vi.waitFor(() => expect(resumeCalls()).toHaveLength(1));
        expect(actionWrites()).toHaveLength(0);
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
        await screen.unmount();
    });

    it('shows waiting while offline and keeps the exact durable row queued', async () => {
        setMachineOnline(false);
        const screen = await renderSessionView();
        await publishDurablePendingState(durablePendingRow('waiting-row'), { requestId: 'waiting-row', requestedAt: 200, status: 'waiting' });
        expect(storage.getState().profileScope).toEqual(scope());
        expect(currentSession().pendingActivationAuthorization).toMatchObject({ requestId: 'waiting-row', status: 'waiting' });
        expect(currentSession().pendingActivationAuthorization!.requestedAt).toBeGreaterThan(currentSession().activeAt);
        expect(screen.findByTestId('session-pendingActivation')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.waiting_offline.title');
        expect(screen.findByTestId('session-pendingActivation-keepQueued')).toBeTruthy();
        await screen.pressByTestIdAsync('session-pendingActivation-keepQueued');
        await vi.waitFor(() => expect(actionWrites()).toHaveLength(1));
        expect(actionWrites()[0]?.url.pathname).toContain('waiting-row');
        expect(actionWrites()[0]?.body).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: false });
        await screen.unmount();
    });

    it('authors a replay continuation through New Session with source context instead of the legacy creator', async () => {
        storage.setState({ settings: { ...storage.getState().settings, sessionReplayEnabled: true,
            sessionReplayStrategy: 'recent_messages', sessionReplayRecentMessagesCount: 100, sessionReplayMaxSeedChars: 120000, sessionReplaySummaryRunnerV1: null } });
        const { codexSessionId: _vendorId, ...metadata } = currentSession().metadata!;
        // An omitted legacy field retains the previous runtime-local id; an
        // explicit empty id is canonical unavailable native-resume evidence.
        updateSession({ metadata: { ...metadata, codexSessionId: '', forkV1: {
            v: 1, parentSessionId: 'replay-parent', parentCutoffSeqInclusive: 7,
            createdAtMs: 1000, strategy: 'replay', agentHint: { agentId: 'codex' },
        }, replaySeedV1: {
            v: 1, seedText: '', sourceSessionId: 'replay-parent', sourceCutoffSeqInclusive: 7,
            createdAtMs: 1000, appliedToLocalId: 'replay-input', appliedAtMs: 2000,
        } } });
        const screen = await renderSessionView();
        await act(async () => { await emitSessionResumeRequest('s1'); });
        expect(modalMockState.current?.spies.confirm).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/new', params: expect.objectContaining({ dataId: expect.any(String) }) }));
        expect(resumeCalls()).toHaveLength(0);
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('uses the cached owning server scope for auth, resume capabilities, installables, and resume when the route serverId is missing', async () => {
        const screen = await renderSessionView();
        await act(async () => { await emitSessionResumeRequest('s1'); });
        expect(resumeCalls()).toHaveLength(1);
        expect(resumeCalls()[0]).toMatchObject({ targetId: 'm-target', payload: { directory: '/tmp/target', resume: 'codex-session-1' } });
        expect(rpcCalls.filter(call => call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE).length).toBeGreaterThan(0);
        expect(rpcCalls.every(call => typeof call.token === 'string')).toBe(true);
        expect(currentSession().serverId).toBe(runtime.serverId);
        await screen.unmount();
    });

    it('refuses a mounted manual resume when session.open is disabled on the owning Home', async () => {
        sessionOpenDisabled = true;
        storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: { 'session.open': { disabledSurfaces: ['ui'] } } },
        } });
        resumeResponse = async () => ({ type: 'success', sessionId: 's1' });
        const screen = await renderSessionView();
        try {
            await act(async () => { await emitSessionResumeRequest('s1'); });
            expect(resumeCalls()).toHaveLength(0);
            expect(currentSession().resumingAt ?? null).toBeNull();
            expect(modalMockState.current?.spies.alert).toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('parks a mounted manual resume behind the owning Home Ask-first approval before launching a process', async () => {
        sessionOpenAskFirst = true;
        storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: { 'session.open': { approvalRequiredSurfaces: ['ui'] } } },
        } });
        resumeResponse = async () => ({ type: 'success', sessionId: 's1' });
        const screen = await renderSessionView();
        try {
            // A request dispatch is not deferred approval settlement. Observe the actual
            // outward phase, distinguishing the current premature RPC from a durable request.
            await act(async () => { void emitSessionResumeRequest('s1'); });
            await vi.waitFor(() => expect(resumeCalls().length + approvalArtifacts.list().length).toBeGreaterThan(0));
            expect(resumeCalls()).toHaveLength(0);
            expect(currentSession().resumingAt ?? null).toBeNull();
            expect(approvalArtifacts.list()).toHaveLength(1);
            const body = approvalArtifacts.readPlainBody(approvalArtifacts.list()[0]!.id);
            if (body === null) throw new Error('Missing durable resume approval');
            expect(StoredApprovalRequestSchema.parse(JSON.parse(body))).toMatchObject({
                status: 'open', actionId: 'session.open',
                actionArgs: { sessionId: 's1', serverId: runtime.serverId, intent: 'resume' },
            });
        } finally {
            await screen.unmount();
        }
    });

    it('keeps ordinary public session.open navigation independent from process resume', async () => {
        const screen = await renderSessionView();
        try {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            await expect(executor.execute('session.open', { sessionId: 's1', serverId: runtime.serverId }, {
                surface: 'ui', authority: 'present_user', serverId: runtime.serverId,
                expectedAccountId: 'account-a', actionCaller: { kind: 'host' },
            })).resolves.toMatchObject({ ok: true, result: { status: 'opened', sessionId: 's1', serverId: runtime.serverId } });
            expect(resumeCalls()).toHaveLength(0);
            expect(approvalArtifacts.list()).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the queued message accepted while exposing missing-folder recovery after an automatic wake', async () => {
        updateSession({ metadata: { ...currentSession().metadata!, sessionDirectoryV1: { v: 1, kind: 'managed' } } });
        resumeResponse = async () => ({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'missing' });
        const screen = await renderSessionView();
        await changeText(screen, 'keep this prompt');
        await send(screen);
        await vi.waitFor(() => expect(screen.findByTestId('session-directory-missing')).toBeTruthy());
        expect(pendingWrites()).toHaveLength(1);
        expect(findAgentInput(screen).props.value).toBe('');
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        expect(actionWrites()).toHaveLength(0);
        await screen.unmount();
    });

    it('offers fresh-folder recovery inline and requests recreation only after explicit consent', async () => {
        updateSession({ metadata: { ...currentSession().metadata!, sessionDirectoryV1: { v: 1, kind: 'managed' } } });
        resumeResponse = async () => resumeCalls().length === 1
            ? { type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Session folder is missing' }
            : { type: 'success', sessionId: 's1' };
        const screen = await renderSessionView();
        await act(async () => { await emitSessionResumeRequest('s1'); });
        expect(resumeCalls()).toHaveLength(1);
        expect(resumeCalls()[0]?.payload).not.toMatchObject({ approvedNewDirectoryCreation: true });
        expect(screen.findByTestId('session-directory-missing')).toBeTruthy();
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-directory-missing-continue');
        expect(resumeCalls()).toHaveLength(2);
        expect(resumeCalls()[1]?.payload).toMatchObject({ approvedNewDirectoryCreation: true });
        await screen.unmount();
    });

    it('keeps a live Edit recipient sending without a Machine grant or requester recovery', async () => {
        updateSession({ active: true, activeAt: Date.now(), presence: 'online', access: createSessionAccessFixture('edit'),
            accessLevel: 'edit', owner: 'alice' });
        const screen = await renderSessionView();
        try {
            await act(async () => { storage.setState({ machineListByServerId: { [runtime.serverId]: [] },
                machineListStatusByServerId: { [runtime.serverId]: 'idle' } }); });
            expect(screen.findByTestId('session-requester-access-removed')).toBeNull();
            expect(findAgentInput(screen)).toBeDefined();
            await changeText(screen, 'Message to the shared live Session');
            await send(screen);
            await waitForSubmittedDraft(screen);
            expect(pendingWrites()).toHaveLength(1);
            expect(findAgentInput(screen).props.value).toBe('');
            expect(resumeCalls()).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('keeps requester history mounted after authoritative machine removal and authors continuation through the ordinary composer', async () => {
        setMachineOnline(true);
        const screen = await renderSessionView();
        try {
            await act(async () => { storage.setState({ machineListByServerId: { [runtime.serverId]: [] }, machineListStatusByServerId: { [runtime.serverId]: 'idle' } }); });
            expect(storage.getState().machineListByServerId[runtime.serverId]).toEqual([]);
            expect(screen.findByTestId('session-requester-access-removed')).toBeTruthy();
            expect(currentSession().metadata?.codexSessionId).toBe('codex-session-1');
            await act(async () => { await emitSessionResumeRequest('s1'); });
            expect(resumeCalls()).toHaveLength(0);
            await screen.pressByTestIdAsync('session-requester-continue-elsewhere');
            expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/new', params: expect.objectContaining({ draftId: expect.any(String) }) }));
            const route = routerPushSpy.mock.calls.at(-1)?.[0] as { params: { draftId: string } };
            const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
            expect(readNewSessionDraftFromRepository({ scope: scope(), draftId: route.params.draftId }))
                .toMatchObject({ selectedMachineId: null, executionTarget: null });
            expect(currentSession().metadata?.codexSessionId).toBe('codex-session-1');
            expect(resumeCalls()).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });

    it('does not call a loading machine inventory or unavailable encryption removed access', async () => {
        setMachineOnline(true);
        storage.setState({ machineListByServerId: { [runtime.serverId]: [] }, machineListStatusByServerId: { [runtime.serverId]: 'loading' } });
        const screen = await renderSessionView();
        try {
            expect(screen.tree.findAll(node => node.props.testID === 'session-requester-access-removed')).toHaveLength(0);
            const machine = createMachineFixture({ id: 'm-target', isShared: true, active: true, activeAt: Date.now(),
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'refused' },
                availability: { kind: 'locked', reason: 'recipient_access_refused' },
            });
            await act(async () => { storage.setState({ machineListByServerId: { [runtime.serverId]: [machine] }, machineListStatusByServerId: { [runtime.serverId]: 'idle' } }); });
            expect(screen.tree.findAll(node => node.props.testID === 'session-requester-access-removed')).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
});
