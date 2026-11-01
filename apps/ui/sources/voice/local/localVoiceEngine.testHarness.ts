import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { waitForTestEvent } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { captureMachinePresenceObservation as observeLocalVoiceFixturePresence } from '@/sync/domains/machines/reachability/machineReachability';
import type { Socket } from 'socket.io-client';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { projectClaudeJsonlLineToDirectMessages } from '../../../../../packages/plugins/claude/src/agent/transcripts/projection';
import { SessionMessagesPageV1Schema, type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS, SESSION_RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { ExecutionRunActionRequestSchema, ExecutionRunActionResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunTurnStreamStartResponseSchema, ExecutionRunTurnStreamReadResponseSchema,
    ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunUserTranscriptCommitResponseSchema,
    ExecutionRunTurnStreamStartRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema,
    ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamCancelRequestSchema,
    ExecutionRunUserTranscriptCommitRequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VoiceLocalDirectSchema } from '@happier-dev/protocol/voice/settings/localDirect';
import { VoiceLocalConversationSchema } from '@happier-dev/protocol/voice/settings/localConversation';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import type { HappierAudioStreamNativeEventMap } from '../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { buildSessionTurnsProjectionV1, type SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { Message } from '@happier-dev/session-core/messages';
import type { StorageState } from '@/sync/store/types';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createHash } from 'node:crypto';
import { decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { DaemonVoiceSpeechTranscribeRequestSchema, DaemonVoiceSpeechTranscribeResponseSchema,
    DaemonVoiceSpeechTranscribeUploadInitRequestSchema, DaemonVoiceSpeechTranscribeUploadInitResponseSchema,
    DaemonVoiceSpeechTranscribeUploadChunkRequestSchema, DaemonVoiceSpeechTranscribeUploadChunkResponseSchema,
    DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema, DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema,
    DaemonVoiceSpeechTranscribeUploadAbortRequestSchema, DaemonVoiceSpeechTranscribeUploadAbortResponseSchema,
    type DaemonVoiceSpeechTranscribeRequest } from '@happier-dev/protocol/daemon/voiceSpeech';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const localVoiceSockets = new Set<Socket>();
const localVoiceRemoteMessages = new Map<string, SessionMessageV1[]>();
const localVoiceRemoteTurns = new Map<string, SessionTurnsProjectionV1>();
type LocalVoiceBoundaryEvent = 'agent-start' | 'stream-start' | 'speech' | 'recognizer-start'
    | 'recognizer-stop' | 'speech-stop' | 'audio-release' | 'audio-start' | 'native-frame'
    | 'pending-enqueue' | 'transcription' | 'recording-stop' | `rpc:${string}`;
const localVoiceBoundaryCounts = new Map<LocalVoiceBoundaryEvent, number>();
const localVoiceBoundaryListeners = new Set<() => void>();
function publishLocalVoiceBoundaryEvent(event: LocalVoiceBoundaryEvent) {
    localVoiceBoundaryCounts.set(event, (localVoiceBoundaryCounts.get(event) ?? 0) + 1);
    for (const listener of [...localVoiceBoundaryListeners]) listener();
}
/** Observe actual OS/HTTP/Socket callback entry without replacing queued mock replies. */
export function waitForLocalVoiceBoundaryEvent(event: LocalVoiceBoundaryEvent, count = 1): Promise<void> {
    return waitForTestEvent(notify => {
        localVoiceBoundaryListeners.add(notify);
        return () => { localVoiceBoundaryListeners.delete(notify); };
    }, () => localVoiceBoundaryCounts.get(event) ?? 0, actual => actual >= count).then(() => undefined);
}
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    localVoiceSockets.add(socket);
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
            throw new Error('Expected framed Voice RPC');
        }
        if (serverUrl !== 'https://local-voice-actions.example.test') throw new Error('Unexpected Voice Home transport');
        const token = typeof socket.auth === 'object' && 'token' in socket.auth ? socket.auth.token : undefined;
        if (!speechAccount || token !== speechAccount.credentials.token) throw new Error('Expected admitted Voice Account transport');
        const separator = raw.method.indexOf(':');
        const targetId = raw.method.slice(0, separator);
        const method = raw.method.slice(separator + 1);
        const responding = resolveSocketRpcSessionAuthorization(method)
            ? sessionRpcWithServerScope({ sessionId: targetId, serverId: localVoiceHomeId, method, payload: raw.params })
            : machineRpcWithServerScope({ machineId: targetId, serverId: localVoiceHomeId, method, payload: raw.params });
        publishLocalVoiceBoundaryEvent(`rpc:${method}`);
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) publishLocalVoiceBoundaryEvent('agent-start');
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) publishLocalVoiceBoundaryEvent('stream-start');
        const result = await responding;
        return { ok: true, result };
    });
});
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));

type LocalVoiceAccountTransport = Readonly<{ home: { id: string; serverUrl: string }; credentials: AuthCredentials; dispose(): Promise<void> }>;
let speechAccount: LocalVoiceAccountTransport | null = null;
export const localVoiceSpeechOutputBoundary: ReturnType<typeof createVoiceSpeechOutputBoundary> = createVoiceSpeechOutputBoundary({ getAccount: () => {
    if (!speechAccount) throw new Error('Expected restored Voice Account');
    return speechAccount;
} });
const initialSpeechBoundary = localVoiceSpeechOutputBoundary.reset();
localVoiceSpeechOutputBoundary.subscribeSpeech(event => publishLocalVoiceBoundaryEvent(event === 'speak' ? 'speech' : 'speech-stop'));
localVoiceSpeechOutputBoundary.subscribeFileRecording(event => publishLocalVoiceBoundaryEvent(event === 'start' ? 'audio-start' : 'recording-stop'));

export const sessionRpcWithServerScope = vi.fn<(request: Readonly<{ sessionId: string; serverId: string; method: string; payload: unknown }>) => Promise<unknown>>();
export const machineRpcWithServerScope = vi.fn();
export let localVoiceAgentRpc: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
export const localVoiceSpeechTranscription = vi.fn<(request: DaemonVoiceSpeechTranscribeRequest) => Promise<string>>();
export let localVoiceUploadedAudio = new Uint8Array();
export const createdAudioPlayers: any[] = [];
export const fileDelete = vi.fn<() => void>(() => {});
export const expoSpeechSpeak = localVoiceSpeechOutputBoundary.expoSpeechSpeak;
export const expoSpeechStop = localVoiceSpeechOutputBoundary.expoSpeechStop;
export const speechRecStart = vi.fn();
export const speechRecStop = vi.fn();
export const speechRecAbort = vi.fn();
export const speechRecRequestPermissionsAsync = vi.fn(async () => ({ granted: true }));
export const nativeMicRequestPermissionsAsync = vi.fn(async () => ({ granted: true, canAskAgain: true }));
export const webMicGetUserMedia = vi.fn<() => Promise<Pick<MediaStream, 'getTracks'>>>(async () => ({ getTracks: () => [] }));
export const audioStreamStart = vi.fn<(...args: any[]) => Promise<{ streamId: string }>>().mockResolvedValue({ streamId: 'audio-stream-1' });
export const audioStreamStop = vi.fn(async () => {});
export const audioSessionRelease = vi.fn(async () => {});
export const sherpaStreamingCreate = vi.fn(async () => {});
export const sherpaStreamingPushFrame = vi.fn<(...args: any[]) => Promise<{ text: string; isEndpoint: boolean }>>().mockResolvedValue({
  text: '',
  isEndpoint: false,
});
export const sherpaStreamingFinish = vi
  .fn<(...args: any[]) => Promise<{ status: 'finalized'; text: string } | { status: 'cancelled' } | { status: 'missing' }>>()
  .mockResolvedValue({ status: 'finalized', text: '' });
