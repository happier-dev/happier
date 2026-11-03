import 'fake-indexeddb/auto';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema,
    deriveBoxPublicKeyFromSeed, encodePlainMachineStoredContent,
    PluginProjectionV2Schema, DaemonContributionRegistryProjectionDescribeResponseSchema, SessionCurrentProjectionRecordV1Schema,
    SessionAgentTransitionRequestV1Schema, SessionAgentTransitionResultV1Schema,
    SessionContinuationInspectionBatchRequestV1Schema, SessionContinuationInspectionBatchResultV1Schema,
    SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
    SessionMetadataVersionConflictV1Schema, readSessionPendingQueueHoldV1FromMetadata,
    tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { SessionDraftDocumentV1Schema } from '@happier-dev/protocol';
import type { MessageAckResponse } from '@happier-dev/protocol/updates';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
    SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
    SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmDiffSummaryDiscussInputSchema, ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm';
import type { Socket } from 'socket.io-client';
import { findTestInstanceByTypeWithProps, invokeTestInstanceHandler, renderScreen as renderTestkitScreen } from '@/dev/testkit/render/renderScreen';

import { COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1, composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import { clearSessionAttachmentDrafts, writeSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import {
    clearSessionDraftValuesForSession,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';

installDisconnectedServerSocketBoundary(configureAttachmentSocket);

// Static draft/transfer imports can bind Socket.IO before the harness loads.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Native Iroh and the daemon's loopback HTTP listener are external boundaries.
// Route selection, grant parsing, lease custody and the transfer pipeline stay real.
vi.mock('@happier-dev/iroh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/iroh-native')>();
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected native Home operation'); };
    const native = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'client-endpoint', endpointId: 'b'.repeat(64), relayPolicy: 'automatic',
            relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [] }),
        startMachineTunnel: async (input) => ({ machineTunnelId: 'attachment-tunnel', localPort: 48123,
            endpointHandle: input.endpointHandle, remoteEndpointId: input.endpointId, connectionActive: true,
            observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null }),
        startMachineHttpTunnel: async (input) => ({ machineTunnelId: 'attachment-tunnel', localPort: 48123, localCapability: 'c'.repeat(64),
            endpointHandle: input.endpointHandle, remoteEndpointId: input.endpointId, connectionActive: true,
            observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null }),
        stopMachineTunnel: async () => {},
        ensureHomeTunnel: unexpected, releaseHomeTunnel: unexpected,
        shutdownEndpoint: async () => {}, getTunnelStatus: async () => null,
    } satisfies import('@happier-dev/iroh-native').NativeIrohModule;
    return { ...actual, getOptionalHappierIrohNativeModule: () => native };
});

let seedSessionStorage: (() => void) | undefined;

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionPresentationBridge', () => ({
    SessionCompanionPresentationBridge: () => null,
}));
vi.mock('@/components/sessions/companion/SessionCompanionHost', () => ({
    SessionCompanionHost: () => null,
}));
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
    SessionBoardControllerProvider: ({ children }: React.PropsWithChildren) => children,
    useMountedSessionBoardController: () => null,
}));


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
const sessionState = vi.hoisted(() => ({
    session: {
        id: 's1',
        serverId: 'server-1',
        seq: 0,
        presence: 'offline',
        active: false,
        currentStorageState: 'hosted',
        transcriptShareable: true,
        accessLevel: 'owner',
        access: { level: 'owner', capabilities: { readTranscript: true, submitAgentInput: true } },
        metadata: {
            machineId: 'm1',
            flavor: 'codex',
            codexSessionId: 'codex-session-1',
            version: '0.0.0',
            path: '/tmp',
            homeDir: '/tmp',
        },
        agentState: {},
    } as any,
}));
const featureEnabledState = vi.hoisted(() => ({
    reviewComments: false,
}));
// The in-session Agent picker's armed intent, injected as a PRECONDITION. The
// picker's own arming logic has its own owner test; what these tests exercise is
// what `SessionView` does with an arm that already exists — specifically whether
// the send destination is resolved before anything starts an Agent.
const observedAgentPicker = vi.hoisted(() => ({ current: null as ReturnType<typeof import('@/components/sessions/agentPicker/useInSessionAgentPickerControls').useInSessionAgentPickerControls> | null }));
const clearArmedContinuationSpy = vi.hoisted(() => vi.fn());
const clearPersistedArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn());
const recordArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn());
const runSessionAgentTransitionSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({
    type: 'accepted' as const,
    localId: 'armed-local-id',
})));
const daemonMergedProjectionState = vi.hoisted(() => ({
    value: { phase: 'idle', inputs: null } as any,
}));
const preparePendingMessageComposerAdmissionMock = vi.hoisted(() => vi.fn());
const acceptPendingMessageComposerAdmissionMock = vi.hoisted(() => vi.fn());
const reviewCommentDraftsState = vi.hoisted(() => ({
    current: [] as any[],
}));
const sessionPendingMessagesState = vi.hoisted(() => ({
    current: [] as any[],
}));
// The transcript rows the canonical subagent/participant-target owner reads. Seeding
// them lets a case address a real Session-owned Execution Run through the composer's
// recipient without mocking the derivation itself.
const sessionSubagentSourceMessagesState = vi.hoisted(() => ({
    current: [] as any[],
}));
const settingsSnapshot = vi.hoisted(() => ({ experiments: true, featureToggles: {} }));
let armedLocalId = '';
const attachmentAgentInventory = createReadyMachineAgentInventoryFixture([
    { agentId: 'codex', title: 'Codex' }, { agentId: 'claude', title: 'Claude Code' },
]);

const pendingFireAndForget: Promise<unknown>[] = [];
// A failed assertion must not leave a controlled external response holding the
// Account teardown (and every later case) open.
function releaseDeferredResponse(response: (() => void) | null) { response?.(); }
const TEST_SERVER_ACCOUNT_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;

function mainAttachmentDraftScope(serverId: string) {
    return {
        serverId,
        accountId: 'account-1',
        sessionId: 's1',
        occurrenceId: composerRefV1Key({ kind: 'session', sessionId: 's1' }),
    } as const;
}

/**
 * One running Session-owned Execution Run as the transcript actually records it.
 * The canonical subagent/participant-target owner derives the addressable recipient
 * from this row; nothing here substitutes for that derivation.
 */
function createRunningSubAgentRunMessage(runId: string) {
    const now = Date.now();
    return {
        kind: 'tool-call' as const,
        id: `tool-${runId}`,
        localId: null,
        createdAt: now,
        tool: {
            name: 'SubAgentRun',
            state: 'running' as const,
            input: { runId },
            createdAt: now,
            startedAt: now,
            completedAt: null,
            description: null,
        },
        children: [],
    };
}

const chatListPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const reactNativeRuntime = vi.hoisted(() => {
    class MockAnimatedValue {
        private value: number;
        constructor(value: number) {
            this.value = value;
        }
        setValue(value: number) {
            this.value = value;
        }
        interpolate(_config: unknown) {
            return 0;
        }
    }

    return { MockAnimatedValue };
});

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext(null),
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.content ?? null, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: (props: any) => {
        chatListPropsSpy(props);
        return React.createElement('ChatList', props);
    },
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
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

function pendingMessageAuthorityExpectation(expectedSession: Session) {
    const options = updatePendingMessageSpy.mock.calls.at(-1)?.[4];
    if (!options?.accountLifetime) throw new Error('Pending update did not capture its Account lifetime');
    expect(options).toMatchObject({
        serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
        accountLifetime: {
            scope: TEST_SERVER_ACCOUNT_SCOPE,
            serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
            accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId,
        },
    });
    expect(options.accountLifetime.isCurrent()).toBe(true);
    expect(options.session).toBe(expectedSession);
    return {
        serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
        accountLifetime: options.accountLifetime,
        session: options.session,
    };
}

function setCurrentComposerAttachmentProjection(input: Readonly<{
    generation?: number;
    occurrenceId?: string;
}> = {}): void {
    const generation = input.generation ?? 7;
    const occurrenceId = input.occurrenceId ?? 'issue-generation-a';
    daemonMergedProjectionState.value = {
        phase: 'ready',
        inputs: {
            pluginProjectionById: {},
            pluginProjectionV2: PluginProjectionV2Schema.parse({
                v: 2,
                generation,
                installedPackagesById: {},
                agentsById: attachmentAgentInventory.projection.agentsById,
                actionsById: {},


                resourcesById: {},
                settingsById: {},
                familiesById: {
                    composerAttachments: {
                        family: 'composerAttachments',
                        entriesById: {
                            'acme.issues/issue': {
                                id: 'acme.issues/issue',
                                pluginId: 'acme.issues',
                                identity: { pluginId: 'acme.issues', localId: 'issue' },
                                occurrenceId,
                                definition: {
                                    id: 'issue',
                                    title: 'Issue',
                                    icon: 'warning',
                                    cardinality: 'many',
                                    valueSchema: { type: 'object' },
                                    preparedValueSchema: { type: 'object' },
                                    runtime: { prepareForSend: true },
                                },
                            },
                        },
                    },
                },
                diagnostics: [],
            }),
        },
    };
}


const resumeSessionSpy = vi.fn(async (..._args: any[]) => ({ type: 'success', sessionId: 's1' }));
const uploadSpy = vi.fn(async (..._args: any[]) => ({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' }));
function acceptedMessageAck(payload: Readonly<{ sid: string; localId: string }>) {
    return { ok: true as const, id: `message-${payload.localId}`, seq: 1, localId: payload.localId, didWrite: true };
}
const messageAckSpy = vi.fn(async (payload: Parameters<typeof acceptedMessageAck>[0]): Promise<MessageAckResponse> => acceptedMessageAck(payload));
const discussionRpc = vi.fn(async (_input: Readonly<{
    machineId: string; serverUrl: string | undefined; request: ReturnType<typeof ScmDiffSummaryDiscussInputSchema.parse>;
}>): Promise<unknown> => { throw new Error('Unexpected saved-result discussion RPC'); });
const preparedUploads = new Map<string, ReturnType<typeof SessionAttachmentUploadInitRequestV1Schema.parse>>();
const serverPendingRows = new Map<string, Record<string, unknown>>();
const observedSocketRpcMethods: string[] = [];
let serverPendingVersion = 0;
let pendingPatchRespondAfter: Promise<void> | undefined;
let canonicalRefreshRespondAfter: Promise<void> | undefined;
let readingRouteAdmission = false;

function pendingWireRow(message: PendingMessage) {
    const raw = RawRecordSchema.safeParse(message.rawRecord);
    return {
        localId: message.localId ?? message.id,
        content: { t: 'plain', v: raw.success ? raw.data : {
            role: 'user', content: { type: 'text', text: message.text },
            ...(message.displayText ? { meta: { displayText: message.displayText } } : {}),
        } },
        messageRole: 'user', status: 'queued', requestedAction: message.pendingRequestedAction ?? { v: 1, kind: 'enqueue' },
        createdAt: message.createdAt, updatedAt: message.updatedAt, position: 1,
        ...(message.recipient ? { recipient: message.recipient } : {}),
    };
}

function configureAttachmentSocket(socket: Socket, serverUrl?: string) {
    // An already-connected SDK socket does not reconnect when another reader
    // acquires it. Spurious connect events retire in-flight Account currentness.
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'emit').mockImplementation(() => socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: unknown) => {
        if (event === 'message') {
            if (!payload || typeof payload !== 'object' || !('sid' in payload) || typeof payload.sid !== 'string'
                || !('localId' in payload) || typeof payload.localId !== 'string') throw new Error('Invalid message request');
            return messageAckSpy({ sid: payload.sid, localId: payload.localId });
        }
        if (event === 'rpc-call') {
            if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
                || !('params' in payload)) throw new Error('Invalid Socket RPC request');
            const separator = payload.method.indexOf(':');
            const targetId = payload.method.slice(0, separator);
            const method = payload.method.slice(separator + 1);
            observedSocketRpcMethods.push(method);
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS) return { ok: true,
                result: ScmDiffSummaryResultResponseSchema.parse(await discussionRpc({ machineId: targetId, serverUrl,
                    request: ScmDiffSummaryDiscussInputSchema.parse(payload.params) })),
            };
            if (method === RPC_METHODS.CAPABILITIES_DETECT) return { ok: true, result: attachmentAgentInventory.capabilities };
            if (method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH) {
                const request = SessionContinuationInspectionBatchRequestV1Schema.parse(payload.params);
                return { ok: true, result: SessionContinuationInspectionBatchResultV1Schema.parse({ v: 1,
                    inspections: request.selections.map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })),
                }) };
            }
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                    protocolVersion: 1,
                    projection: daemonMergedProjectionState.value.inputs?.pluginProjectionV2
                        ?? attachmentAgentInventory.projection,
                }) };
            }
            if (method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1) {
                const request = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(payload.params);
                return { ok: true, result: SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse(
                    await preparePendingMessageComposerAdmissionMock(targetId, request),
                ) };
            }
            if (method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1) {
                await acceptPendingMessageComposerAdmissionMock(targetId,
                    SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.parse(payload.params),
                    { serverId: new URL(serverUrl ?? 'https://server-1').hostname });
                return { ok: true, result: { ok: true } };
            }
            if (method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1) return { ok: true, result: { ok: true } };
            if (method === RPC_METHODS.SESSION_AGENT_TRANSITION) {
                const request = SessionAgentTransitionRequestV1Schema.parse(payload.params);
                const result = await runSessionAgentTransitionSpy({
                    machineId: targetId, serverId: new URL(serverUrl ?? 'https://server-1').hostname, request,
                });
                // The daemon result refers to this actual request identity, not
                // a fixture-local surrogate for the picker's random localId.
                return { ok: true, result: SessionAgentTransitionResultV1Schema.parse({ ...result,
                    ...('localId' in result && request.input ? { localId: request.input.localId } : {}),
                }) };
            }
            if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                return { ok: true, result: await resumeSessionSpy(payload.params) };
            }
            if (method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) {
                return { ok: true, result: createExistingSessionDirectoryPreflightResult(payload.params) };
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) {
                if (!payload.params || typeof payload.params !== 'object' || !('workingDirectory' in payload.params)
                    || typeof payload.params.workingDirectory !== 'string') throw new Error('Missing direct-import working directory');
                // The daemon's direct-import envelope carries transport context
                // beside the strict Session attachment request.
                const { workingDirectory: _workingDirectory, ...attachment } = payload.params;
                const request = SessionAttachmentUploadInitRequestV1Schema.parse(attachment);
                const uploadId = `attachment-upload-${preparedUploads.size + 1}`;
                preparedUploads.set(uploadId, request);
                return { ok: true, result: {
                    success: true, uploadId, destDisplayPath: 'p1', expectedSizeBytes: request.sizeBytes,
                    chunkSizeBytes: 1024,
                    recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64'),
                    expiresAt: Date.now() + 60_000,
                    endpointCandidates: [{ kind: 'http', url: `http://127.0.0.1:48123/machine-transfers/direct/imports/${uploadId}`, expiresAt: Date.now() + 60_000 }],
                } };
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT) return { ok: true, result: { success: true } };
            if (method === SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND) {
                if (!payload.params || typeof payload.params !== 'object' || !('localId' in payload.params)
                    || typeof payload.params.localId !== 'string') throw new Error('Invalid runtime message request');
                const ack = await messageAckSpy({ sid: targetId, localId: payload.params.localId });
                return { ok: true, result: ack };
            }
            return { ok: false, error: 'RPC method unavailable', errorCode: 'METHOD_NOT_AVAILABLE' };
        }
        return { v: 1, ok: true, admittedSessionIds: [] };
    });
}