export const sherpaStreamingCancel = localVoiceSpeechOutputBoundary.nativeCancel;
export const LOCAL_VOICE_STT_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
export let localVoiceModelPackFilesystem = initialSpeechBoundary.filesystem;
export const routerNavigate = vi.fn();
export const localVoiceRouteState: { pathname: string; segments: string[]; params: Record<string, string | string[] | undefined> } = {
    pathname: '/', segments: [], params: {},
};

let nextRecorderPrepareError: Error | null = null;
let recorderUri: string | null = 'file:///tmp/rec.m4a';
let speechRecRecognitionAvailable = true;

const EXPO_SPEECH_STATE_KEY = Symbol.for('happier.vitest.expoSpeechStub.state');
const EXPO_SPEECH_REC_STATE_KEY = Symbol.for('happier.vitest.expoSpeechRecognitionStub.state');
let nativeCapture = initialSpeechBoundary.audioSession;
const nativeAudioStreamStart = nativeCapture.nativeModule.start.getMockImplementation();
Object.assign(localVoiceSpeechOutputBoundary.native, {
    createStreamingRecognizer: sherpaStreamingCreate,
    pushAudioFrame: (...args: Parameters<typeof sherpaStreamingPushFrame>) => {
        const response = sherpaStreamingPushFrame(...args);
        publishLocalVoiceBoundaryEvent('native-frame');
        return response;
    },
    finishStreaming: sherpaStreamingFinish,
});

function setExpoSpeechStubState(next: { speakImpl: ((text: string, options?: any) => void) | null; stopImpl: (() => void) | null }) {
    (globalThis as any)[EXPO_SPEECH_STATE_KEY] = next;
}

function setExpoSpeechRecognitionStubState(next: {
    recognitionAvailable: boolean;
    listeners: Map<string, Set<(event: any) => void>>;
    startImpl: ((params: any) => void) | null;
    stopImpl: (() => void) | null;
    abortImpl: (() => void) | null;
    requestPermissionsImpl: (() => Promise<{ granted: boolean }>) | null;
}) {
    (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY] = next;
}

export function setSpeechRecRecognitionAvailable(next: boolean) {
    speechRecRecognitionAvailable = next;
    const state = (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY];
    if (state && typeof state === 'object') {
        state.recognitionAvailable = next;
    }
}

export function setSherpaNativeModuleAvailable(next: boolean) {
    localVoiceSpeechOutputBoundary.setNativeAvailable(next);
}

export function emitSpeechRecEvent(eventName: string, event: any = {}) {
    const state = (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY];
    const set: Set<(event: any) => void> | undefined = state?.listeners?.get?.(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export function emitAudioStreamEvent<Name extends keyof HappierAudioStreamNativeEventMap>(eventName: Name, event: HappierAudioStreamNativeEventMap[Name]) {
    nativeCapture.emitEvent(eventName, event);
}

const baseVoice = voiceSettingsParse({ providerId: 'local_conversation', welcome: { enabled: false } });
export const BASE_SETTINGS = {
    experiments: true,
    featureToggles: { voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true },
    lastUsedAgent: 'codex',
    recentMachinePaths: [{ machineId: 'machine-1', path: '/Users/test/.happier' }],
    voice: {
        ...baseVoice,
        providers: {
            ...baseVoice.providers,
            local_direct: { schemaVersion: 1, config: VoiceLocalDirectSchema.parse({
                stt: { provider: 'happier.voice.openai-compat/stt' },
                tts: { provider: 'happier.voice.openai-compat/tts', autoSpeakReplies: false },
            }) },
            local_conversation: { schemaVersion: 1, config: VoiceLocalConversationSchema.parse({
                conversationMode: 'direct_session',
                stt: { provider: 'happier.voice.openai-compat/stt' },
                tts: { provider: 'happier.voice.openai-compat/tts', autoSpeakReplies: false },
                agent: { agentSource: 'session', agentId: 'claude', idleTtlSeconds: 300 },
                streaming: { enabled: false, ttsEnabled: false },
            }) },
            'happier.voice.openai-compat/stt': { schemaVersion: 2, config: {
                baseUrl: 'http://localhost:8000',
                insecureLocalOriginConsent: 'http://localhost:8000',
                insecureLocalConsentMachineId: 'machine-1',
                model: 'whisper-1',
                language: '',
            } },
            'happier.voice.openai-compat/tts': { schemaVersion: 2, config: {
                baseUrl: 'http://localhost:8001',
                insecureLocalOriginConsent: 'http://localhost:8001',
                insecureLocalConsentMachineId: 'machine-1',
                model: 'tts-1',
                voiceName: 'alloy',
                format: 'mp3',
            } },
        },
    },
} as const;

export function setPlatformOs(next: 'ios' | 'web') {
    localVoiceSpeechOutputBoundary.platform.value = next;
}

export function setNextRecorderPrepareError(next: Error | null) {
    nextRecorderPrepareError = next;
    if (next) localVoiceSpeechOutputBoundary.fileRecording.start.mockRejectedValueOnce(next);
}

export function setRecorderUri(next: string | null) {
    recorderUri = next;
    localVoiceSpeechOutputBoundary.setRecorderUri(next);
}

export async function getStorage() {
    const { storage } = await import('@/sync/domains/state/storage');
    // Legacy engine fixtures are completed by the package testkit, then written
    // to the real store. The facade does not replace any production reader.
    return Object.assign({}, storage, {
        __setState: (patch: Record<string, unknown>) => {
            const normalized = { ...patch };
            const settings = patch.settings;
            if (settings && typeof settings === 'object' && !Array.isArray(settings) && 'voice' in settings) {
                const current = storage.getState().settings;
                // These legacy fixture calls represent a current local settings
                // write, not a predecessor whole-object Account write. Keep both
                // roots aligned through the production writer, including explicit
                // canonical-root replacements and retained credential bindings.
                const voiceDelta = 'voiceSettingsV1' in settings && settings.voiceSettingsV1 !== current.voiceSettingsV1
                    ? { voice: settings.voice, voiceSettingsV1: settings.voiceSettingsV1 }
                    : { voice: settings.voice };
                const normalizedSettings = { ...settings, ...normalizeVoiceSettingsLocalDelta(voiceDelta, current) };
                normalized.settings = normalizedSettings;
                const version = typeof patch.settingsVersion === 'number' ? patch.settingsVersion : (storage.getState().settingsVersion ?? 0) + 1;
                normalized.settingsVersion = version;
                // Binding activates this Account's persisted projection. Seed
                // the same served document through its real projection writer.
                storage.getState().applySettings(settingsParse(normalizedSettings), version);
                // The HTTP owner stores a serialized envelope, not this client
                // object. Publish authored fixture settings through its public
                // replacement port with the new document's version, so retained
                // Account readers cannot reuse the preceding fixture document.
                activeAccountHomes?.replaceAccountSettings('voice', {
                    settings: normalizedSettings,
                    version,
                });
            }
            if (patch.sessions && typeof patch.sessions === 'object') {
                normalized.sessions = Object.fromEntries(Object.entries(patch.sessions).map(([id, raw]) => {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [id, raw];
                    // The stock Home row below publishes an empty durable
                    // queue; sparse client fixtures must retain that same fact.
                    const session = createSessionFixture({ pendingVersion: 0, pendingCount: 0, ...raw });
                    const metadata = { host: 'test', machineId: 'machine-1', path: `/Users/test/.happier/worktree/${id}`,
                        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
                        ...(session.metadataLayoutVersion === 1 ? session.ownerMetadataView : session.metadata),
                    };
                    return [id, createSessionFixture({ ...session, id, serverId: session.serverId ?? localVoiceHomeId,
                        ...(session.metadataLayoutVersion === 1 ? { ownerMetadataView: metadata } : { metadata }),
                    })];
                }));
            }
            if (patch.machines && typeof patch.machines === 'object') {
                normalized.machines = Object.fromEntries(Object.entries(patch.machines).map(([id, raw]) => [id,
                    createMachineFixture(raw && typeof raw === 'object' ? { ...raw, id } : { id })]));
            }
            if (patch.sessionMessages && typeof patch.sessionMessages === 'object') {
                normalized.sessionMessages = Object.fromEntries(Object.entries(patch.sessionMessages).map(([sessionId, raw]) => {
                    if (!raw || typeof raw !== 'object' || !('messages' in raw) || !Array.isArray(raw.messages)) return [sessionId, raw];
                    // Legacy test inputs seed known transcript records; canonical fixtures complete their collection, not store actions.
                    const messages = raw.messages as Message[];
                    const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
                    return [sessionId, createSessionMessagesFixture({ messagesById, messagesMap: messagesById,
                        messageIdsOldestFirst: messages.map(message => message.id), isLoaded: true })];
                }));
            }
            // This facade accepts legacy sparse test seeds; every domain record above comes from its canonical fixture.
            storage.setState(normalized as Partial<StorageState>);
            if (normalized.machines) {
                const rows = Object.values(storage.getState().machines);
                storage.getState().applyMachines(rows, true, { sourceServerId: localVoiceHomeId });
                // These authored Machine fixtures represent a current presence
                // observation, not rows retained across the prior test's teardown.
                const scope = storage.getState().profileScope;
                if (scope) observeLocalVoiceFixturePresence(scope)(rows.map(row => row.id));
            }
            if (normalized.sessions) storage.getState().applySessions(Object.values(storage.getState().sessions));
        },
        __notify: () => storage.setState({}),
    });
}

/** Read actual admission inputs before/after a test attempt; this changes no policy or presence. */
export async function readLocalVoiceMachinePrerequisites() {
    const [{ storage }, { getAppliedActiveServerSnapshot },
        { resolveVoiceExecutionMachineSelectionFromState }, { resolveVisibleMachinesForActiveServerFromState },
        { readMachineRequestReachabilityObservation },
        { peekServerReachabilityState, isServerReachabilityNetworkAllowed }] = await Promise.all([
        import('@/sync/domains/state/storage'),
        import('@/sync/runtime/orchestration/appliedActiveServerRuntime'),
        import('@/voice/settings/executionMachine'),
        import('@/sync/store/domains/machines/resolveMachinesForActiveServerFromState'),
        import('@/sync/domains/machines/reachability/machineReachability'),
        import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool'),
    ]);
    const state = storage.getState();
    const appliedHomeId = getAppliedActiveServerSnapshot().serverId;
    const reachability = speechAccount
        ? peekServerReachabilityState(speechAccount.home.serverUrl, speechAccount.credentials.token) : null;
    return {
        observedAtMs: Date.now(), appliedHomeId, profileScope: state.profileScope, settingsScope: state.settingsScope,
        selection: resolveVoiceExecutionMachineSelectionFromState(state),
        inventoryStatus: state.machineListStatusByServerId[appliedHomeId],
        serverReachability: {
            networkAllowed: isServerReachabilityNetworkAllowed(),
            phase: reachability?.phase ?? null, reason: reachability?.reason ?? null,
            lastErrorMessage: reachability?.lastErrorMessage ?? null,
        },
        socketObservations: [...localVoiceSockets].map(socket => ({
            connected: socket.connected,
            authMatchesCurrentAccount: speechAccount !== null
                && typeof socket.auth === 'object' && socket.auth !== null
                && socket.auth.token === speechAccount.credentials.token,
            updateListenerCount: socket.listeners('update').length,
            onAnyListenerCount: socket.listenersAny().length,
        })),
        machines: resolveVisibleMachinesForActiveServerFromState(state, { serverId: appliedHomeId }).map(machine => ({
            id: machine.id, active: machine.active, activeAt: machine.activeAt, revokedAt: machine.revokedAt,
            availability: machine.availability,
            requestObservation: readMachineRequestReachabilityObservation(state.profileScope, machine.id),
        })),
    };
}

async function createVoiceConversationSessionFixture(raw: unknown) {
    const args = SessionSpawnNewInputV2Schema.parse(raw);
    const { machineId, serverId } = args.executionTarget;
    if (args.directory.kind !== 'path') throw new Error('Expected Voice conversation path');
    const directory = args.directory.path;
    const spawnedAgentId = readBackendTargetRefV2(args.agentTarget).backendId;
    const sessionId = 'voice-home-session';
    const storage = await getStorage();
    const current = storage.getState();
        const existing = current.sessions?.[sessionId];
        storage.__setState({
            ...current,
            sessions: {
                ...(current.sessions ?? {}),
                [sessionId]: existing ?? {
                    id: sessionId,
                    serverId,
                    active: true,
                    updatedAt: Date.now(),
                    metadata: {
                        ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
                        flavor: spawnedAgentId,
                        permissionMode: args.permissionMode,
                        ...(args.connectedServices ? { connectedServices: args.connectedServices } : {}),
                        agentRuntimeCapabilitiesV1: {
                            localControl: { supported: true },
                        },
                        machineId,
                        path: directory,
                        host: 'test',
                    },
                },
            },
        });
    return SessionSpawnNewResultV1Schema.parse({
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId,
        executionTarget: {
            serverId,
            machineId,
        },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
    });
}

export async function flushMicrotasks(turns: number = 1) {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
    }
}

export type LocalVoiceEngineCompatState = Readonly<{
    status: string;
    sessionId: string | null;
    error: string | null;
}>;

export async function waitForLocalVoiceState(predicate: (state: LocalVoiceEngineCompatState) => boolean) {
    const [{ useVoiceConversationRuntimeStore, getVoiceConversationRuntimeSnapshot }, { deriveLocalVoiceRuntimeProjection }] = await Promise.all([
        import('@/voice/runtime/machine/voiceConversationRuntimeStore'),
        import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot'),
    ]);
    return waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => {
        const snapshot = getVoiceConversationRuntimeSnapshot();
        return { status: deriveLocalVoiceRuntimeProjection(snapshot).compatStatus,
            sessionId: snapshot.controlSessionId, error: snapshot.error?.reason ?? null };
    }, predicate);
}