vi.mock('@/components/sessions/agentPicker/useInSessionAgentPickerControls', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/agentPicker/useInSessionAgentPickerControls')>();
    return { ...actual, useInSessionAgentPickerControls: (...args: Parameters<typeof actual.useInSessionAgentPickerControls>) => {
        const controls = actual.useInSessionAgentPickerControls(...args);
        observedAgentPicker.current = controls;
        // Observe dispatch ordering without substituting arm eligibility, draft
        // persistence, currentness checks, or the actual callback's result.
        const observers = React.useMemo(() => ({
            clearArmedContinuation: () => {
                clearArmedContinuationSpy();
                return controls.clearArmedContinuation();
            },
            clearArmedContinuationSubmissionIfCurrent: (...input: Parameters<typeof controls.clearArmedContinuationSubmissionIfCurrent>) => {
                clearPersistedArmedContinuationSubmissionSpy(...input);
                return controls.clearArmedContinuationSubmissionIfCurrent(...input);
            },
            recordArmedContinuationSubmission: (...input: Parameters<typeof controls.recordArmedContinuationSubmission>) => {
                recordArmedContinuationSubmissionSpy(...input);
                return controls.recordArmedContinuationSubmission(...input);
            },
        }), [controls.clearArmedContinuation, controls.clearArmedContinuationSubmissionIfCurrent, controls.recordArmedContinuationSubmission]);
        return { ...controls, ...observers };
    } };
});

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => React.createElement('AgentInput', props),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => false);

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            AccessibilityInfo: {
                isReduceMotionEnabled: async () => false,
                addEventListener: () => ({ remove: () => {} }),
            },
            Animated: {
                View: 'Animated.View',
                Value: reactNativeRuntime.MockAnimatedValue,
                timing: (_value: unknown, _config: unknown) => ({ start: (cb?: () => void) => cb?.() }),
            },
            Easing: {
                bezier: (..._args: any[]) => (t: number) => t,
                linear: (t: number) => t,
            },
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
            },
        });
    });
vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });
vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlertSpy(...args),
                confirm: modalConfirmSpy,
                prompt: vi.fn(),
            },
        }).module;
    });
vi.mock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn(), back: vi.fn() },
            pathname: '/',
        });
        return routerMock.module;
    });

// Hook reads and imperative custody reads must share the production store.
vi.doUnmock('@/sync/domains/state/storage');
const originalStorageModule = await import('@/sync/domains/state/storage');
const { resolveWorkspaceTargetForSessionFromState } = await import('@/sync/domains/session/resolveWorkspaceTargetForSessionFromState');
const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
const { resolveUniqueServerProfileByUrl, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
seedSessionStorage = () => {
    const { storage } = originalStorageModule!;
    sessionState.session = createSessionFixture({ ...sessionState.session });
    storage.setState({
        isDataReady: true,
        settings: { ...settingsDefaults, ...storage.getState().settings, ...settingsSnapshot, sessionMessageSendMode: 'agent_queue', featureToggles: {
            ...settingsSnapshot.featureToggles,
            'attachments.uploads': true,
            'files.reviewComments': featureEnabledState.reviewComments,
            automations: false,
            'execution.runs': false,
            voice: false,
        } },
        localSettings: { ...localSettingsDefaults, ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false },
        sessions: {},
        machines: {},
        machineListByServerId: {},
        sessionMessages: { s1: createSessionMessagesFixture({
            isLoaded: true,
            messagesById: Object.fromEntries(sessionSubagentSourceMessagesState.current.map((message) => [message.id, message])),
            messageIdsOldestFirst: sessionSubagentSourceMessagesState.current.map((message) => message.id),
        }) },
        sessionPending: {},
        reviewCommentsDraftsBySessionId: {},
    });
    storage.getState().applySessions([sessionState.session]);
    storage.getState().applyMachines([createMachineFixture({
        id: sessionState.session.metadata.machineId ?? 'm1',
        kind: 'persistent',
        storageMode: 'plain',
        active: true,
        activeAt: Date.now(),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } },
        daemonState: MachinePublishedDaemonStateV1Schema.parse({ status: 'running', transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: true, configured: true, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } }),
        metadata: { ...createMachineFixture().metadata!, happyCliVersion: '0.3.0', host: 'happy-host', homeDir: '/tmp' },
    })], true, { sourceServerId: sessionState.session.serverId });
    storage.getState().applyPendingMessages('s1', sessionPendingMessagesState.current.map((message) => ({
        ...message, pendingOutboxScope: TEST_SERVER_ACCOUNT_SCOPE,
    })));
    serverPendingRows.clear();
    for (const message of sessionPendingMessagesState.current) {
        serverPendingRows.set(message.localId ?? message.id, pendingWireRow(message));
    }
    serverPendingVersion = serverPendingRows.size > 0 ? 1 : 0;
    const scope = resolveWorkspaceTargetForSessionFromState(storage.getState(), {
        serverId: sessionState.session.serverId,
        sessionId: 's1',
    });
    storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: scope
        ? { [scope.workspaceCacheKey]: reviewCommentDraftsState.current } : {} });
    sessionState.session = storage.getState().sessions.s1;
};

async function renderScreen(element: Parameters<typeof renderTestkitScreen>[0]) {
    seedSessionStorage?.();
    const resumesBeforeAdmission = resumeSyncSpy.mock.calls.length;
    readingRouteAdmission = true;
    const admission = await realSyncRuntime.ensureSessionVisibleForMessageRoute('s1', {
        serverId: sessionState.session.serverId, forceRefresh: true, hydrateMessages: false,
    }).finally(() => { readingRouteAdmission = false; });
    expect(admission.kind, JSON.stringify({
        phase: 'initial-route-admission',
        admission,
        resumeReasonsDuringAdmission: resumeSyncSpy.mock.calls.slice(resumesBeforeAdmission).map(([reason]) => reason),
    })).toBe('available');
    const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    await loadDaemonMergedProjectionCacheEntry({ machineId: sessionState.session.metadata.machineId,
        serverId: sessionState.session.serverId });
    const screen = await renderTestkitScreen(element, { wrapper: SessionAccountBoundary });
    // Native lifecycle probing and authenticated feature discovery are real
    // asynchronous owners. Await their public composer admission signal.
    await vi.waitFor(() => expect(findTestInstanceByTypeWithProps(screen.tree, 'AgentInput', {})?.props.onAttachmentsAdded)
        .toBeTypeOf('function'));
    const persistedArm = readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation');
    if (persistedArm && persistedArm.intent.sourceAgentId === readSessionOwnerMetadataView(sessionState.session)?.flavor) {
        await vi.waitFor(() => expect(observedAgentPicker.current?.armedContinuationLocalId).toEqual(expect.any(String)));
    }
    if (observedAgentPicker.current?.armedContinuationLocalId) armedLocalId = observedAgentPicker.current.armedContinuationLocalId;
    return screen;
}

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/utils/system/fireAndForget', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/fireAndForget')>();
    return {
        ...actual,
        fireAndForget: (...args: Parameters<typeof actual.fireAndForget>) => {
            const [promise, options] = args;
            // Observe composer completion without replacing the owner's rejection handling.
            if (promise && options?.tag === 'SessionView.composer.dispatch') {
                pendingFireAndForget.push(promise);
            }
            return actual.fireAndForget(...args);
        },
    };
});
// Call-through observers retain the canonical decision and slash-command owners.
const useFeatureDecisionSpy = vi.spyOn(await import('@/hooks/server/useFeatureDecision'), 'useFeatureDecision');
const resolveSessionComposerSendMock = vi.spyOn(await import('@/sync/domains/input/slashCommands/resolveSessionComposerSend'), 'resolveSessionComposerSend');