export async function loadLocalVoiceEngineWithCompatState(): Promise<
    typeof import('./localVoiceEngine') & Readonly<{ getLocalVoiceState: () => LocalVoiceEngineCompatState }>
> {
    const localVoiceEngine = await import('./localVoiceEngine');
    // Mirror VoiceSessionRuntime startup with the real local-conversation
    // adapter. Import the engine first so per-test boundary overrides can still
    // be installed before this helper assembles the production adapter.
    const [{ createLocalConversationVoiceAdapter }, { registerVoiceAdapters }] = await Promise.all([
        import('@/voice/adapters/localConversation/localConversationAdapter'),
        import('@/voice/session/voiceAdapterRegistry'),
    ]);
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const { deriveLocalVoiceRuntimeProjection } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');

    return {
        ...localVoiceEngine,
        getLocalVoiceState: () => {
            const snapshot = getVoiceConversationRuntimeSnapshot();
            const projection = deriveLocalVoiceRuntimeProjection(snapshot);
            return {
                status: projection.compatStatus,
                sessionId: snapshot.controlSessionId,
                error: snapshot.error?.reason ?? null,
            };
        },
    };
}

/** Prime the real graph outside individual assertion budgets. */
export async function warmLocalVoiceEngineHarnessGraph() {
    await installLocalVoiceAccountHarness();
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restore = await installRealActionExecutorModuleLoader();
    await loadLocalVoiceEngineWithCompatState();
    return restore;
}

export let localVoiceHomeId = '';
export const localVoicePendingEnqueue = vi.fn<(request: Readonly<{ sessionId: string; body: Record<string, unknown> }>) => Promise<Response>>();
/** Publish a server message through the actual Socket SDK listeners and HTTP page, never a rendered store row. */
export async function publishLocalVoiceAssistantMessage(input: Readonly<{
    sessionId: string; id: string; text: string;
    localId?: string;
    meta?: Readonly<Record<string, unknown>>;
}>) {
    const createdAt = Date.now();
    const [projected] = projectClaudeJsonlLineToDirectMessages({
        fileRelPath: 'session.jsonl', lineStartOffsetBytes: 0,
        lineValue: { type: 'assistant', uuid: input.id, timestamp: createdAt,
            message: { role: 'assistant', content: [{ type: 'text', text: input.text }] } },
    });
    if (!projected || projected.messageRole !== 'agent') throw new Error('Expected published Claude assistant transcript');
    await publishLocalVoiceTranscriptMessage({ ...input, localId: input.localId ?? null, messageRole: 'agent',
        content: { t: 'plain', v: { ...projected.raw, ...(input.meta ? { meta: input.meta } : {}) } } });
}

/** Model the server's committed user row before the Agent's reply, using the actual admitted payload. */
export async function publishLocalVoiceSubmittedUserMessage(request: Parameters<typeof localVoicePendingEnqueue>[0]) {
    if (typeof request.body.localId !== 'string' || !request.body.localId) throw new Error('Expected admitted Voice input identity');
    await publishLocalVoiceTranscriptMessage({ sessionId: request.sessionId, id: `user-${request.body.localId}`,
        localId: request.body.localId, messageRole: 'user', content: request.body.content });
}

export async function publishLocalVoiceTranscriptMessage(input: Readonly<{
    sessionId: string; id: string; localId: string | null; messageRole: 'user' | 'agent'; content: unknown;
}>) {
    if (!speechAccount) throw new Error('Expected admitted Voice Account transcript transport');
    const remoteKey = JSON.stringify([speechAccount.credentials.token, input.sessionId]);
    const messages = localVoiceRemoteMessages.get(remoteKey) ?? [];
    const seq = (messages.at(-1)?.seq ?? 0) + 1;
    const createdAt = Date.now();
    const update = UpdateContainerSchema.parse({
        id: `update-${input.id}`, seq, createdAt,
        body: { t: 'new-message', delivery: 'full', sid: input.sessionId, message: {
            id: input.id, seq, localId: input.localId, messageRole: input.messageRole, createdAt, updatedAt: createdAt,
            content: input.content,
        } },
    });
    if (update.body.t !== 'new-message' || update.body.delivery !== 'full') {
        throw new Error('Expected incoming full Voice transcript message');
    }
    localVoiceRemoteMessages.set(remoteKey, [...messages, update.body.message]);
    await publishLocalVoiceSocketUpdate(update);
    if (input.messageRole === 'agent') {
        const user = messages.findLast(message => message.messageRole === 'user');
        // Tests may also seed retained history before submitting any input.
        if (!user) return update.body.message;
        const turnId = `turn-${user.id}`;
        const previous = localVoiceRemoteTurns.get(remoteKey);
        localVoiceRemoteTurns.set(remoteKey, buildSessionTurnsProjectionV1({ sessionId: input.sessionId,
            updatedAt: createdAt, latestTurnId: turnId, turns: [
                ...(previous?.turns.filter(turn => turn.turnId !== turnId) ?? []),
                { turnId, status: 'completed', startedAt: user.createdAt, updatedAt: createdAt, terminalAt: createdAt,
                    transcriptAnchors: { startUserMessageSeq: user.seq, finalAssistantMessageSeq: seq } },
            ] }));
        await publishLocalVoiceSocketUpdate(UpdateContainerSchema.parse({ id: `terminal-${input.id}`, seq: seq + 1, createdAt,
            body: { t: 'update-session', id: input.sessionId, latestTurnId: turnId,
                latestTurnStatus: 'completed', latestTurnStatusObservedAt: createdAt } }));
    }
    return update.body.message;
}

async function publishLocalVoiceSocketUpdate(update: ReturnType<typeof UpdateContainerSchema.parse>) {
    let delivered = false;
    for (const socket of localVoiceSockets) {
        const auth = socket.auth;
        if (!socket.connected || !speechAccount || typeof auth !== 'object' || auth.token !== speechAccount.credentials.token) continue;
        // Socket.IO delivers incoming events to catch-all listeners before
        // direct listeners; the real Account dispatcher subscribes via onAny.
        for (const listener of socket.listenersAny().slice()) {
            delivered = true;
            await listener.call(socket, 'update', update);
        }
        for (const listener of socket.listeners('update').slice()) {
            delivered = true;
            await listener.call(socket, update);
        }
    }
    if (!delivered) throw new Error('Expected connected Voice Account Socket update consumer');
}
/** Observe the genuine metadata HTTP reply without exposing request content or replacing its codec. */
export const localVoiceMetadataHttpObserver = vi.fn<(observation: Readonly<{
    method: string; path: string; status?: number; error?: unknown;
}>) => void>();
export function acknowledgeLocalVoicePendingEnqueue({ body }: Parameters<typeof localVoicePendingEnqueue>[0]) {
    return Response.json({ requestedAction: body.requestedAction,
        pending: { localId: body.localId, deliveryStatus: {
            status: body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued',
        } } });
}

/** Load real Account/store owners before any native Agent consumes them. */
let accountHarness: Promise<Awaited<ReturnType<typeof createLocalVoiceAccountHarness>>> | undefined;
let activeAccountHomes: Awaited<ReturnType<typeof import('@/dev/testkit/harness/actionHomesHttpHarness')['serveAccountHomes']>> | null = null;
type LocalVoiceHttpResponder = Parameters<typeof import('@/dev/testkit/harness/actionHomesHttpHarness')['serveAccountHomes']>[0]['route'];
let localVoiceHttpResponder: LocalVoiceHttpResponder | null = null;
export function setLocalVoiceHttpResponder(responder: LocalVoiceHttpResponder | null) {
    localVoiceHttpResponder = responder;
}
export function readLocalVoiceHttpRequests(): readonly ServedHomeRequest[] {
    return activeAccountHomes?.requests ?? [];
}
let activeSessionMetadataHttp: ReturnType<typeof createSessionMetadataHttpBoundary> | null = null;
/** A case replacing persisted HTTP seed data must explicitly retire the boundary's prior record. */
export function replaceLocalVoiceSessionHttpSeed(sessionId: string, record?: Parameters<NonNullable<typeof activeSessionMetadataHttp>['replaceSession']>[1]) {
    if (!activeSessionMetadataHttp) throw new Error('Expected active Voice metadata HTTP boundary');
    activeSessionMetadataHttp.replaceSession(sessionId, record);
}
export async function switchLocalVoiceAccount(accountId: string) {
    if (!activeAccountHomes || !speechAccount) throw new Error('Expected active Voice Home');
    await activeAccountHomes.switchAccount('voice', accountId);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(speechAccount.home.serverUrl);
    if (!credentials) throw new Error('Expected switched Voice Account credentials');
    speechAccount = { ...speechAccount, credentials };
    await activeAccountHomes.restoreActiveConnection();
}
export function installLocalVoiceAccountHarness() {
    accountHarness ??= createLocalVoiceAccountHarness();
    return accountHarness;
}
async function createLocalVoiceAccountHarness() {
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
    localVoiceHomeId = (await upsertServerProfileOnly({ serverUrl: 'https://local-voice-actions.example.test' })).id;
    let connection: LocalVoiceAccountTransport | null = null;
    const { storage } = await import('@/sync/domains/state/storage');
    let metadataHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    return {
        async setup(serverIdentityId = 'srv_local_voice_actions') {
            await connection?.dispose();
            metadataHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
            const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
            const purposes = createConnectedPurposeCatalogHttpBoundary();
            const accountKv = createAccountKvHttpFixture();
            let artifactRequestAccountId: string | null = null;
            const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => artifactRequestAccountId, encryptionMode: 'plain' });
            activeSessionMetadataHttp = metadataHttp;
            const accountSettings = normalizeVoiceSettingsLocalDelta(BASE_SETTINGS);
            const { serveAccountHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
            const { profileDefaults } = await import('@/sync/domains/profiles/profile');
            const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
            const homes = await serveAccountHomes({
                homes: [{ key: 'voice', serverUrl: 'https://local-voice-actions.example.test', serverIdentityId, accountId: 'account-a',
                    currentAccount: true, settings: accountSettings }],
                route: createSessionReadBatchHttpBoundary(async request => {
                    if (localVoiceHttpResponder) {
                        const overridden = await localVoiceHttpResponder(request);
                        if (overridden !== undefined) return overridden;
                    }
                    const { path } = request;
                    if (path === managedMachineActionEndpointPathV1('machines.managed.list')) {
                        return Response.json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }));
                    }
                    const input = request.url;
                    const init = { method: request.method, headers: request.headers, signal: request.signal,
                        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
                    if (path === '/v1/account/profile') return request.accountId
                        ? Response.json({ ...profileDefaults, id: request.accountId })
                        : Response.json({}, { status: 401 });
                    if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/')) {
                        // The boundary captures this authenticated Account synchronously at admission.
                        artifactRequestAccountId = request.accountId;
                        const response = artifacts.handle(`${path}${request.url.search}`, init);
                        if (response) return response;
                    }
                    const authoringMemoryResponse = await authoringMemoryHttp.handle(input, init);
                    if (authoringMemoryResponse) return authoringMemoryResponse;
                    const purposeResponse = await purposes.handle(input, init);
                    if (purposeResponse) return purposeResponse;
                    const accountKvResponse = await accountKv.handleFetch(input, init);
                    if (accountKvResponse) return accountKvResponse;
                    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(ProjectAccountRowListResponseV1Schema.parse({
                        status: 'listed', rows: [], coverage: 'complete',
                    }));
                    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
                        features: { voice: { enabled: true }, execution: { runs: { enabled: true } },
                            machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } } },
                        capabilities: { machines: { liveStream: { serverRouted: { caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null } } },
                            session: { pendingInput: { protocolVersion: 1 } } },
                    }));
                    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                        content: { t: 'plain', v: { v: 1, definitions: [] } } });
                    const turnsPage = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
                    if (turnsPage) {
                        const turns = localVoiceRemoteTurns.get(JSON.stringify([
                            request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
                            decodeURIComponent(turnsPage[1]),
                        ]));
                        if (turns) return Response.json(turns);
                    }
                    try {
                        const metadataResponse = metadataHttp.handle(input, init);
                        if (metadataResponse) {
                            localVoiceMetadataHttpObserver({ method: request.method, path, status: metadataResponse.status });
                            return metadataResponse;
                        }
                    } catch (error) {
                        localVoiceMetadataHttpObserver({ method: request.method, path, error });
                        throw error;
                    }
                    const storage = await getStorage();
                    const state = storage.getState();
                    const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
                    if (machineAccess) {
                        const custodian = { accountId: 'account-a', displayName: 'Test Account' };
                        return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
                            machineId: decodeURIComponent(machineAccess[1]), custodian,
                            access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                        }));
                    }
                    const machineRows = Object.values(state.machines).map(value => {
                        const machine = createMachineFixture(value);
                        return { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
                            seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
                            active: machine.active, activeAt: machine.activeAt, metadataVersion: machine.metadataVersion,
                            daemonStateVersion: machine.daemonStateVersion,
                            revokedAt: machine.revokedAt ?? null, replacedByMachineId: machine.replacedByMachineId ?? null,
                            ...(machine.installationId ? { installationId: machine.installationId } : {}),
                            ...(machine.operationProtocolCapabilities ? { operationProtocolCapabilities: machine.operationProtocolCapabilities,
                                operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision } : {}),
                            metadata: machine.metadata ? encodePlainMachineStoredContent(machine.metadata) : null,
                            daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
                    });
                    if (path === '/v1/machines') return Response.json(machineRows);
                    if (path === '/v1/machines/read-batch' && request.method === 'POST') {
                        return createMachineReadBatchResponseFixture(request.body,
                            id => machineRows.find(machine => machine.id === id) ?? null);
                    }
                    const machineDetail = /^\/v1\/machines\/([^/]+)$/.exec(path);
                    if (machineDetail) {
                        const machine = machineRows.find(row => row.id === decodeURIComponent(machineDetail[1]));
                        return machine ? Response.json({ machine }) : Response.json({}, { status: 404 });
                    }
                    const pending = /^\/v2\/sessions\/([^/]+)\/pending$/.exec(path);
                    if (pending && init?.method === 'POST') {
                        const response = localVoicePendingEnqueue({ sessionId: decodeURIComponent(pending[1]), body: JSON.parse(String(init.body)) });
                        publishLocalVoiceBoundaryEvent('pending-enqueue');
                        return response;
                    }
                    if (pending) return Response.json({ pending: [], discarded: [], pendingVersion: 0 });
                    // Durable streamed turns settle or block their claimed input;
                    // both HTTP mutations acknowledge before the pending reread.
                    if (/^\/v2\/sessions\/[^/]+\/pending\/[^/]+\/delivery\/(handled|block)$/.test(path) && init?.method === 'POST') return Response.json({});
                    const messagesPage = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
                    if (messagesPage) return Response.json(SessionMessagesPageV1Schema.parse({
                        messages: localVoiceRemoteMessages.get(JSON.stringify([
                            request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
                            decodeURIComponent(messagesPage[1]),
                        ])) ?? [], hasMore: false,
                    }));
                    // The rest of the bootstrap census reads this Home as an empty Account; an unanswered read would
                    // retry with backoff and hold resume until its sync wait budget expires.
                    return createEmptyAccountBootstrapHttpResponse(`${path}${request.url.search}`, init) ?? undefined;
                }).handle,
            });
            const disconnect = await homes.restoreActiveConnection();
            activeAccountHomes = homes;
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = await TokenStorage.getCredentialsForServerUrl(homes.homes.voice!.serverUrl);
            if (!credentials) throw new Error('Expected served Voice Account credentials');
            connection = { home: homes.homes.voice!, credentials, dispose: async () => {
                await disconnect(); await homes.dispose();
            } };
            speechAccount = connection;
            localVoiceHomeId = connection.home.id;
            // Login readiness can return before its background bootstrap
            // settles. Join the public refresh owner before a case seeds
            // newer raw fixture settings; otherwise that older read wins.
            const { sync } = await import('@/sync/sync');
            await sync.resumeSync('manual');
            const voiceStorage = await getStorage();
            const state = voiceStorage.getState();
            voiceStorage.__setState({
                settings: { ...state.settings, ...BASE_SETTINGS,
                    featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true } },
                machineListByServerId: { [localVoiceHomeId]: Object.values(state.machines) },
            });
        },
        async dispose() { await connection?.dispose(); connection = null; speechAccount = null; activeAccountHomes = null; activeSessionMetadataHttp = null; },
    };
}