const {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
// Keep draft adoption, persistence and compare/restore in the production owner.
vi.doUnmock('@/hooks/session/useDraft');
const { getSessionComposerDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
function readSessionShellDraftTextForTest(sessionId: string) {
    return getSessionComposerDraftSnapshot(TEST_SERVER_ACCOUNT_SCOPE, { kind: 'session', sessionId })?.composer.text.value;
}
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { getInactiveSessionUiState } = await import('@/components/sessions/model/inactiveSessionUi');
const { SessionView } = await import('./SessionView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
await prepareSessionDraftPersistenceStorage();
const realSyncRuntime = (await import('@/sync/syncEngine')).sync;
// Observe the real owners; response control belongs to HTTP and Socket below.
const sendMessageSpy = vi.spyOn(realSyncRuntime, 'sendMessage');
const enqueuePendingMessageSpy = vi.spyOn(realSyncRuntime, 'enqueuePendingMessage');
const updatePendingMessageSpy = vi.spyOn(realSyncRuntime, 'updatePendingMessage');
const patchSessionMetadataWithRetrySpy = vi.spyOn(realSyncRuntime, 'patchSessionMetadataWithRetry');
const ensureSessionVisibleSpy = vi.spyOn(realSyncRuntime, 'ensureSessionVisibleForMessageRoute');
const resumeSyncSpy = vi.spyOn(realSyncRuntime, 'resumeSync');
const refreshSessionMessagesSpy = vi.spyOn(realSyncRuntime, 'refreshSessionMessages');
function expectSingleAcceptedPendingHandoff() {
    expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(messageAckSpy).toHaveBeenCalledTimes(1);
    expect(serverPendingRows.size).toBe(1);
    const row = [...serverPendingRows.values()][0];
    expect(messageAckSpy.mock.calls[0]?.[0]).toEqual({ sid: 's1', localId: row?.localId });
    expect(originalStorageModule.storage.getState().sessionPending.s1?.messages)
        .toEqual(expect.arrayContaining([expect.objectContaining({ localId: row?.localId })]));
}
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
function SessionAccountBoundary({ children }: React.PropsWithChildren) {
    if (!accountConnection) throw new Error('Expected the restored Session Account');
    return <InjectedAuthProvider credentials={accountConnection.credentials}>{children}</InjectedAuthProvider>;
}

describe('SessionView (attachments.uploads resumable send)', () => {
    beforeEach(() => {
        // Previous cases can migrate the metadata tuple or publish a running
        // target. Start each independent contract from its own current Session,
        // not a mixture of that prior owner view and new legacy metadata.
        sessionState.session = createSessionFixture({
            id: 's1', serverId: 'server-1', seq: 0, presence: 0, active: false, pendingVersion: 0, pendingCount: 0,
            currentStorageState: 'hosted', transcriptShareable: true,
            metadata: { machineId: 'm1', host: 'test-home', flavor: 'codex', codexSessionId: 'codex-session-1',
                version: '0.3.0', permissionMode: 'default', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        });
        sessionSubagentSourceMessagesState.current = [];
        featureEnabledState.reviewComments = false;
        clearSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'));
        clearSessionAttachmentDrafts(mainAttachmentDraftScope('server-2'));
        sendMessageSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        resumeSyncSpy.mockClear();
        observedSocketRpcMethods.length = 0;
        refreshSessionMessagesSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        updatePendingMessageSpy.mockClear();
        patchSessionMetadataWithRetrySpy.mockClear();
        preparePendingMessageComposerAdmissionMock.mockReset().mockImplementation(async (
            _sessionId: string,
            request: { text: string; structuredInput: unknown },
        ) => ({ ok: true, text: request.text, structuredInput: request.structuredInput, stagedMediaHandles: [] }));
        acceptPendingMessageComposerAdmissionMock.mockReset().mockResolvedValue(undefined);
        daemonMergedProjectionState.value = { phase: 'idle', inputs: null };
        resumeSessionSpy.mockReset().mockResolvedValue({ type: 'success', sessionId: 's1' });
        uploadSpy.mockReset().mockResolvedValue({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
        messageAckSpy.mockReset().mockImplementation(async (payload) => acceptedMessageAck(payload));
        discussionRpc.mockReset().mockImplementation(async () => { throw new Error('Unexpected saved-result discussion RPC'); });
        preparedUploads.clear();
        pendingPatchRespondAfter = undefined;
        canonicalRefreshRespondAfter = undefined;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockReset().mockResolvedValue(false);
        resolveSessionComposerSendMock.mockClear();
        chatListPropsSpy.mockClear();
        reviewCommentDraftsState.current = [];
        sessionPendingMessagesState.current = [];
        originalStorageModule?.clearSessionMessageDerivedCachesForServerScopeReset();
        observedAgentPicker.current = null;
        armedLocalId = '';
        clearArmedContinuationSpy.mockClear();
        clearPersistedArmedContinuationSubmissionSpy.mockClear();
        recordArmedContinuationSubmissionSpy.mockClear();
        runSessionAgentTransitionSpy.mockReset().mockResolvedValue({ type: 'accepted', localId: 'armed-local-id' });
        useFeatureDecisionSpy.mockClear();
        seedSessionStorage?.();
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'composerClear' });
        // The armed continuation has the same composer-clear lifetime as its
        // sibling routing fields; session deletion is still an idempotent
        // second cleanup path.
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'sessionDelete' });
        pendingFireAndForget.length = 0;
    });

    beforeEach(async () => {
        sessionState.session = createSessionFixture({
            ...sessionState.session,
            metadata: { host: 'test-home', ...sessionState.session.metadata },
            access: createSessionAccessFixture(sessionState.session.accessLevel),
        });
        const accountHttp = createHomeHubArtifactHttpBoundary(TEST_SERVER_ACCOUNT_SCOPE.accountId);
        const purposes = createConnectedPurposeCatalogHttpBoundary();
        let wireSession: ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse> | undefined;
        let wireSessionSource: Session | undefined;
        function readWireSession() {
            if (!wireSession || wireSessionSource !== sessionState.session) {
                wireSessionSource = sessionState.session;
                wireSession = SessionCurrentProjectionRecordV1Schema.parse(createPlainSessionByIdResponseFixture(sessionState.session).session);
            }
            return wireSession;
        }
        const requestHttp = createSessionReadBatchFetchBoundary(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = new URL(String(input));
            if (url.origin === 'http://127.0.0.1:48123') {
                if (url.pathname.includes('/chunks/')) return Response.json({ success: true });
                if (url.pathname.endsWith('/finalize')) {
                    const uploadId = url.pathname.split('/').at(-2)!;
                    const request = preparedUploads.get(uploadId);
                    if (!request) throw new Error('Unknown prepared attachment upload');
                    const result = await uploadSpy(request);
                    return Response.json({ success: true,
                        finalized: { success: true, path: result.path, sizeBytes: result.sizeBytes }, sha256: result.sha256 });
                }
                throw new Error(`Unexpected attachment carrier path: ${url.pathname}`);
            }
            const path = url.pathname;
            const purposeResponse = await purposes.handle(input, init);
            if (purposeResponse) return purposeResponse;
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                const response = createRootLayoutFeaturesResponse();
                response.capabilities.session.pendingInput = { protocolVersion: 3 };
                for (const id of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation', 'sessions.agentSwitching'] as const) {
                    if (!tryWriteServerEnabledBitInPlace(response, id, true)) throw new Error(`Unknown transfer feature: ${id}`);
                }
                return Response.json(response);
            }
            if (path === '/v1/machines' || path === '/v1/machines/m1' || path === '/v1/machines/read-batch') {
                // An inactive Home's inventory is not the selected Home's bare-id map.
                const home = resolveUniqueServerProfileByUrl(url.origin, { includeCanonicalServerUrl: true });
                const machine = home ? resolveServerScopedMachine(originalStorageModule.storage.getState(), resolveServerProfileScopeId(home), 'm1') : null;
                if (!machine && path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(JSON.parse(String(init?.body)), () => null);
                if (!machine) return Response.json(path === '/v1/machines' ? [] : { error: 'Machine not found' },
                    { status: path === '/v1/machines' ? 200 : 404 });
                const row = {
                    ...createPlainMachineRowFixture({ id: machine.id, accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId }),
                    metadata: encodePlainMachineStoredContent(machine.metadata),
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState === null ? null : encodePlainMachineStoredContent(machine.daemonState),
                    daemonStateVersion: machine.daemonStateVersion,
                    operationProtocolCapabilities: machine.operationProtocolCapabilities,
                    operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
                };
                // Runtime wake performs a fresh Home census; it must see the
                // same admitted Machine/transfer declaration as the by-ID read.
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(JSON.parse(String(init?.body)), id => id === row.id ? row : null);
                return Response.json(path === '/v1/machines' ? [row] : { machine: row });
            }
            if (path === '/v1/machines/peer/mediation/route-grants') {
                const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
                const now = Date.now();
                return Response.json({ ok: true, grant: SignedDirectRouteGrantV2Schema.parse({
                    payload: { v: 2, grantId: 'attachment-grant', accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId,
                        machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind,
                        scope: request.scope, iat: now, exp: now + request.ttlMs,
                        aud: 'happier-daemon-route-grant', endpointFingerprint: request.endpointFingerprint,
                        iroh: request.iroh, proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url },
                    signature: { keyId: 'test-home', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64)).toString('base64url') },
                }) });
            }
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (path === '/v2/sessions/s1' && init?.method === 'PATCH') {
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                const current = readWireSession();
                const matches = patch.mode === 'owner_migration'
                    ? current.metadataLayoutVersion === 0
                        && patch.source.metadata.version === current.metadataVersion
                        && patch.source.metadata.ciphertext === current.metadata
                        && patch.source.agentState.version === current.agentStateVersion
                        && patch.source.agentState.ciphertext === current.agentState
                    : current.metadataLayoutVersion === 1 && patch.sharedMetadata.expectedVersion === current.metadataVersion
                        && (patch.mode === 'shared_editor' || (patch.agentState.expectedVersion === current.agentStateVersion
                            && JSON.stringify(patch.expectedOwnerMetadata) === JSON.stringify(current.ownerMetadata)));
                if (!matches) return Response.json(SessionMetadataVersionConflictV1Schema.parse({
                    code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                    sharedMetadata: { version: current.metadataVersion }, agentState: { version: current.agentStateVersion },
                }), { status: 409 });
                if (patch.mode === 'shared_editor') {
                    wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...current,
                        metadata: patch.sharedMetadata.ciphertext, metadataVersion: current.metadataVersion + 1 });
                } else {
                    const target = patch.mode === 'owner_migration' ? patch.target : patch;
                    wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...current,
                        metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
                        ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
                        metadataVersion: current.metadataVersion + 1, agentStateVersion: (current.agentStateVersion ?? 0) + 1 });
                }
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: wireSession.metadataVersion }, agentState: { version: wireSession.agentStateVersion } }));
            }
            if (path === '/v2/sessions/s1') {
                if (!readingRouteAdmission) await canonicalRefreshRespondAfter;
                return Response.json(V2SessionByIdResponseSchema.parse({ session: { ...createPlainSessionByIdResponseFixture(sessionState.session).session,
                    ...readWireSession(), active: sessionState.session.active,
                    pendingCount: serverPendingRows.size, pendingVersion: serverPendingVersion } }));
            }
            if (path === '/v1/sessions/s1/messages') {
                await canonicalRefreshRespondAfter;
                return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
            }
            if (path.startsWith('/v2/sessions/s1/') && path.includes('/pending')) {
                const runId = path.match(/\/execution-runs\/([^/]+)\/pending/u)?.[1];
                const recipient = runId ? { kind: 'execution_run', runId: decodeURIComponent(runId) } : undefined;
                if (init?.method === 'POST' || init?.method === 'PATCH') {
                    const body: unknown = JSON.parse(String(init.body));
                    if (!body || typeof body !== 'object' || !('content' in body)) throw new Error('Invalid Pending write');
                    const content = SessionStoredMessageContentSchema.parse(body.content);
                    const localId = init.method === 'PATCH'
                        ? ('replacementLocalId' in body && typeof body.replacementLocalId === 'string' ? body.replacementLocalId : decodeURIComponent(path.split('/').at(-1)!))
                        : ('localId' in body && typeof body.localId === 'string' ? body.localId : null);
                    if (!localId) throw new Error('Pending write omitted its localId');
                    const requestedAction = PendingRequestedActionV1Schema.parse('requestedAction' in body ? body.requestedAction : { v: 1, kind: 'enqueue' });
                    await pendingPatchRespondAfter;
                    if (init.method === 'POST') {
                        const ack = await messageAckSpy({ sid: 's1', localId });
                        if (!ack.ok) return Response.json({ error: ack.error }, { status: 400 });
                    }
                    const row = { localId, content, messageRole: 'user', status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), position: 1,
                        requestedAction, ...(recipient ? { recipient } : {}) };
                    if (init.method === 'PATCH') serverPendingRows.delete(decodeURIComponent(path.split('/').at(-1)!));
                    serverPendingRows.set(localId, row);
                    serverPendingVersion += 1;
                    return Response.json({ localId, requestedAction, pending: row, ...(recipient ? { recipient } : {}) });
                }
                return Response.json({ pending: [...serverPendingRows.values()].filter((row) => JSON.stringify(row.recipient) === JSON.stringify(recipient)) });
            }
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? await accountHttp.request(input, init);
        });
        accountConnection = await restoreServerAccountForTest({
            serverUrl: 'https://server-1',
            accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId,
            additionalRequestOrigins: ['https://server-2', 'https://seeded-walkthrough.example.test'],
            request: requestHttp,
        });
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(requestHttp);
        await waitForHomeGovernance(() => expect(originalStorageModule.storage.getState()).toMatchObject({
            isDataReady: true, profile: { id: TEST_SERVER_ACCOUNT_SCOPE.accountId },
        }));
        seedSessionStorage?.();
        await purposes.hydrate(TEST_SERVER_ACCOUNT_SCOPE);
        // Core readiness precedes the real startup reconnect/reachability
        // recovery. Join those observed owner promises before capturing an
        // exact Session read's Account encryption currentness revision.
        await waitForHomeGovernance(() => expect(originalStorageModule.storage.getState().socketStatus).toBe('connected'));
        await realSyncRuntime.awaitBootstrapForegroundAcquisition();
        for (const result of resumeSyncSpy.mock.results) {
            if (result.type === 'return') await result.value;
        }
        // The earlier storage activation already registered this real store.
        // Reissuing its synthetic credentials here would retire the restored
        // Account's prepared HTTP configuration before transcript reconciliation.
    });

    afterEach(async () => {
        await accountConnection?.dispose();
        accountConnection = undefined;
    });

    it('keeps attachment custody visible and refuses send during a transfer outage, then recovers', async () => {
        const screen = await renderScreen(<AppPaneProvider><SessionView id="s1" /></AppPaneProvider>);
        try {
            const readInput = () => findTestInstanceByTypeWithProps(screen.tree, 'AgentInput', {})!;
            await act(async () => {
                invokeTestInstanceHandler(readInput(), 'onChangeText', 'Describe this image', 'AgentInput');
                invokeTestInstanceHandler(readInput(), 'onAttachmentsAdded', [
                    { name: 'screen.png', size: 1, type: 'image/png', slice: () => new Blob([new Uint8Array([1])]) },
                ], 'AgentInput');
            });
            const { storage } = originalStorageModule;
            const machine = storage.getState().machines.m1;
            expect(machine).toBeDefined();
            await act(async () => { storage.getState().applyMachines([{ ...machine, active: false }], true, { sourceServerId: 'server-1' }); });
            await vi.waitFor(() => expect(readInput().props.onAttachmentsAdded).toBeUndefined());
            expect(readInput().props.attachmentRowItems).toEqual([expect.objectContaining({ label: 'screen.png', status: 'pending' })]);
            expect(readInput().props.hasSendableAttachments).toBe(true);
            expect(readInput().props.extraActionChips.some((chip: { key: string }) => chip.key === 'attachments-add')).toBe(true);
            const attachmentChip = readInput().props.extraActionChips.find((chip: { key: string }) => chip.key === 'attachments-add');
            if (attachmentChip.collapsedAction) {
                expect(attachmentChip.collapsedAction({ tint: 'currentColor', dismiss: () => {}, blurInput: () => {} }).disabled).toBe(true);
            } else {
                expect(attachmentChip.collapsedOptionsPopover.rootStep.sections[0].options.every((option: { disabled?: boolean }) => option.disabled)).toBe(true);
            }
            sendMessageSpy.mockClear(); uploadSpy.mockClear(); modalAlertSpy.mockClear();
            await act(async () => { invokeTestInstanceHandler(readInput(), 'onSend', undefined, 'AgentInput'); });
            await Promise.allSettled(pendingFireAndForget);
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(uploadSpy).not.toHaveBeenCalled();
            const { describeUploadFailure } = await import('@/components/transfers/describeUploadFailure');
            const { t } = await import('@/text');
            expect(modalAlertSpy).toHaveBeenCalledWith(t('common.error'), describeUploadFailure('unreachable', t('common.machine')));
            expect(readInput().props.value).toBe('Describe this image');
            await act(async () => { storage.getState().applyMachines([machine], true, { sourceServerId: 'server-1' }); });
            await vi.waitFor(() => expect(readInput().props.onAttachmentsAdded).toBeTypeOf('function'));
            expect(readInput().props.attachmentRowItems).toEqual([expect.objectContaining({ label: 'screen.png', status: 'pending' })]);
        } finally {
            await screen.unmount();
        }
    });

    it('preserves unsent attachment drafts when the composer moves to a sheet or the session input remounts', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let firstTree: renderer.ReactTestRenderer | undefined;
        let secondTree: renderer.ReactTestRenderer | undefined;
        try {
            const firstScreen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            firstTree = firstScreen.tree;

            const renderedFirstTree = firstTree;
            expect(renderedFirstTree).toBeDefined();
            if (!renderedFirstTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'draft-note.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const renderInSheet: SessionComposerRenderer = composer => React.createElement('PhoneAskSheetHost', null, composer.content);
            await firstScreen.update(<AppPaneProvider>
                <SessionView id="s1" {...{ renderComposer: renderInSheet }} />
            </AppPaneProvider>);
            const sheet = firstTree.findByType('PhoneAskSheetHost' as React.ElementType);
            expect(firstTree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
            expect(sheet.findByType('AgentInput' as React.ElementType).props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            act(() => {
                firstTree?.unmount();
            });
            firstTree = undefined;

            secondTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            const renderedSecondTree = secondTree;
            expect(renderedSecondTree).toBeDefined();
            if (!renderedSecondTree) throw new Error('SessionView test renderer did not remount');

            agentInput = findTestInstanceByTypeWithProps(renderedSecondTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstTree?.unmount();
                secondTree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps the main composer attachment draft isolated by exact Home while preserving same-Home remounts', async () => {
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        if (!accountConnection) throw new Error('Expected the restored Plain Account');
        const otherHome = await upsertServerProfile({ serverUrl: 'https://server-2', name: 'Second Plain Home' });
        // requestHttp declares this Home's Account mode as Plain. Reuse the
        // actual restored principal; no fixture infers mode from missing keys.
        const otherCredentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(
            otherHome.serverUrl, { serverId: otherHome.id }, accountConnection.credentials,
        );
        if (!otherCredentialWrite) throw new Error('Second Home credentials were not stored');
        let firstHomeTree: renderer.ReactTestRenderer | undefined;
        let restoredFirstHomeTree: renderer.ReactTestRenderer | undefined;
        try {
            const firstHomeScreen = await renderScreen(<AppPaneProvider>
                <SessionView id="s1" routeServerId="server-1" />
            </AppPaneProvider>);
            firstHomeTree = firstHomeScreen.tree;

            const mountedFirstHomeTree = firstHomeTree;
            if (!mountedFirstHomeTree) throw new Error('First Home SessionView did not mount');
            const firstHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(firstHomeInput, 'onAttachmentsAdded', [
                    { name: 'home-one.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                sessionState.session.serverId = 'server-2';
                seedSessionStorage?.();
                await firstHomeScreen.update(<AppPaneProvider>
                    <SessionView id="s1" routeServerId="server-2" />
                </AppPaneProvider>);
            });
            const secondHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(secondHomeInput.props.attachmentRowItems).toEqual([]);

            await act(async () => {
                sessionState.session.serverId = 'server-1';
                seedSessionStorage?.();
                await firstHomeScreen.update(<AppPaneProvider>
                    <SessionView id="s1" routeServerId="server-1" />
                </AppPaneProvider>);
            });
            const returnedFirstHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(returnedFirstHomeInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'home-one.txt', status: 'pending' }),
            ]);

            act(() => {
                firstHomeTree?.unmount();
            });
            firstHomeTree = undefined;

            restoredFirstHomeTree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" routeServerId="server-1" />
            </AppPaneProvider>)).tree;
            const mountedRestoredFirstHomeTree = restoredFirstHomeTree;
            if (!mountedRestoredFirstHomeTree) throw new Error('Restored first Home SessionView did not mount');
            const restoredFirstHomeInput = findTestInstanceByTypeWithProps(mountedRestoredFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(restoredFirstHomeInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'home-one.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstHomeTree?.unmount();
                restoredFirstHomeTree?.unmount();
            });
            sessionState.session.serverId = 'server-1';
            seedSessionStorage?.();
            await otherCredentialWrite.rollback();
        }
    });

    it.each([
        { version: '0.0.0', active: false, delivery: 'legacy_direct' },
        { version: '0.3.0', active: false, delivery: 'pending' },
        { version: '0.3.0', active: true, delivery: 'pending' },
    ] as const)('hydrates recoverable attachment drafts without another upload or duplicate admission (CLI: $version, active: $active, route: $delivery)', async ({ version, active, delivery }) => {
        sessionState.session.active = active;
        sessionState.session.presence = active ? 'online' : 'offline';
        // This is the runtime's CLI semantic version, not the metadata tuple
        // revision. The real decider retains direct fallback only below 0.1.0;
        // the UI warns about that runtime but does not block its composer.
        sessionState.session.metadata.version = version;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-retry',
            source: { kind: 'native', uri: 'file:///tmp/retry.txt', name: 'retry.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'uploaded', uploadedPath: 'p1', uploadedSizeBytes: 1,
            uploadedMimeType: 'text/plain', sha256: 'h1',
        }]);

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;

            expect(agentInput.props.attachmentRowItems).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    key: 'draft-retry',
                    label: 'retry.txt',
                    status: 'uploaded',
                }),
            ]));

            await act(async () => invokeTestInstanceHandler(agentInput, 'onChangeText', 'hello', 'AgentInput'));
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            expect(uploadSpy).not.toHaveBeenCalled();
            if (delivery === 'legacy_direct') {
                expect(sendMessageSpy).toHaveBeenCalledTimes(1);
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
                expect(messageAckSpy).toHaveBeenCalledTimes(1);
                expect(serverPendingRows.size).toBe(0);
            } else {
                expectSingleAcceptedPendingHandoff();
            }

            const writer = delivery === 'legacy_direct' ? sendMessageSpy : enqueuePendingMessageSpy;
            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = writer.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('[attachments]');
            expect(String(sentText)).toContain('- p1');
            expect(String(sentText)).toContain('retry.txt');
            expect(sentDisplayText).toBe('hello');
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            expect.objectContaining({
                                name: 'retry.txt',
                                path: 'p1',
                                mimeType: 'text/plain',
                                sizeBytes: 1,
                                sha256: 'h1',
                            }),
                        ],
                    },
                },
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('resumes and durably queues attachments for a modern inactive Session', async () => {
        expect(getInactiveSessionUiState({ isSessionActive: true, isResumable: true, isMachineOnline: true })).toMatchObject({ shouldShowInput: true });

        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            // Ignore mount-time fire-and-forget work; we only care about the send flow.
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'hello', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            // Should not show the legacy "attachments require direct sending" error anymore.
            expect(modalAlertSpy.mock.calls.some((c) => String(c?.[1] ?? '').includes('Attachments require direct sending'))).toBe(false);
            expect(resumeSessionSpy).toHaveBeenCalled();
            expect(uploadSpy).toHaveBeenCalledTimes(1);
            expectSingleAcceptedPendingHandoff();

            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = enqueuePendingMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('[attachments]');
            expect(String(sentText)).toContain('- p1');
            expect(String(sentText)).toContain('a.txt');
            expect(sentDisplayText).toBe('hello');
            expect(serverPendingRows.size).toBe(1);
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                name: 'a.txt',
                                path: 'p1',
                                mimeType: 'text/plain',
                                sizeBytes: 1,
                                sha256: 'h1',
                            },
                        ],
                    },
                },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('admits an attachment to the exact Execution Run target instead of refusing it', async () => {
        // A Session-owned Execution Run is an ordinary target of canonical Session input
        // admission: the same upload, the same encrypted Session media path, the same
        // settlement. The refusal this replaces existed only because the removed direct
        // `execution.run.send` route had no attachment channel of its own.
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        sessionSubagentSourceMessagesState.current = [createRunningSubAgentRunMessage('run-a')];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            { kind: 'execution_run', runId: 'run-a' },
        );
        writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'enqueue' });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(uploadSpy).toHaveBeenCalledTimes(1);
            expect(sendMessageSpy).not.toHaveBeenCalled();
            // The parent Session's Agent is not this input's destination, so nothing
            // starts it on the run's behalf.
            expect(resumeSessionSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
            expectSingleAcceptedPendingHandoff();

            const [sentSessionId, sentText, , sentMetaOverrides, sentOptions] = enqueuePendingMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('a.txt');
            // The uploaded attachment envelope survives intact: the destination is the
            // durable pending target, not a second authored routing fact competing for
            // the same single `happier` slot.
            expect(sentMetaOverrides).toMatchObject({
                happier: { kind: 'attachments.v1' },
            });
            expect(sentOptions).toMatchObject({
                recipient: { kind: 'execution_run', runId: 'run-a' },
                requestedAction: { v: 1, kind: 'enqueue' },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            sessionSubagentSourceMessagesState.current = [];
            pendingFireAndForget.length = 0;
        }
    });

    it('still refuses attachments addressed to an Agent-team recipient', async () => {
        // Agent-team recipients remain parent-runtime participant metadata rather than
        // independent runtime targets, so lifting the run refusal must not lift theirs.
        featureEnabledState.reviewComments = false;
        enqueuePendingMessageSpy.mockClear();
        sendMessageSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        const previousFlavor = sessionState.session.metadata.flavor;
        sessionState.session.metadata.flavor = 'claude';
        const teamCreated = createRunningSubAgentRunMessage('team-a-create');
        const teammateSpawned = createRunningSubAgentRunMessage('team-a-alpha');
        sessionSubagentSourceMessagesState.current = [
            { ...teamCreated, tool: { ...teamCreated.tool, name: 'AgentTeamCreate', state: 'completed',
                completedAt: teamCreated.createdAt, input: { team_name: 'team-a' } } },
            { ...teammateSpawned, tool: { ...teammateSpawned.tool, name: 'Task', id: 'team-a-alpha',
                input: { team_name: 'team-a', name: 'alpha' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@team-a', team_name: 'team-a', name: 'alpha' } } } },
        ];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            { kind: 'agent_team_broadcast', teamId: 'team-a' },
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            for (const settled of pendingFireAndForget) await settled;

            expect(uploadSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            sessionSubagentSourceMessagesState.current = [];
            pendingFireAndForget.length = 0;
            sessionState.session.metadata.flavor = previousFlavor;
        }
    });

    it('edits a queued message from what the transcript showed, not the expanded transport text', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-display',
            localId: 'p-display',
            text: 'Review these\n\n<review-comments>\nsrc/a.ts:1 fix it\n</review-comments>',
            displayText: 'Review these',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            expect(chatListPropsSpy).toHaveBeenCalled();
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-display',
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Review these');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the previous draft when a pending edit is abandoned by unmounting the session view', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            expect(chatListPropsSpy).toHaveBeenCalled();
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 's1' })).toMatchObject({
                ref: { kind: 'session', sessionId: 's1' },
                text: 'Existing draft',
            });
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: 'p-edit',
            })).toMatchObject({
                ref: { kind: 'pendingMessage', sessionId: 's1', localId: 'p-edit' },
                text: 'Queued edit text',
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');

            act(() => {
                tree?.unmount();
            });
            tree = undefined;

            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('routes active and focus to the current session or pending scope through its mounted input', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        const focus = vi.fn();
        const sessionRef = { kind: 'session' as const, sessionId: 's1' };
        const pendingRef = { kind: 'pendingMessage' as const, sessionId: 's1', localId: 'p-edit' };
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                occurrenceId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'activeComposer' | 'focusComposer', payload?: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            ...(payload === undefined ? {} : { payload }),
        }) as never;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            if (!tree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.onComposerFocusChange).toEqual(expect.any(Function));
            expect(agentInput.props.onComposerFocusRequestChange).toEqual(expect.any(Function));
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onComposerFocusRequestChange', focus, 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onComposerFocusChange', true, 'AgentInput');
            });

            expect(handlers.activeComposer!(request('activeComposer'))).toEqual(sessionRef);
            expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
                .toEqual({ status: 'focused' });
            expect(focus).toHaveBeenCalledTimes(1);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(handlers.activeComposer!(request('activeComposer'))).toEqual(pendingRef);
            expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
                .toEqual({ status: 'notEditable' });
            expect(handlers.focusComposer!(request('focusComposer', { ref: pendingRef })))
                .toEqual({ status: 'focused' });
            expect(focus).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => {
                handlers.dispose();
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('projects decorations and edit locks only through the active pending-message input', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        const pendingRef = { kind: 'pendingMessage' as const, sessionId: 's1', localId: 'p-edit' };
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                occurrenceId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations' | 'acquireComposerInputLock', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            if (!tree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            const snapshot = readComposerPresentationSnapshot(pendingRef);
            expect(snapshot).not.toBeNull();
            if (!snapshot) throw new Error('expected mounted pending-message composer target');
            await act(async () => {
                expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                    ref: pendingRef,
                    key: 'pending-review',
                    decorations: {
                        revision: snapshot.revision,
                        ranges: [{ range: { start: 0, end: 1 }, treatment: 'warning' }],
                    },
                }))).toEqual({ status: 'set' });
            });
            let agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.composerDecorations).toEqual([
                expect.objectContaining({ key: 'pending-review' }),
            ]);

            await act(async () => {
                expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                    subscriptionId: 'lock-1',
                    ref: pendingRef,
                    request: { reason: 'Review required', mode: 'editAndSubmit' },
                }))).toBeNull();
            });
            agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.composerInputLock).toEqual({
                mode: 'editAndSubmit',
                reasons: ['Review required'],
            });
            expect(agentInput.props.disabled).toBe(true);
            expect(agentInput.props.isSendDisabled).toBe(true);
            expect(readComposerPresentationSnapshot(pendingRef)?.state).toMatchObject({
                editable: false,
                submittable: false,
                inputLock: { mode: 'editAndSubmit', reasons: ['Review required'] },
            });
        } finally {
            act(() => {
                handlers.dispose();
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores non-text composer drafts when a modified pending edit row disappears', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

        let refreshPendingMessages!: () => void;
        const PendingMessageHarness = () => {
            const [refresh, setRefresh] = React.useState(0);
            refreshPendingMessages = () => setRefresh((current) => current + 1);
            return <AppPaneProvider>
                <SessionView
                    id="s1"
                    jumpToSeq={refresh}
                />
            </AppPaneProvider>;
        };
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<PendingMessageHarness />)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(agentInput.props.attachmentRowItems).toEqual([]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited queued text');

            sessionPendingMessagesState.current = [];
            await act(async () => {
                originalStorageModule!.storage.getState().applyPendingMessages('s1', []);
                refreshPendingMessages();
                await Promise.resolve();
            });

            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toBeNull();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });
            expect(agentInput.props.statusBadges?.some((badge: any) => badge.key === 'pending-message-edit')).toBe(false);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not overwrite a later same-text revision when a pending edit row disappears', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-same-text-disappears',
            localId: 'p-edit-same-text-disappears',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let refreshPendingMessages!: () => void;
        const PendingMessageHarness = () => {
            const [refresh, setRefresh] = React.useState(0);
            refreshPendingMessages = () => setRefresh((current) => current + 1);
            return <AppPaneProvider>
                <SessionView id="s1" jumpToSeq={refresh} />
            </AppPaneProvider>;
        };
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<PendingMessageHarness />)).tree;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Temporary edit', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onChangeText', queuedMessage.text, 'AgentInput');
            });

            sessionPendingMessagesState.current = [];
            await act(async () => {
                originalStorageModule!.storage.getState().applyPendingMessages('s1', []);
                refreshPendingMessages();
                await Promise.resolve();
            });
            await act(async () => {
                refreshPendingMessages();
                await Promise.resolve();
            });

            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toBeNull();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores unchanged prior semantic fields without overwriting a field changed during a pending edit', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-semantic-fields',
            localId: 'p-edit-semantic-fields',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const priorRecipient = { kind: 'execution_run' as const, runId: 'run-a' };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            priorRecipient,
        );
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>);
            tree = screen.tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            // This store write models the user selecting a new delivery mode while
            // the queued row owns the text editor. The recipient remains empty.
            writeSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
                { v: 1, kind: 'enqueue' },
            );
            sessionPendingMessagesState.current = [];
            await act(async () => {
                originalStorageModule!.storage.getState().applyPendingMessages('s1', []);
                await screen.update(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>);
                await Promise.resolve();
            });

            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.recipient',
            )).toEqual(priorRecipient);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'enqueue' });
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores non-text composer drafts when a modified pending edit is abandoned by unmounting', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

        let firstTree: renderer.ReactTestRenderer | undefined;
        let secondTree: renderer.ReactTestRenderer | undefined;
        try {
            firstTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedFirstTree = firstTree;
            expect(renderedFirstTree).toBeDefined();
            if (!renderedFirstTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            act(() => {
                firstTree?.unmount();
            });
            firstTree = undefined;

            expect(readSessionShellDraftTextForTest('s1')).toBe('');
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });

            secondTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            const renderedSecondTree = secondTree;
            expect(renderedSecondTree).toBeDefined();
            if (!renderedSecondTree) throw new Error('SessionView test renderer did not remount');

            agentInput = findTestInstanceByTypeWithProps(renderedSecondTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstTree?.unmount();
                secondTree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('saves a pending edit through updatePendingMessage and restores the previous draft', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
            expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 's1' })?.text).toBe('Existing draft');
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(updatePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', 'p-edit', 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not overwrite text entered while a pending edit PATCH is deferred', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred',
            localId: 'p-edit-deferred',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        pendingPatchRespondAfter = updateGate;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Intervening draft', 'AgentInput');
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Intervening draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the prior text when a pending edit returns to its accepted text before PATCH settlement', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-same-text',
            localId: 'p-edit-deferred-same-text',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        pendingPatchRespondAfter = updateGate;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );
            expect(pendingFireAndForget).toHaveLength(1);

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Temporary edit', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });
            await act(async () => {
                await Promise.resolve();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited queued text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores prior text while retaining a newer attachment snapshot after a pending edit PATCH', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-attachment',
            localId: 'p-edit-deferred-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const newerAttachment = {
            v: 1,
            instanceId: 'issue-43',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '43',
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        pendingPatchRespondAfter = updateGate;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );
            expect(pendingFireAndForget).toHaveLength(1);

            await act(async () => {
                writeSessionDraftValue(
                    TEST_SERVER_ACCOUNT_SCOPE,
                    's1',
                    'structuredInput.composerAttachments',
                    [newerAttachment],
                );
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            expect(modalAlertSpy).not.toHaveBeenCalled();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toEqual([newerAttachment]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores prior text while retaining a newer reference snapshot after a pending edit PATCH', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-reference',
            localId: 'p-edit-deferred-reference',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const newerReference = {
            kind: 'partner.reference',
            ref: 'partner:issue-99',
            token: '@new.ts',
            start: 7,
            end: 14,
            label: 'Issue #99',
        } as const;
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        pendingPatchRespondAfter = updateGate;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Before @new.ts draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited @new.ts text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited @new.ts text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );
            expect(pendingFireAndForget).toHaveLength(1);

            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(applyComposerPresentationTransaction({
                    ref: pendingRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{ kind: 'reference.insert', reference: newerReference }],
                    },
                }).status).toBe('applied');
            });
            expect(readComposerPresentationSnapshot(pendingRef)?.references).toEqual([
                expect.objectContaining({
                    kind: newerReference.kind,
                    ref: newerReference.ref,
                    token: newerReference.token,
                }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toEqual([]);
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited @new.ts text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Before @new.ts draft');
            expect(readComposerPresentationSnapshot(pendingRef)?.references).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: newerReference.kind,
                    ref: newerReference.ref,
                    token: newerReference.token,
                }),
            ]));
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toEqual([]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps an unchanged contentless attachment selection in the admitted pending envelope', async () => {
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
        } as const;
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-with-composer-attachment',
            localId: 'p-edit-with-composer-attachment',
            text: '@src/index.ts',
            displayText: '@src/index.ts',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: '@src/index.ts' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        mentions: [mention],
                        composerAttachments: [attachment],
                    },
                },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toMatchObject({
                text: queuedMessage.text,
                attachments: [attachment],
                references: [mention],
            });
            // The ordinary Session document stays independent while the
            // Pending-message document owns the visible editor.
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toBeUndefined();

            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1',
                queuedMessage.id,
                '@src/index.ts',
                {
                    v: 1,
                    mentions: [{
                        ...mention,
                        start: 0,
                        end: 13,
                    }],
                    composerAttachments: [attachment],
                },
                {
                    ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
            );
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('prepares a changed pending-edit attachment under one replacement localId before atomically saving it', async () => {
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const changedAttachment = {
            ...attachment,
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-changed-composer-attachment',
            localId: 'p-edit-changed-composer-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued edit text' },
                meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;
            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            const stagedHandle = {
                v: 1 as const, id: 'prepared-issue-child',
                executionTarget: { serverId: 'server-1', machineId: 'm1' },
                owner: attachment.attachment, mediaKind: 'image' as const, mimeType: 'image/png' as const,
                name: 'issue.png', sizeBytes: 42, sha256: 'a'.repeat(64),
            };
            const preparedAttachment = {
                ...changedAttachment,
                value: { issueId: 430 },
                presentation: { label: 'Prepared issue #430', typeLabel: 'Issue' },
                content: { kind: 'sessionMedia' as const, mediaId: 'prepared-issue-media' },
            };
            const stagedMediaReleaseIntents = [
                { handle: stagedHandle, executionTarget: stagedHandle.executionTarget, owner: stagedHandle.owner,
                    claimant: { composer: { kind: 'session' as const, sessionId: 's1' }, attachmentInstanceId: attachment.instanceId } },
                { handle: { ...stagedHandle, id: 'prepared-issue-source' }, executionTarget: stagedHandle.executionTarget, owner: stagedHandle.owner,
                    claimant: { composer: pendingRef, attachmentInstanceId: attachment.instanceId } },
            ];
            const stagedMediaHandles = stagedMediaReleaseIntents.map(({ handle }) => handle);
            const sessionMediaMetadata = {
                key: 'happier' as const, envelope: { kind: 'session_media.v1' as const, payload: { media: [{
                    id: 'prepared-issue-media', role: 'input' as const, category: 'attachment' as const,
                    mediaKind: 'image' as const, mimeType: 'image/png' as const, name: 'issue.png',
                    path: '.happier/uploads/issue.png', sizeBytes: 42, sha256: 'a'.repeat(64), origin: { source: 'user-upload' as const },
                }] } },
            };
            const attachmentApplier = createComposerPresentationTransactionApplier({
                composerAttachmentsById: {
                    'acme.issues/issue': {
                        ...daemonMergedProjectionState.value.inputs.pluginProjectionV2
                            .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                        valueValidator: () => true,
                    },
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        occurrenceId: 'issue-generation-a',
                    },
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'attachment.update',
                            instanceId: attachment.instanceId,
                            update: {
                                value: changedAttachment.value,
                                presentation: { label: 'Issue #43' },
                            },
                        }],
                    },
                }).status).toBe('applied');
            });
            preparePendingMessageComposerAdmissionMock.mockImplementationOnce(async (
                _sessionId: string,
                request: { localId: string },
            ) => ({
                ok: true,
                text: queuedMessage.text,
                structuredInput: {
                    v: 1,
                    composerAttachments: [preparedAttachment],
                },
                stagedMediaHandles,
                stagedMediaReleaseIntents,
                sessionMediaMetadata,
            }));

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const pendingEditSourceSession = originalStorageModule.storage.getState().sessions.s1;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            expect(preparePendingMessageComposerAdmissionMock).toHaveBeenCalledTimes(1);
            const prepareRequest = preparePendingMessageComposerAdmissionMock.mock.calls[0]?.[1];
            expect(prepareRequest).toMatchObject({
                localId: expect.any(String),
                text: queuedMessage.text,
                sourceComposerRef: pendingRef,
                structuredInput: {
                    v: 1,
                    composerAttachments: [{
                        instanceId: attachment.instanceId,
                        key: attachment.key,
                        value: changedAttachment.value,
                    }],
                },
            });
            const replacementLocalId = prepareRequest.localId;
            expect(replacementLocalId).not.toBe(queuedMessage.localId);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith('s1', queuedMessage.id, queuedMessage.text, {
                v: 1,
                composerAttachments: [preparedAttachment],
            }, expect.objectContaining({
                replacementLocalId,
                preparedComposerAdmission: { stagedMediaHandles, stagedMediaReleaseIntents, sessionMediaMetadata },
                ...pendingMessageAuthorityExpectation(pendingEditSourceSession),
            }));
            expect(acceptPendingMessageComposerAdmissionMock).toHaveBeenCalledWith('s1', {
                sessionId: 's1',
                localId: replacementLocalId,
                structuredInput: {
                    v: 1,
                    composerAttachments: [preparedAttachment],
                },
                stagedMediaHandles,
                stagedMediaReleaseIntents,
                sessionMediaMetadata,
            }, expect.objectContaining({ serverId: 'server-1' }));
            expect(updatePendingMessageSpy.mock.invocationCallOrder[0])
                .toBeLessThan(acceptPendingMessageComposerAdmissionMock.mock.invocationCallOrder[0]!);
            expect(modalAlertSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps the pending edit when canonical attachment admission rejects', async () => {
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-staged-media-composer-attachment',
            localId: 'p-edit-staged-media-composer-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued edit text' },
                meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;
            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            const attachmentApplier = createComposerPresentationTransactionApplier({
                composerAttachmentsById: {
                    'acme.issues/issue': {
                        ...daemonMergedProjectionState.value.inputs.pluginProjectionV2
                            .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                        valueValidator: () => true,
                    },
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        occurrenceId: 'issue-generation-a',
                    },
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'attachment.update',
                            instanceId: attachment.instanceId,
                            update: {
                                value: { issueId: 43 },
                                presentation: { label: 'Issue #43' },
                            },
                        }],
                    },
                }).status).toBe('applied');
            });
            // The canonical Session admission owner rejects any transform or
            // finalization failure before the Pending writer sees a payload.
            preparePendingMessageComposerAdmissionMock.mockResolvedValueOnce({
                ok: false,
                error: 'composer_attachment_admission_failed',
                errorCode: 'composer_attachment_admission_failed',
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            // Nothing is persisted, and the refusal is reported instead of the
            // message being dropped silently at the queue.
            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('refuses malformed persisted semantic input without mutating the active composer', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-with-malformed-semantic-input',
            localId: 'p-edit-with-malformed-semantic-input',
            text: 'Queued malformed semantic input edit text',
            displayText: 'Queued malformed semantic input edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued malformed semantic input edit text' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        // This is intentionally not a valid Composer attachment. The raw
                        // guard must fail closed for malformed persisted semantic input,
                        // without reviving it into the text-only editor.
                        unknownPersistedSemanticInput: [{ source: 'legacy-invalid' }],
                    },
                },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            patchSessionMetadataWithRetrySpy.mockClear();
            modalAlertSpy.mockClear();

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });
            expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();
            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalledWith(
                'common.error',
                'session.pendingMessages.errors.editStructuredInputUnsupported',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('publishes and clears a pending queue drain hold while editing a queued message', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            const metadataWithHold = readSessionOwnerMetadataView(originalStorageModule!.storage.getState().sessions.s1);
            const holdsById = readSessionPendingQueueHoldV1FromMetadata(metadataWithHold)?.holdsById;
            const holdId = Object.keys(holdsById ?? {})[0];
            expect(holdId).toBeTruthy();
            expect(holdsById?.[holdId]).toMatchObject({
                kind: 'pending_message_edit',
                localId: 'p-edit',
            });

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(readSessionOwnerMetadataView(originalStorageModule!.storage.getState().sessions.s1))
                .not.toHaveProperty('sessionPendingQueueHoldV1');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps composer text visible through the local pending projection until a current accepted ACK', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });
        let resolveSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<ReturnType<typeof acceptedMessageAck>>((resolve, reject) => {
                    resolveSend = () => resolve(acceptedMessageAck(payload));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await vi.waitFor(() => expect(uploadSpy, JSON.stringify(modalAlertSpy.mock.calls)).toHaveBeenCalled());
            await act(async () => {
                await uploadStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(0);

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await vi.waitFor(() => expect(resolveSend).toBeTypeOf('function'));
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(agentInput.props.value).toBe('Describe this image');

            expect(originalStorageModule.storage.getState().sessionPending.s1.messages)
                .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Describe this image') })]));
            expect(agentInput.props.value).toBe('Describe this image');

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
        } finally {
            releaseDeferredResponse(resolveUpload);
            releaseDeferredResponse(resolveSend);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('preserves newer attachment drafts when a no-callback attachment send resolves after the draft changes', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let resolveSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<ReturnType<typeof acceptedMessageAck>>((resolve, reject) => {
                    resolveSend = () => resolve(acceptedMessageAck(payload));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            await act(async () => {
                await vi.waitFor(() => expect(resolveSend).toBeTypeOf('function'));
                await sendStarted;
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            releaseDeferredResponse(resolveSend);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('preserves attachment drafts added while the submitted attachments are uploading', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });

        let resolveSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<ReturnType<typeof acceptedMessageAck>>((resolve, reject) => {
                    resolveSend = () => resolve(acceptedMessageAck(payload));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await uploadStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await vi.waitFor(() => expect(resolveSend).toBeTypeOf('function'));
                await sendStarted;
            });

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            releaseDeferredResponse(resolveUpload);
            releaseDeferredResponse(resolveSend);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears submitted text while preserving an attachment draft added during upload', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });

        let acceptSendAck: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<ReturnType<typeof acceptedMessageAck>>((resolve, reject) => {
                    acceptSendAck = () => resolve(acceptedMessageAck(payload));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await uploadStarted;
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await vi.waitFor(() => expect(acceptSendAck).toBeTypeOf('function'));
                await sendStarted;
            });

            await act(async () => {
                if (!acceptSendAck) throw new Error('send ACK was not registered');
                acceptSendAck();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            releaseDeferredResponse(resolveUpload);
            releaseDeferredResponse(acceptSendAck);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears a reference-only edit with unchanged accepted Main Session text', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });
        let acceptHandoff: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<ReturnType<typeof acceptedMessageAck>>((resolve, reject) => {
                    acceptHandoff = () => resolve(acceptedMessageAck(payload));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Use @accepted.ts and @newer.ts', 'AgentInput');
            });

            const sessionRef = { kind: 'session' as const, sessionId: 's1' };
            await act(async () => {
                const current = readComposerPresentationSnapshot(sessionRef);
                if (!current) throw new Error('expected active Session Composer snapshot');
                expect(current).toMatchObject({
                    text: 'Use @accepted.ts and @newer.ts',
                    capabilities: { references: true },
                });
                expect(applyComposerPresentationTransaction({
                    ref: sessionRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'reference.insert',
                            reference: {
                                kind: 'partner.reference',
                                ref: 'partner:accepted',
                                token: '@accepted.ts',
                                start: 4,
                                end: 16,
                                label: 'Accepted issue',
                            },
                        }],
                    },
                }).status).toBe('applied');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await uploadStarted;
            });

            const newerMention = {
                kind: 'partner.reference',
                ref: 'partner:newer',
                token: '@newer.ts',
                start: 21,
                end: 30,
                label: 'Newer issue',
            } as const;
            await act(async () => {
                const current = readComposerPresentationSnapshot(sessionRef);
                if (!current) throw new Error('expected active Session Composer snapshot');
                expect(applyComposerPresentationTransaction({
                    ref: sessionRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{ kind: 'reference.insert', reference: newerMention }],
                    },
                }).status).toBe('applied');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Use @accepted.ts and @newer.ts');
            expect(readComposerPresentationSnapshot(sessionRef)?.references).toEqual(expect.arrayContaining([
                expect.objectContaining({ ref: newerMention.ref, token: newerMention.token }),
            ]));

            await act(async () => {
                if (!resolveUpload) throw new Error('attachment upload did not start');
                resolveUpload();
                await vi.waitFor(() => expect(acceptHandoff).toBeTypeOf('function'));
                await sendStarted;
            });

            await act(async () => {
                if (!acceptHandoff) throw new Error('local pending projection callback was not registered');
                acceptHandoff();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            // Both reference transactions are ranges in the unchanged accepted
            // text. The document owner clears those ranges with their text.
            expect(readComposerPresentationSnapshot(sessionRef)?.references).toEqual([]);
            expect(agentInput.props.value).toBe('');
        } finally {
            releaseDeferredResponse(resolveUpload);
            releaseDeferredResponse(acceptHandoff);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('retains text and attachment drafts when the uploaded send is not accepted', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let rejectSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<MessageAckResponse>((resolve) => {
                    rejectSend = () => resolve({ ok: false, error: 'attachment handoff rejected' });
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await vi.waitFor(() => expect(rejectSend).toBeTypeOf('function'));
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'a.txt', status: 'uploaded' }),
            ]);

            await act(async () => {
                if (!rejectSend) throw new Error('send did not start');
                rejectSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'a.txt', status: 'uploaded' }),
            ]);
            expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Failed to enqueue pending message (400)');
            expect(messageAckSpy).toHaveBeenCalledTimes(1);
            expect(serverPendingRows.size).toBe(0);
        } finally {
            releaseDeferredResponse(rejectSend);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not restore a failed attachment send over a newer attachment-only draft', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let rejectSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            messageAckSpy.mockImplementationOnce(async (payload) => {
                resolveStarted();
                return await new Promise<MessageAckResponse>((resolve) => {
                    rejectSend = () => resolve({ ok: false, error: 'attachment handoff rejected' });
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await vi.waitFor(() => expect(rejectSend).toBeTypeOf('function'));
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'a.txt', status: 'uploaded' }),
            ]);

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', '', 'AgentInput');
                agentInput.props.attachmentRowItems[0].onRemove();
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!rejectSend) throw new Error('send did not start');
                rejectSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
            expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Failed to enqueue pending message (400)');
            expect(messageAckSpy).toHaveBeenCalledTimes(1);
            expect(serverPendingRows.size).toBe(0);
        } finally {
            releaseDeferredResponse(rejectSend);
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it.each([false, true])('sends review comments and attachments with both metadata envelopes (execution run: %s)', async (executionRun) => {
        // The real shell only admits a session whose cached Home matches its route.
        const previousServerId = sessionState.session.serverId;
        sessionState.session.serverId = 'server-1';
        featureEnabledState.reviewComments = true;
        if (executionRun) {
            sessionSubagentSourceMessagesState.current = [createRunningSubAgentRunMessage('run-review')];
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.recipient', {
                kind: 'execution_run', runId: 'run-review',
            });
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'enqueue' });
        }
        reviewCommentDraftsState.current = [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }];
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        const renderInSheet: SessionComposerRenderer = composer => React.createElement('PhoneAskSheetHost', null, composer.content);
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" routeServerId="server-1" renderComposer={executionRun ? undefined : renderInSheet} />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            if (!executionRun) {
                expect(renderedTree.findByType('PhoneAskSheetHost' as React.ElementType)
                    .findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
            }

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            const writer = enqueuePendingMessageSpy;
            expectSingleAcceptedPendingHandoff();
            expect(uploadSpy).toHaveBeenCalledTimes(1);
            if (executionRun) {
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(resumeSessionSpy).not.toHaveBeenCalled();
                expect(writer.mock.calls[0]?.[4]).toMatchObject({
                    recipient: { kind: 'execution_run', runId: 'run-review' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                });
            }
            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = writer.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('Please verify this project change.');
            expect(String(sentText)).toContain('[attachments]');
            expect(sentDisplayText).toContain('Review comments (1)');
            expect(sentDisplayText).toContain('[attachments]');
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        comments: [expect.objectContaining({ id: 'draft-1' })],
                    },
                },
                happierAttachments: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            expect.objectContaining({
                                name: 'a.txt',
                                path: 'p1',
                            }),
                        ],
                    },
                },
            });
            expect(Object.values(originalStorageModule!.storage.getState().reviewCommentsDraftsByWorkspaceCacheKey).flat())
                .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'draft-1' })]));
        } finally {
            sessionState.session.serverId = previousServerId;
            featureEnabledState.reviewComments = false;
            reviewCommentDraftsState.current = [];
            sessionSubagentSourceMessagesState.current = [];
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('admits a pending seeded walkthrough through saved-result discussion without sending to the Session agent', async () => {
        // Real credential-resolution, custody and draft owners; transport replies
        // remain the external inputs to this composed case.
        const { upsertServerProfile, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getSessionDraftSnapshot, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const profile = await upsertServerProfile({ name: 'Seeded walkthrough test', serverUrl: 'https://seeded-walkthrough.example.test' });
        const home = await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_seeded_walkthrough');
        if (!home) throw new Error('The walkthrough Home identity was not established');
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'account-1' };
        expect(home.id).not.toBe(scope.serverId);
        if (!accountConnection) throw new Error('Expected the restored Account credentials');
        const credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(
            home.serverUrl, { serverId: scope.serverId }, {
                token: createAccountTokenForTests(scope.accountId, { currentAccount: true }),
            },
        );
        if (!credentialWrite) throw new Error('The walkthrough Home credentials were not stored');
        const transport = discussionRpc;
        const conflictResponse = { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 5 };
        const discussionResponse = { success: true, runId: 'seeded-run', result: { resultId: 'saved', revision: 5, canUndo: false,
            output: { success: true, resultId: 'saved', revision: 5, runId: 'seeded-run', sourceKey: 'comparison',
                metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
                comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/tmp' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } } };
        transport.mockResolvedValueOnce(conflictResponse);
        transport.mockResolvedValueOnce(discussionResponse);
        // The real Session SCM Action resolves this Home's Machine and reaches
        // its daemon through the scoped Socket RPC boundary above.
        const previousServerId = sessionState.session.serverId;
        sessionState.session.serverId = scope.serverId;
        featureEnabledState.reviewComments = false;
        const target = { cwd: '/tmp', resultId: 'saved', expectedRevision: 4, startNew: true };
        writeExistingSessionDraft({ scope, sessionId: 's1', patch: { text: '/compact explain this stop',
            routing: { recipient: { mode: 'scm_diff_summary', recipient: null, target } } }, materializationIntent: 'userEdit' });
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider><SessionView id="s1" routeServerId={home.id} /></AppPaneProvider>)).tree;
            const mounted = tree;
            if (!mounted) throw new Error('SessionView did not mount');
            const binding = mounted.root.findAll(node => typeof node.type === 'function'
                && node.type.name === 'SessionViewLoadedContent')[0]?.props.accountBinding;
            expect(binding?.isCurrent(), 'saved-result composer requires a current exact-Home Account binding').toBe(true);
            expect(binding?.scope).toEqual(scope);
            const { readMachineControlTargetForSession } = await import('@/sync/ops/sessionMachineTarget');
            expect(readMachineControlTargetForSession({ ...scope, sessionId: 's1' })).toMatchObject({ machineId: 'm1', basePath: '/tmp' });
            expect(resolveServerProfileScopeIdForIdentifier(accountConnection.serverId)).not.toBe(scope.serverId);
            expect(resolveServerScopedMachine(originalStorageModule.storage.getState(), scope.serverId, 'm1'))
                .toMatchObject({ id: 'm1', storageMode: 'plain' });
            expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document.target.kind).toBe('session');
            await vi.waitFor(() => {
                const input = findTestInstanceByTypeWithProps(mounted, 'AgentInput', {});
                expect(input?.props.extraActionChips?.some((chip: { controlId?: string; collapsedOptionsPopover?: { selectedOptionId?: string } }) => (
                    chip.controlId === 'recipient' && chip.collapsedOptionsPopover?.selectedOptionId === 'pending-scm-discussion'
                ))).toBe(true);
            });
            // Enter through the real mounted input after its scoped draft binds.
            await act(async () => invokeTestInstanceHandler(findTestInstanceByTypeWithProps(mounted, 'AgentInput', {}),
                'onChangeText', '/compact explain this stop', 'AgentInput'));
            pendingFireAndForget.length = 0;
            resolveSessionComposerSendMock.mockClear();
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const input = findTestInstanceByTypeWithProps(mounted, 'AgentInput', {});
                await act(async () => {
                    invokeTestInstanceHandler(input, 'onSend', undefined, 'AgentInput');
                    await pendingFireAndForget.at(-1);
                });
                expect(transport, JSON.stringify({
                    phase: 'saved-result-discussion',
                    confirmations: modalConfirmSpy.mock.calls.length,
                    // Only closed code-like feedback is safe to include; no
                    // transport body, URL, credential or request input is logged.
                    feedbackCodes: modalAlertSpy.mock.calls.map(([, message]) => (
                        typeof message === 'string' && /^[a-z][a-z0-9_]*$/u.test(message)
                            ? message : 'non_code_feedback'
                    )),
                    rpcMethods: [...new Set(observedSocketRpcMethods)],
                })).toHaveBeenCalledTimes(attempt + 1);
                const document = SessionDraftDocumentV1Schema.parse(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document);
                expect(document?.composer.text.value).toBe(attempt === 0 ? '/compact explain this stop' : '');
                expect(document?.target.kind === 'session' && document.target.routing.recipient.value).toEqual(attempt === 0
                    ? { mode: 'scm_diff_summary', recipient: null, target }
                    : { mode: 'manual', recipient: { kind: 'execution_run', runId: 'seeded-run' } });
            }
            expect(transport).toHaveBeenCalledTimes(2);
            expect(transport.mock.calls[0]?.[0]).toEqual({ machineId: 'm1', serverUrl: home.serverUrl,
                request: { ...target, message: '/compact explain this stop' } });
            expect(resolveSessionComposerSendMock).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(resumeSessionSpy).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
            await credentialWrite.rollback();
            sessionState.session.serverId = previousServerId;
            clearSessionDraftValuesForSession(scope, 's1');
            pendingFireAndForget.length = 0;
        }
    });

    // The composer has two destinations, and starting an Agent is the one step
    // that cannot be taken back. An inactive Session resumed on the way to an
    // ARMED send starts the source Agent — the very Agent the reader chose to
    // leave — which spends provider work and can make the transition fail
    // non-idle. So the destination decision must happen before any Agent-runtime
    // side effect, not after the upload.
    describe('armed Agent continuation', () => {
        const armSecondAgent = () => {
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation', {
                backendTargetKey: 'agent:happier.agent.claude/claude',
                intent: { v: 1, mode: 'same_session', sourceAgentId: 'codex', selection: { v: 1, agentId: 'claude' } },
            });
        };

        async function sendOneAttachment(tree: renderer.ReactTestRenderer) {
            const agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => { await pendingFireAndForget[0]; });
        }

        // The switch runs on THIS Session's server, and neither the daemon nor
        // the server re-gates the transition, so the scope of this one decision
        // IS the gate. Resolving it against whichever servers happen to be
        // selected in the sidebar makes an unrelated server's setting decide
        // whether this Session may switch Agent.
        it('resolves the Agent-switching gate against this Session\'s server', async () => {
            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                expect(useFeatureDecisionSpy).toHaveBeenCalledWith(
                    'sessions.agentSwitching',
                    expect.objectContaining({ scopeKind: 'spawn', serverId: 'server-1' }),
                );
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not start the inactive source Agent when the send is armed for another Agent', async () => {
            armSecondAgent();

            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                pendingFireAndForget.length = 0;
                const renderedTree = tree;
                if (!renderedTree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(renderedTree);

                expect(resumeSessionSpy).not.toHaveBeenCalled();
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).toHaveBeenCalledTimes(1);
                const [transitionInput] = runSessionAgentTransitionSpy.mock.calls[0] ?? [];
                expect(transitionInput).toMatchObject({
                    machineId: 'm1',
                    request: {
                        sessionId: 's1',
                        expectedCurrentAgentId: 'codex',
                        selection: { agentId: 'claude' },
                        input: { localId: armedLocalId },
                    },
                });
                expect(String((transitionInput as any)?.request?.input?.text ?? '')).toContain('a.txt');
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });

        it('records the exact nested handoff before the transition RPC starts', async () => {
            armSecondAgent();
            runSessionAgentTransitionSpy.mockImplementationOnce(async ({ request }) => {
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')?.submission)
                    .toMatchObject({ localId: request.input.localId, input: request.input });
                return { type: 'accepted', localId: request.input.localId };
            });

            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                if (!tree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(tree);

                expect(recordArmedContinuationSubmissionSpy).toHaveBeenCalledWith(expect.objectContaining({
                    localId: armedLocalId,
                    input: expect.objectContaining({ localId: armedLocalId }),
                    currentness: expect.objectContaining({
                        text: '',
                        attachmentDraftIds: [expect.any(String)],
                    }),
                }));
                expect(recordArmedContinuationSubmissionSpy.mock.invocationCallOrder[0])
                    .toBeLessThan(runSessionAgentTransitionSpy.mock.invocationCallOrder[0]!);
            } finally {
                act(() => { tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        async function sendArmedAndReadBanner(result: unknown, pendingBeforeResult = false) {
            armSecondAgent();
            runSessionAgentTransitionSpy.mockImplementationOnce(async ({ request }) => {
                if (pendingBeforeResult) syncPendingRowForLocalId(request.input.localId);
                return result as any;
            });
            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            await sendOneAttachment(screen.tree);
            return screen;
        }

        it('tells the reader through the composer banner instead of a modal they must dismiss', async () => {
            // The switch happened and the message did not. A modal buries that
            // under an OK button and leaves the composer looking ordinary; the
            // banner sits above the composer the reader is about to use again.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: armedLocalId,
                applied: 'current_view_committed',
                code: 'divider_unavailable',
            });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner').length).toBeGreaterThan(0);
                expect(screen.getTextContent())
                    .toContain('session.agentContinuation.transition.switched');
                // Collapsing must demote the signal to a badge, never destroy it,
                // so the banner always publishes one into the composer action bar.
                const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                const badges = (agentInput?.props?.statusBadges ?? []) as ReadonlyArray<{ testID?: string }>;
                expect(badges.some((badge) => badge.testID === 'session.agentTransitionOutcome.badge')).toBe(true);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('delegates the committed-but-inactive recovery to the Session resume owner', async () => {
            // The Session already IS the target and has no live runtime, so the
            // one factual recovery is to start it — through the same resume owner
            // every other inactive-session affordance uses, not a second start
            // path owned by the banner.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: armedLocalId,
                applied: 'current_view_committed',
                code: 'divider_unavailable',
            });
            try {
                resumeSessionSpy.mockClear();
                await act(async () => {
                    await screen.pressByTestIdAsync('session.agentTransitionOutcome.resume');
                });
                expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('hands a switch whose input is already queued to the Session queued-message owner', async () => {
            // `target_start_failed` is only reachable after the daemon admitted
            // this exact localId, so telling the reader "your message wasn't
            // sent. Send it again." is false — and following it duplicates the
            // message, because the spent arm makes the retry an ordinary send
            // under a fresh identity. The true state — admitted input, no
            // runtime — is the one the Session's queued-message banner already
            // owns, so it is raised instead of a second banner beside it.
            sessionState.session.active = false;
            sessionState.session.presence = 0;
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: armedLocalId,
                applied: 'current_view_committed',
                code: 'target_start_failed',
            }, true);
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.getTextContent())
                    .not.toContain('session.agentContinuation.transition.switched');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(pendingActivationLine(screen)).not.toBeNull();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        /**
         * The real ordering, and the one the case below this seeds away: the
         * daemon answers, and the canonical pending row for that exact localId
         * reaches this client a beat later. Notifying the pending-message
         * store is that sync arriving — the same re-render the store publishes
         * in production.
         */
        /** The Session's queued-input state, which speaks on the composer's status line rather than as a banner. */
        function pendingActivationLine(screen: { tree?: Parameters<typeof findTestInstanceByTypeWithProps>[0] | null }) {
            if (!screen.tree) return null;
            const status = (findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any).props.connectionStatus as
                | { text: string; action?: { label: string } }
                | undefined;
            return status?.text.startsWith('session.pendingActivation.') ? status : null;
        }

        function syncPendingRowForLocalId(localId: string) {
            const retained = readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')?.submission;
            const dispatched = runSessionAgentTransitionSpy.mock.calls
                .map(([call]) => call.request.input)
                .find((input) => input?.localId === localId);
            const input = retained?.localId === localId ? retained.input : dispatched;
            if (!input) throw new Error('Pending custody needs the exact retained or dispatched transition input');
            const row = {
                id: `pending-${localId}`,
                localId,
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending' as const,
                messageRole: 'user' as const,
                pendingDeliveryStatus: 'server_queued' as const,
                pendingRequestedAction: { v: 1 as const, kind: 'enqueue' as const },
                pendingOutboxScope: TEST_SERVER_ACCOUNT_SCOPE,
                text: input.text,
                rawRecord: RawRecordSchema.parse({ role: 'user', content: { type: 'text', text: input.text }, meta: input.meta }),
            };
            sessionPendingMessagesState.current = [row];
            serverPendingRows.set(localId, pendingWireRow(row));
            serverPendingVersion += 1;
            act(() => {
                originalStorageModule!.storage.getState().applyPendingMessages('s1', [row]);
            });
        }

        it('keeps same-mount Agent switching in the composer send state until the transition answers', async () => {
            setCurrentComposerAttachmentProjection();
            armSecondAgent();
            let settleTransition: (result: unknown) => void = () => {};
            runSessionAgentTransitionSpy.mockImplementationOnce(() => new Promise((resolve) => {
                settleTransition = resolve;
            }) as any);

            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            try {
                const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'switch and send this', 'AgentInput');
                });
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                    await Promise.resolve();
                });

                expect(runSessionAgentTransitionSpy).toHaveBeenCalledTimes(1);
                expect(screen.getTextContent()).not.toContain('session.agentContinuation.transition.unknown');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);

                // The Pending row can synchronize before the transition RPC answers.
                // While the same-mount send still owns the operation, the generic
                // inactive-session recovery must not compete with its spinner or
                // imply that the reader needs to resume the source Agent.
                syncPendingRowForLocalId(armedLocalId);
                expect(pendingActivationLine(screen)).toBeNull();
                const inFlightInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                expect(inFlightInput.props.isSending).toBe(true);
                expect((inFlightInput.props.statusBadges as readonly { testID?: string }[])
                    .some((badge) => badge.testID === 'session.pendingActivation.badge')).toBe(false);

                await act(async () => {
                    settleTransition({ type: 'accepted', localId: armedLocalId });
                    await pendingFireAndForget[0];
                });

                // Suppression is only for the live operation. If the target has
                // not become active yet, the existing pending-activation owner is
                // still the post-operation recovery surface.
                expect(pendingActivationLine(screen)).not.toBeNull();
            } finally {
                settleTransition({ type: 'accepted', localId: armedLocalId });
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('tells the reader when custody of the queued input only lands after the switch answered', async () => {
            // The case below seeds the pending row BEFORE the send, so it passes
            // whether or not custody is watched. A real Session cannot: the row is
            // written after the RPC returns, and a disposition decided once
            // against `absent` and never re-decided is exactly how this arm
            // reached a reader saying nothing at all.
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: armedLocalId });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Nothing yet, correctly: no canonical fact has arrived.
                expect(pendingActivationLine(screen)).toBeNull();

                sessionState.session.active = false;
                sessionState.session.presence = 0;
                syncPendingRowForLocalId(armedLocalId);

                expect(pendingActivationLine(screen)).not.toBeNull();
                // Never an invitation to send the same input twice: the only action
                // is the Session's own resume owner, which drains the queue.
                expect(pendingActivationLine(screen)?.action?.label).toBe('session.pendingActivation.actions.resume');
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not show a stale queued-input activation banner while the Session and machine are reachable', async () => {
            // `target_start_failed` is the daemon's own account: the input was
            // admitted and the target then failed to start. A client-side liveness
            // read must never weaken a definite daemon arm, so this must be stated
            // even while this client still believes the Session is running.
            const restoreActive = sessionState.session.active;
            const restorePresence = sessionState.session.presence;
            sessionState.session.active = true;
            sessionState.session.presence = 'online';
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: armedLocalId,
                applied: 'current_view_committed',
                code: 'target_start_failed',
            });
            try {
                expect(pendingActivationLine(screen)).toBeNull();
            } finally {
                sessionState.session.active = restoreActive;
                sessionState.session.presence = restorePresence;
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not go silent when an ACCEPTED switch leaves the message behind a target that never came up', async () => {
            // The real failure: `accepted` came back, the target runtime died,
            // and the reader was told NOTHING — new Agent on screen, message
            // never processed, Session inactive, no banner. `accepted` only ever
            // meant "spawn acknowledged"; there is no readiness wait behind it.
            sessionState.session.active = false;
            sessionState.session.presence = 0;
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: armedLocalId }, true);
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Still no second banner of its own — the Session's existing
                // queued-message owner says it, exactly as for `target_start_failed`.
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(pendingActivationLine(screen)).not.toBeNull();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('stays silent for an ACCEPTED switch whose message a runtime already carried', async () => {
            // The other half of the same rule. This arm stays live for the whole
            // Session, so a Session that answered and then idled out must not be
            // reported as one whose message never went. Nothing is queued here.
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: armedLocalId });
            try {
                expect(pendingActivationLine(screen)).toBeNull();
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('offers no retry at all for an outcome nothing has established', async () => {
            const screen = await sendArmedAndReadBanner({ type: 'outcome_unknown', localId: armedLocalId });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.getTextContent())
                    .toContain('session.agentContinuation.transition.unknown');
                // A blind retry against an effect that may already have happened
                // is the one action this state must never expose.
                expect(screen.findAllByTestId('session.agentTransitionOutcome.resume')).toHaveLength(0);
                // Reconciliation reads canonical Session/message truth through the
                // owners that already publish it — no status operation of its own.
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ forceRefresh: true }));
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        /**
         * A text send through the armed destination, so the composer's persisted
         * draft can restore after a remount, but its retained arm blocks dispatch
         * until canonical reconciliation settles.
         */
        async function sendArmedText(result: unknown, text: string) {
            armSecondAgent();
            runSessionAgentTransitionSpy.mockImplementationOnce(async () => result as any);
            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', text, 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            await act(async () => {
                for (const pending of [...pendingFireAndForget]) await pending;
            });
            const [transitionDispatch] = runSessionAgentTransitionSpy.mock.calls[0] ?? [];
            expect((transitionDispatch as any)?.request?.input).toEqual({
                text,
                localId: armedLocalId,
                meta: { [COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1]: { kind: 'session', sessionId: 's1' }, permissionMode: 'default' },
            });
            return screen;
        }

        it('reconciles a retained submission after its old arm is no longer a next-message promise', async () => {
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation', {
                backendTargetKey: 'agent:happier.agent.claude/claude',
                // The Session now runs Codex, so this older OpenCode choice is
                // no longer armable. Its submitted custody must still reconcile.
                intent: { v: 1, mode: 'same_session', sourceAgentId: 'opencode', selection: { v: 1, agentId: 'claude' } },
                submission: {
                    localId: 'retained-submission-id',
                    input: {
                        localId: 'retained-submission-id',
                        text: 'switch and send this',
                        meta: {},
                    },
                    currentness: {
                        text: 'switch and send this',
                        mentions: [],
                        composerAttachments: [],
                        attachmentDraftIds: [],
                    },
                },
            });
            let settleCanonicalRefresh: () => void = () => {};
            const canonicalRefresh = new Promise<void>((resolve) => {
                settleCanonicalRefresh = resolve;
            });
            canonicalRefreshRespondAfter = canonicalRefresh;

            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            try {
                expect(screen.getTextContent()).toContain('session.agentContinuation.transition.unknown');
                const agentInput = findTestInstanceByTypeWithProps(screen.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                });

                // The old transition has no live arm to route through, but its
                // exact localId still blocks a fresh send until existing custody
                // readers establish whether it was admitted.
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith(
                    's1',
                    expect.objectContaining({ forceRefresh: true }),
                );
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');

                syncPendingRowForLocalId('retained-submission-id');
                settleCanonicalRefresh();
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                await vi.waitFor(() => expect(clearPersistedArmedContinuationSubmissionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ localId: 'retained-submission-id' }),
                ));
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')).toBeNull();
            } finally {
                settleCanonicalRefresh();
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('blocks a remounted nested submission until reconciliation reads canonical custody', async () => {
            const first = await sendArmedText(
                { type: 'outcome_unknown', localId: armedLocalId },
                'first submitted text',
            );
            try {
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')?.submission).toMatchObject({
                    localId: armedLocalId,
                    input: { text: 'first submitted text' },
                });
            } finally {
                act(() => { first.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }

            runSessionAgentTransitionSpy.mockClear();
            ensureSessionVisibleSpy.mockClear();
            refreshSessionMessagesSpy.mockClear();
            let settleCanonicalRefresh: () => void = () => {};
            const canonicalRefresh = new Promise<void>((resolve) => {
                settleCanonicalRefresh = resolve;
            });
            canonicalRefreshRespondAfter = canonicalRefresh;
            const second = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            try {
                const agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'newer local draft', 'AgentInput');
                });
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                });

                // A restored submission has no persisted daemon result to
                // replay. Until the existing one-shot refresh has read custody,
                // it is treated as the same unknown outcome and cannot dispatch
                // a second transition under the old localId.
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith(
                    's1',
                    expect.objectContaining({ forceRefresh: true }),
                );
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');

                syncPendingRowForLocalId(armedLocalId);
                settleCanonicalRefresh();
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                // Once custody has arrived, the canonical disposition spends
                // the arm rather than offering the same transition again.
                await vi.waitFor(() => expect(clearPersistedArmedContinuationSubmissionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ localId: armedLocalId }),
                ));
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')).toBeNull();
                expect(clearArmedContinuationSpy).not.toHaveBeenCalled();
            } finally {
                settleCanonicalRefresh();
                act(() => { second.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        // The narrower half: the answer that resolves an unestablished switch
        // routinely arrives after the call returned. Taking the notice down
        // while leaving the message in the composer is the same duplicate one
        // tap away.
        it('compare-clears the unchanged submitted draft when custody only lands later', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: armedLocalId },
                'switch and send this',
            );
            try {
                expect(screen.getTextContent()).toContain('session.agentContinuation.transition.unknown');
                expect(readSessionShellDraftTextForTest('s1')).toBe('switch and send this');

                syncPendingRowForLocalId(armedLocalId);

                await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('session.agentContinuation.transition.unknown'));
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(readSessionShellDraftTextForTest('s1')).toBe('');
                // The arm goes with the draft: this depth spends the switch.
                expect(clearPersistedArmedContinuationSubmissionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ localId: armedLocalId }),
                );
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')).toBeNull();
                expect(clearArmedContinuationSpy).not.toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        // A draft the reader has since rewritten is not the submitted one, and
        // taking it away would destroy work to tidy up a banner.
        it('leaves an edited draft alone when custody of the submitted one lands', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: armedLocalId },
                'switch and send this',
            );
            try {
                const agentInput = findTestInstanceByTypeWithProps(screen.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'a different message', 'AgentInput');
                });

                syncPendingRowForLocalId(armedLocalId);

                expect(readSessionShellDraftTextForTest('s1')).toBe('a different message');
                // The rewritten text is a new message, so canonical custody
                // must spend the original arm/localId without clearing it.
                await vi.waitFor(() => expect(clearPersistedArmedContinuationSubmissionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ localId: armedLocalId }),
                ));
                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')).toBeNull();
                expect(clearArmedContinuationSpy).not.toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not clear a newer same-target model choice when the previous transition reaches custody', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: armedLocalId },
                'switch and send this',
            );
            try {
                const previousLocalId = armedLocalId;
                const previousArm = readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation');
                const option = observedAgentPicker.current?.composeAgentPickerOptions([])
                    .find((candidate) => candidate.id === previousArm?.backendTargetKey);
                expect(option?.disabled).toBe(false);
                const detail = option?.renderDetailContent?.({ onRequestClose: () => {} });
                if (!React.isValidElement<{ onSelectionChange: (selection: SessionAgentPickerSelection) => void }>(detail)) {
                    throw new Error('Expected the real target-Agent detail control');
                }
                // A new model on the same Agent is a genuine new intent. The
                // canonical picker, not the fixture, derives its new localId.
                await act(async () => detail.props.onSelectionChange({
                    modelId: 'opus-5', modelSelection: null, modelLabel: 'Opus 5', sessionModeId: null, configOverrides: {},
                }));
                await vi.waitFor(() => {
                    expect(observedAgentPicker.current?.armedContinuationLocalId).toEqual(expect.any(String));
                    expect(observedAgentPicker.current?.armedContinuationLocalId).not.toBe(previousLocalId);
                });
                const newerArm = readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation');
                expect(newerArm?.backendTargetKey).toBe(previousArm?.backendTargetKey);
                expect(newerArm?.intent.selection).toMatchObject({ agentId: 'claude', modelId: 'opus-5' });
                syncPendingRowForLocalId(previousLocalId);

                expect(readSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.agentContinuation')).toEqual(newerArm);
                expect(observedAgentPicker.current?.armedContinuationLocalId).not.toBe(previousLocalId);
                expect(runSessionAgentTransitionSpy).toHaveBeenCalledTimes(1);
                expect(clearArmedContinuationSpy).not.toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('still resumes the inactive source Agent for an ordinary unarmed attachment send', async () => {
            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                pendingFireAndForget.length = 0;
                const renderedTree = tree;
                if (!renderedTree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(renderedTree);

                expect(resumeSessionSpy).toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expectSingleAcceptedPendingHandoff();
                expect(uploadSpy).toHaveBeenCalledTimes(1);
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });
    });
});