/** Real named Home/Account and Action owners; only credentials and HTTP are replaced. */
export async function installLocalVoiceActionHomeForTests() {
    vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage');
    const account = await installLocalVoiceAccountHarness();
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restoreLoader = await installRealActionExecutorModuleLoader();
    return {
        homes: { voice: { id: localVoiceHomeId } },
        restore: () => account.setup(),
        dispose: async () => { await account.dispose(); restoreLoader(); },
    };
}


vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        pathname: () => localVoiceRouteState.pathname,
        segments: () => localVoiceRouteState.segments,
        params: () => localVoiceRouteState.params,
        router: { navigate: (...args: any[]) => routerNavigate(...args) },
    });
    return expoRouterMock.module;
});



vi.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    AudioModule: {
        setAudioModeAsync: vi.fn(async () => {}),
        requestRecordingPermissionsAsync: () => nativeMicRequestPermissionsAsync(),
        getRecordingPermissionsAsync: () => nativeMicRequestPermissionsAsync(),
        AudioRecorder: class {
            get uri(): string | null {
                return recorderUri;
            }
            async prepareToRecordAsync() {
                if (nextRecorderPrepareError) {
                    const error = nextRecorderPrepareError;
                    nextRecorderPrepareError = null;
                    throw error;
                }
            }
            record() { }
            async stop() { }
        },
    },
    createAudioPlayer: (source?: any) => {
        const listeners = new Map<string, (arg: any) => void>();
        const player = {
            source,
            addListener: (event: string, cb: (arg: any) => void) => {
                listeners.set(event, cb);
                return { remove: () => listeners.delete(event) };
            },
            play: () => { },
            remove: () => { },
            __emit: (event: string, arg: any) => listeners.get(event)?.(arg),
            __hasListener: (event: string) => listeners.has(event),
        };
        createdAudioPlayers.push(player);
        return player;
    },
}));

export function registerLocalVoiceEngineHarnessHooks(options?: Readonly<{
    serverIdentityId?: string;
}>) {
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = (globalThis as any)?.URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as any)?.URL?.revokeObjectURL;
    const originalAudioCtor = (globalThis as any)?.Audio;
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = globalThis.navigator;
    const originalMediaDevicesDescriptor = originalNavigator
        ? Object.getOwnPropertyDescriptor(originalNavigator, 'mediaDevices') : undefined;

    beforeEach(async () => {
        localVoiceHttpResponder = null;
        localVoiceRemoteMessages.clear();
        localVoiceRemoteTurns.clear();
        localVoiceMetadataHttpObserver.mockReset();
        localVoiceRouteState.pathname = '/';
        localVoiceRouteState.segments = [];
        localVoiceRouteState.params = {};
        vi.doUnmock('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.doUnmock('@/voice/input/DeviceSttController');
        vi.doUnmock('@/voice/input/SherpaStreamingSttController');
        vi.doUnmock('@/voice/runtime/mic/NativeMicSession');
        localVoicePendingEnqueue.mockReset();
        localVoicePendingEnqueue.mockImplementation(async request => acknowledgeLocalVoicePendingEnqueue(request));
        sessionRpcWithServerScope.mockReset();
        localVoiceAgentRpc = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: async (method, raw) => {
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
                (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
                    ? ExecutionRunTurnStreamStartV2RequestSchema : ExecutionRunTurnStreamStartRequestSchema).parse(raw);
                return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'stream-1' });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
                ExecutionRunTurnStreamReadRequestSchema.parse(raw);
                return ExecutionRunTurnStreamReadResponseSchema.parse({
                streamId: 'stream-1', events: [{ t: 'delta', textDelta: 'Daemon ' }, { t: 'done', assistantText: 'Daemon reply' }], nextCursor: 2, done: true,
                });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
                ExecutionRunTurnStreamCancelRequestSchema.parse(raw);
                return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1) {
                ExecutionRunUserTranscriptCommitRequestSchema.parse(raw);
                return ExecutionRunUserTranscriptCommitResponseSchema.parse({ ok: true });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
                const input = ExecutionRunActionRequestSchema.parse(raw);
                return ExecutionRunActionResponseSchema.parse({ ok: true, result: input.actionId === 'voice_agent.welcome'
                    ? { assistantText: 'Welcome!' } : { commitText: 'Daemon commit' } });
            }
            throw new Error(`Unexpected Voice Session RPC: ${method}`);
        } });
        sessionRpcWithServerScope.mockImplementation(request => localVoiceAgentRpc.dispatch(request.method, request.payload));
        machineRpcWithServerScope.mockReset();
        localVoiceSpeechOutputBoundary.platform.value = 'ios';
        createdAudioPlayers.length = 0;
        nextRecorderPrepareError = null;
        recorderUri = 'file:///tmp/rec.m4a';
        fileDelete.mockReset();
        fileDelete.mockImplementation(() => {});
        const speechBoundary = localVoiceSpeechOutputBoundary.reset();
        localVoiceSpeechOutputBoundary.setRecorderUri(recorderUri);
        localVoiceModelPackFilesystem = speechBoundary.filesystem;
        // Observe the canonical external filesystem class rather than install
        // a second Expo module factory whose import order can hide deletions.
        const filePrototype = localVoiceModelPackFilesystem.fs.File.prototype as {
            uri: string; delete(): void;
        };
        const deleteFile = filePrototype.delete;
        vi.spyOn(filePrototype, 'delete').mockImplementation(function (this: typeof filePrototype) {
            if (this.uri !== recorderUri && this.uri !== 'file:///tmp/rec.m4a') return deleteFile.call(this);
            fileDelete();
            return deleteFile.call(this);
        });
        nativeCapture = speechBoundary.audioSession;
        const packManifest = parseModelPackManifest({
            packId: LOCAL_VOICE_STT_PACK_ID, kind: 'stt_sherpa', model: 'zipformer', version: '1.0.0',
            files: [{ path: 'tokens.txt', url: 'https://models.example.test/tokens.txt', sha256: 'a'.repeat(64), sizeBytes: 1 }],
        });
        localVoiceModelPackFilesystem.files.set(`${localVoiceModelPackFilesystem.root}/${LOCAL_VOICE_STT_PACK_ID}/pack.json`,
            new TextEncoder().encode(JSON.stringify(packManifest)));
        localVoiceModelPackFilesystem.files.set('file:///tmp/rec.m4a', new Uint8Array([1, 2, 3]));
        speechRecStart.mockReset();
        localVoiceBoundaryCounts.clear();
        localVoiceBoundaryListeners.clear();
        speechRecStop.mockReset();
        speechRecAbort.mockReset();
        speechRecRequestPermissionsAsync.mockReset();
        nativeMicRequestPermissionsAsync.mockReset();
        nativeMicRequestPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
        webMicGetUserMedia.mockReset();
        webMicGetUserMedia.mockResolvedValue({ getTracks: () => [] });
        // Browser media acquisition is an OS/SDK boundary; the permission owner stays real.
        if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true, value: { getUserMedia: webMicGetUserMedia },
        });
        // The web mic owner subscribes to browser visibility even when the
        // provider manages capture. Keep that OS boundary present in Node.
        if (typeof globalThis.document === 'undefined') {
            Object.defineProperty(globalThis, 'document', {
                configurable: true,
                writable: true,
                value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
            });
        }
        audioStreamStart.mockReset();
        audioStreamStop.mockReset();
        audioSessionRelease.mockReset();
        sherpaStreamingCreate.mockReset();
        sherpaStreamingPushFrame.mockReset();
        sherpaStreamingFinish.mockReset();
        sherpaStreamingCancel.mockReset();
        audioStreamStart.mockResolvedValue({ streamId: 'audio-stream-1' });
        audioStreamStop.mockResolvedValue(undefined);
        audioSessionRelease.mockResolvedValue(undefined);
        nativeCapture.nativeModule.start.mockImplementation(async params => {
            const starting = audioStreamStart(params);
            publishLocalVoiceBoundaryEvent('audio-start');
            const started = await starting;
            // Retain the canonical OS start callback's capability event. The
            // real coordinator admits AEC only after this native confirmation.
            await nativeAudioStreamStart?.(params);
            return started;
        });
        nativeCapture.nativeModule.stop.mockImplementation(() => audioStreamStop());
        nativeCapture.nativeModule.restoreAudioSession.mockImplementation(() => {
            const response = audioSessionRelease();
            publishLocalVoiceBoundaryEvent('audio-release');
            return response;
        });
        sherpaStreamingPushFrame.mockResolvedValue({ text: '', isEndpoint: false });
        sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: '' });
        sherpaStreamingCreate.mockResolvedValue(undefined);
        sherpaStreamingCancel.mockResolvedValue(undefined);
        speechRecRecognitionAvailable = true;
        setExpoSpeechStubState({
            speakImpl: (...args: any[]) => (expoSpeechSpeak as any)(...args),
            stopImpl: (...args: any[]) => (expoSpeechStop as any)(...args),
        });
        setExpoSpeechRecognitionStubState({
            recognitionAvailable: true,
            listeners: new Map(),
            startImpl: (...args: any[]) => {
                const response = (speechRecStart as any)(...args);
                publishLocalVoiceBoundaryEvent('recognizer-start');
                return response;
            },
            stopImpl: (...args: any[]) => {
                const response = (speechRecStop as any)(...args);
                publishLocalVoiceBoundaryEvent('recognizer-stop');
                return response;
            },
            abortImpl: (...args: any[]) => (speechRecAbort as any)(...args),
            requestPermissionsImpl: (...args: any[]) => (speechRecRequestPermissionsAsync as any)(...args),
        });
        localVoiceSpeechTranscription.mockReset();
        localVoiceSpeechTranscription.mockResolvedValue('');
        localVoiceUploadedAudio = new Uint8Array();
        let uploadRecipient: ReturnType<typeof createTransferRecipientKeyPair> | undefined;
        let uploadedSize = 0;
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            switch (request?.method) {
                case RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT:
                    return createExistingSessionDirectoryPreflightResult(request.payload);
                case RPC_METHODS.SESSION_SPAWN_NEW:
                    return await createVoiceConversationSessionFixture(request.payload);
                case RPC_METHODS.SPAWN_HAPPY_SESSION:
                case RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE:
                    return { type: 'success', sessionId: request.payload.sessionId };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT: {
                    const input = DaemonVoiceSpeechTranscribeUploadInitRequestSchema.parse(request.payload);
                    uploadedSize = input.sizeBytes;
                    uploadRecipient = createTransferRecipientKeyPair();
                    localVoiceUploadedAudio = new Uint8Array();
                    return DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse({
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        chunkSizeBytes: 64 * 1024,
                        recipientPublicKeyBase64: uploadRecipient.recipientPublicKeyBase64,
                    });
                }
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK: {
                    const input = DaemonVoiceSpeechTranscribeUploadChunkRequestSchema.parse(request.payload);
                    if (!uploadRecipient) throw new Error('Expected initialized upload');
                    const bytes = await decryptEncryptedTransferChunkEnvelope({ transferId: input.uploadId,
                        sequence: input.index, payloadBase64: input.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: input.encryptedDataKeyEnvelopeBase64,
                        recipientSecretKeySeed: uploadRecipient.recipientSecretKeySeed });
                    localVoiceUploadedAudio = new Uint8Array([...localVoiceUploadedAudio, ...bytes]);
                    return DaemonVoiceSpeechTranscribeUploadChunkResponseSchema.parse({ success: true });
                }
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE: {
                    DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema.parse(request.payload);
                    if (localVoiceUploadedAudio.byteLength !== uploadedSize) throw new Error('Recorded upload byte count mismatch');
                    return DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse({
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        sizeBytes: localVoiceUploadedAudio.byteLength,
                        sha256: createHash('sha256').update(localVoiceUploadedAudio).digest('hex'),
                    });
                }
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT:
                    DaemonVoiceSpeechTranscribeUploadAbortRequestSchema.parse(request.payload);
                    return DaemonVoiceSpeechTranscribeUploadAbortResponseSchema.parse({ success: true });
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE: {
                    const input = DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload);
                    const transcribing = localVoiceSpeechTranscription(input);
                    publishLocalVoiceBoundaryEvent('transcription');
                    return DaemonVoiceSpeechTranscribeResponseSchema.parse({
                        ok: true, requestId: input.requestId, text: await transcribing,
                    });
                }
                default:
                    return localVoiceSpeechOutputBoundary.machineRpc(request);
            }
        });
        // Node's URL implementation does not always provide these (browser-only) APIs.
        // The web voice runtime uses them for in-memory audio playback.
        (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:happier-test');
        (globalThis as any).URL.revokeObjectURL = vi.fn(() => {});
        // Provide a minimal `Audio` implementation so web playback fallback code paths
        // are testable under node/Vitest.
        (globalThis as any).Audio = class FakeAudio {
            src: string;
            onended: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(src: string) {
                this.src = src;
                createdAudioPlayers.push(this);
            }
            play() {
                return Promise.resolve();
            }
            pause() {}
            __emit(eventName: string, payload?: any) {
                if (eventName === 'playbackStatusUpdate' && payload?.didJustFinish) {
                    this.onended?.();
                    return;
                }
                if (eventName === 'ended') {
                    this.onended?.();
                    return;
                }
                if (eventName === 'error') {
                    this.onerror?.();
                }
            }
        };
        await (await installLocalVoiceAccountHarness()).setup(options?.serverIdentityId);
        const storage = await getStorage();
        const fixtureMachine = createMachineFixture();
        if (!fixtureMachine.metadata) throw new Error('Expected canonical Machine fixture metadata');
        const machine = createMachineFixture({
            id: 'machine-1',
            storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            active: true,
            createdAt: Date.now(),
            activeAt: Date.now(),
            metadata: {
                ...fixtureMachine.metadata,
                host: 'test',
                happyHomeDir: '/Users/test/.happier',
            },
        });
        storage.__setState({
            settings: { ...storage.getState().settings, ...BASE_SETTINGS },
            sessions: { s1: createSessionFixture({ id: 's1', serverId: localVoiceHomeId, active: true, activeAt: Date.now(),
                pendingVersion: 0, pendingCount: 0,
                metadata: { flavor: 'claude', host: 'test', machineId: 'machine-1', path: '/project' } }) },
            sessionMessages: {},
            machines: {
                'machine-1': machine,
            },
            machineListByServerId: {
                [localVoiceHomeId]: [machine],
            },
        });

    });

    afterEach(async () => {
        const [engine, { voiceConversationRuntimeMachine }, { voiceSessionBindingStore },
            { resetVoiceSessionRuntimeStateForTests }, { registerVoiceAdapters }, { useVoiceTargetStore },
            { __resetVoiceTurnInterruptions }] = await Promise.all([
            import('./localVoiceEngine'),
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/binding/voiceConversationBindingStore'),
            import('@/voice/session/voiceSessionStore'),
            import('@/voice/session/voiceAdapterRegistry'),
            import('@/voice/runtime/voiceTargetStore'),
            import('@/voice/transcript/voiceTurnInterruption'),
        ]);
        await engine.stopLocalVoiceSession();
        localVoiceSpeechOutputBoundary.disposeNativeSdkBridge();
        await resetVoiceSessionRuntimeStateForTests();
        voiceConversationRuntimeMachine.reset();
        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);
        registerVoiceAdapters([]);
        useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
        useVoiceTargetStore.getState().setScope('global');
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
        __resetVoiceTurnInterruptions();
        globalThis.fetch = originalFetch;
        if (originalNavigator) {
            if (originalMediaDevicesDescriptor) Object.defineProperty(originalNavigator, 'mediaDevices', originalMediaDevicesDescriptor);
            else Reflect.deleteProperty(originalNavigator, 'mediaDevices');
        }
        if (originalNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
        else Reflect.deleteProperty(globalThis, 'navigator');
        if (originalDocumentDescriptor) Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
        else Reflect.deleteProperty(globalThis, 'document');
        await (await installLocalVoiceAccountHarness()).dispose();
        const urlAny = (globalThis as any).URL as any;
        if (typeof originalCreateObjectURL === 'function') {
            urlAny.createObjectURL = originalCreateObjectURL;
        } else {
            Reflect.deleteProperty(urlAny, 'createObjectURL');
        }
        if (typeof originalRevokeObjectURL === 'function') {
            urlAny.revokeObjectURL = originalRevokeObjectURL;
        } else {
            Reflect.deleteProperty(urlAny, 'revokeObjectURL');
        }

        const audioAny = globalThis as any;
        if (typeof originalAudioCtor === 'function') {
            audioAny.Audio = originalAudioCtor;
        } else {
            Reflect.deleteProperty(audioAny, 'Audio');
        }
    });
    afterAll(async () => {
        // The real SDK registry owns one coordinator per JavaScript runtime.
        // Individual cases end sessions and release leases; only suite teardown disposes it.
        await localVoiceSpeechOutputBoundary.disposeAudioSession();
        localVoiceSpeechOutputBoundary.disposeNativeSdkBridge();
    });
}
