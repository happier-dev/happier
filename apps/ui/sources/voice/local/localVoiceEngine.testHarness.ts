import { afterEach, beforeEach, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import type {
    getMachineContributionRegistryProjectionRevision as getMachineContributionRegistryProjectionRevisionFn,
    machineContributionRegistryProjectionDescribe as machineContributionRegistryProjectionDescribeFn,
    machinePluginSettingsGet as machinePluginSettingsGetFn,
    machinePluginSettingsSet as machinePluginSettingsSetFn,
} from '@/sync/ops/machineContributionRegistryProjection';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/voice/adapters/local/settings';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import {
    createLiveStorageStoreMock,
    createStableStorageReader,
    createStorageModuleStub,
} from '@/dev/testkit/mocks/storage';

const platformOsState = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));

type MachineContributionRegistryProjectionDescribeFn = typeof machineContributionRegistryProjectionDescribeFn;
type GetMachineContributionRegistryProjectionRevisionFn = typeof getMachineContributionRegistryProjectionRevisionFn;
type MachinePluginSettingsGetFn = typeof machinePluginSettingsGetFn;
type MachinePluginSettingsSetFn = typeof machinePluginSettingsSetFn;

export const sendMessage = vi.fn();
export const submitMessage = vi.fn();
export const enqueuePendingMessage = vi.fn(async (
    _sessionId: string,
    _text: string,
    _media: unknown,
    _replyTo: unknown,
    options?: Readonly<{ localId?: string }>,
) => ({
    localId: options?.localId ?? 'voice-test-pending-message',
    accepted: true,
    externalHandoffClaimed: true,
}));
export const blockPendingDelivery = vi.fn(async () => {});
export const markPendingDeliveryHandled = vi.fn(async () => {});
export const daemonVoiceAgentStart = vi.fn();
export const daemonVoiceAgentSendTurn = vi.fn();
export const daemonVoiceAgentWelcome = vi.fn();
export const daemonVoiceAgentStartTurnStream = vi.fn();
export const daemonVoiceAgentReadTurnStream = vi.fn();
export const daemonVoiceAgentCancelTurnStream = vi.fn();
export const daemonVoiceAgentCommit = vi.fn();
export const daemonVoiceAgentStop = vi.fn();
export const sessionExecutionRunStart = vi.fn();
export const sessionExecutionRunAction = vi.fn();
export const sessionExecutionRunList = vi.fn();
export const sessionExecutionRunGet = vi.fn();
export const sessionExecutionRunSend = vi.fn();
export const sessionExecutionRunStop = vi.fn();
export const sendSessionMessageWithServerScope = vi.fn();
export const sessionRpcWithServerScope = vi.fn();
export const machineRpcWithServerScope = vi.fn();
export const createdAudioPlayers: any[] = [];
export const fileDelete = vi.fn(async () => {});
export const expoSpeechSpeak = vi.fn();
export const expoSpeechStop = vi.fn();
export const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patch: (metadata: any) => any) => {});
export const onSessionVisible = vi.fn((_sessionId: string) => {});
export const refreshSessions = vi.fn(async () => {});
export const applySettings = vi.fn();
export const speechRecStart = vi.fn();
export const speechRecStop = vi.fn();
export const speechRecAbort = vi.fn();
export const speechRecRequestPermissionsAsync = vi.fn(async () => ({ granted: true }));
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
export const sherpaStreamingCancel = vi.fn(async () => {});
export const ensureModelPackInstalled = vi.fn(async () => ({
    packDirUri: 'file:///docs/happier/voice/modelPacks/dummy-pack',
    manifest: {
        packId: 'dummy-pack',
        kind: 'stt_sherpa',
        model: 'zipformer',
        version: '1.0.0',
        files: [{ path: 'tokens.txt', url: 'https://example.com/tokens.txt', sha256: 'a'.repeat(64), sizeBytes: 1 }],
    },
}));
export const resolveModelPackManifestUrl = vi.fn(() => 'https://example.com/manifest.json');
export const setActiveServerAndSwitch = vi.fn(async (_params?: any) => false);
export const refreshFromActiveServer = vi.fn(async () => {});
export const routerNavigate = vi.fn();
export const isRuntimeFeatureEnabled = vi.fn<(args: any) => Promise<boolean>>(async (_args) => true);
export const resolveRuntimeFeatureDecision = vi.fn(async (args: any) => ({
    featureId: args?.featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: Date.now(),
    scope: {
        scopeKind: 'runtime',
        ...(args?.serverId ? { serverId: String(args.serverId) } : {}),
    },
}));
export const machineSpawnNewSession = vi.fn<(...args: any[]) => Promise<{ type: 'success'; sessionId: string }>>();
export const machineContributionRegistryProjectionDescribe = vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async (_machineId: string, _opts?: Readonly<{ serverId?: string | null; timeoutMs?: number | null }>) => ({
        supported: false,
        reason: 'not-supported',
    }),
);
export const getMachineContributionRegistryProjectionRevision = vi.fn<GetMachineContributionRegistryProjectionRevisionFn>(
    () => 0,
);
export const machinePluginSettingsGet = vi.fn<MachinePluginSettingsGetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
);
export const machinePluginSettingsSet = vi.fn<MachinePluginSettingsSetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
);

let nextRecorderPrepareError: Error | null = null;
let recorderUri: string | null = 'file:///tmp/rec.m4a';
let speechRecRecognitionAvailable = true;
let sherpaNativeModuleAvailable = true;

const EXPO_SPEECH_STATE_KEY = Symbol.for('happier.vitest.expoSpeechStub.state');
const EXPO_SPEECH_REC_STATE_KEY = Symbol.for('happier.vitest.expoSpeechRecognitionStub.state');
const AUDIO_STREAM_STATE_KEY = Symbol.for('happier.vitest.audioStreamStub.state');

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
    sherpaNativeModuleAvailable = next;
}

export function emitSpeechRecEvent(eventName: string, event: any = {}) {
    const state = (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY];
    const set: Set<(event: any) => void> | undefined = state?.listeners?.get?.(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export function emitAudioStreamEvent(eventName: string, event: any = {}) {
    const state = (globalThis as any)[AUDIO_STREAM_STATE_KEY];
    const set: Set<(event: any) => void> | undefined = state?.listeners?.get?.(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export const BASE_SETTINGS = {
    lastUsedAgent: 'codex',
    recentMachinePaths: [
        {
            machineId: 'machine-1',
            path: '/Users/test/.happier',
        },
    ],
    voice: {
        providerId: 'local_conversation',
        assistantLanguage: null,
        welcome: { enabled: false, mode: 'immediate', templateId: null },
        executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
        privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
            sharePermissionRequests: true,
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareToolArgs: false,
        },
        providers: {
            'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
                billingMode: 'happier',
                byo: { agentId: null },
            } },
	            local_direct: { schemaVersion: 1, config: {
                stt: {
                    provider: 'happier.voice.openai-compat/stt',
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                        execution: 'auto',
                    },
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'happier.voice.openai-compat/tts',
                    localNeural: {
                        model: 'kokoro',
                        assetId: null,
                        voiceId: null,
                        speed: null,
                        execution: 'auto',
                    },
                },
                networkTimeoutMs: 15_000,
	                handsFree: {
	                    enabled: false,
	                    endpointing: {
	                        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                    },
	                },
	            } },
            local_conversation: { schemaVersion: 1, config: {
                conversationMode: 'direct_session',
                stt: {
                    provider: 'happier.voice.openai-compat/stt',
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                        execution: 'auto',
                    },
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'happier.voice.openai-compat/tts',
                    localNeural: {
                        model: 'kokoro',
                        assetId: null,
                        voiceId: null,
                        speed: null,
                        execution: 'auto',
                    },
                },
                networkTimeoutMs: 15_000,
	                handsFree: {
	                    enabled: false,
	                    endpointing: {
	                        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                    },
	                },
	                agent: {
                    agentSource: 'session',
                    agentId: 'claude',
                    permissionIntent: 'read-only',
                    idleTtlSeconds: 300,
                    chatModelSource: 'custom',
                    chatModelId: 'default',
                    commitModelSource: 'chat',
                    commitModelId: 'default',
                    providerChat: null,
                    verbosity: 'short',
                },
                streaming: {
                    enabled: false,
                    ttsEnabled: false,
                    ttsChunkChars: 200,
                },
            } },
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
    platformOsState.value = next;
}

export function setNextRecorderPrepareError(next: Error | null) {
    nextRecorderPrepareError = next;
}

export function setRecorderUri(next: string | null) {
    recorderUri = next;
}

export async function getStorage() {
    const { storage } = await import('@/sync/domains/state/storage');
    return storage as any;
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

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage,
        submitMessage,
        enqueuePendingMessage,
        blockPendingDelivery,
        markPendingDeliveryHandled,
        ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
        refreshSessionMessages: vi.fn(async () => {}),
        refreshSessions: (...args: any[]) => (refreshSessions as any)(...args),
        applySettings: (...args: any[]) => (applySettings as any)(...args),
        patchSessionMetadataWithRetry: async (sessionId: string, patch: (metadata: any) => any) => {
            (patchSessionMetadataWithRetry as any)(sessionId, patch);
            const { storage } = await import('@/sync/domains/state/storage');
            const state: any = storage.getState();
            const session: any = state.sessions?.[sessionId] ?? null;
            const writesOwnerView = session?.metadataLayoutVersion === 1;
            const nextMeta = patch(
                writesOwnerView ? session?.ownerMetadataView ?? {} : session?.metadata ?? {},
            );
            if (typeof (storage as any).__setState === 'function') {
                (storage as any).__setState({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [sessionId]: session
                            ? {
                                ...session,
                                ...(writesOwnerView
                                    ? { ownerMetadataView: nextMeta }
                                    : { metadata: nextMeta }),
                            }
                            : { id: sessionId, metadata: nextMeta },
                    },
                });
            }
        },
        onSessionVisible,
        encryption: {
            getSessionEncryption: vi.fn(() => ({})),
        },
    },
}));

// The lazy sync accessor is a bundler-only `require`, so it never sees the `@/sync/sync`
// mock above and would load a second, unaliased copy of the real sync module under Node.
// Route it to the same mocked surface so both accessors return one object.
vi.mock('@/sync/runtime/getSyncSingleton', async () => {
    const { sync } = await import('@/sync/sync');
    return { getSyncSingleton: () => sync };
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: (sessionId: string, request: any) => sessionExecutionRunStart(sessionId, request),
    sessionExecutionRunAction: (sessionId: string, request: any) => sessionExecutionRunAction(sessionId, request),
    sessionExecutionRunList: (sessionId: string, request: any) => sessionExecutionRunList(sessionId, request),
    sessionExecutionRunGet: (sessionId: string, request: any) => sessionExecutionRunGet(sessionId, request),
    sessionExecutionRunSend: (sessionId: string, request: any) => sessionExecutionRunSend(sessionId, request),
    sessionExecutionRunStop: (sessionId: string, request: any) => sessionExecutionRunStop(sessionId, request),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (args: any) => sessionRpcWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
    sendSessionMessageWithServerScope: (args: any) => sendSessionMessageWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: any) => machineRpcWithServerScope(request),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/ops/machines', () => ({
    machineSpawnNewSession: (...args: any[]) => machineSpawnNewSession(...args),
    completePendingMachineSpawnAttemptCustodyForSession: async () => null,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: (
        scope: Parameters<GetMachineContributionRegistryProjectionRevisionFn>[0],
    ) => getMachineContributionRegistryProjectionRevision(scope),
    machineContributionRegistryProjectionDescribe: (
        machineId: Parameters<MachineContributionRegistryProjectionDescribeFn>[0],
        opts?: Parameters<MachineContributionRegistryProjectionDescribeFn>[1],
    ) => machineContributionRegistryProjectionDescribe(machineId, opts),
    machinePluginSettingsGet: (...args: Parameters<MachinePluginSettingsGetFn>) =>
        machinePluginSettingsGet(...args),
    machinePluginSettingsSet: (...args: Parameters<MachinePluginSettingsSetFn>) =>
        machinePluginSettingsSet(...args),
    // This harness does not exercise plugin-secret custody, but the current
    // Settings runtime imports the three boundary functions at module load.
    // Keep the untouched external boundary fail-closed.
    machinePluginSecretStatus: async () => ({ supported: false as const, reason: 'not-supported' as const }),
    machinePluginSecretSet: async () => ({ supported: false as const, reason: 'not-supported' as const }),
    machinePluginSecretDelete: async () => ({ supported: false as const, reason: 'not-supported' as const }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => ({ refreshFromActiveServer }),
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (args: any) => isRuntimeFeatureEnabled(args),
    resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { navigate: (...args: any[]) => routerNavigate(...args) },
    });
    return expoRouterMock.module;
});

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
    DaemonVoiceAgentClient: class {
        async start(args: any) {
            return (daemonVoiceAgentStart as any)(args);
        }
        async sendTurn(args: any) {
            return (daemonVoiceAgentSendTurn as any)(args);
        }
        async welcome(args: any) {
            return (daemonVoiceAgentWelcome as any)(args);
        }
        async startTurnStream(args: any) {
            return (daemonVoiceAgentStartTurnStream as any)(args);
        }
        async readTurnStream(args: any) {
            return (daemonVoiceAgentReadTurnStream as any)(args);
        }
        async cancelTurnStream(args: any) {
            return (daemonVoiceAgentCancelTurnStream as any)(args);
        }
        async commit(args: any) {
            return (daemonVoiceAgentCommit as any)(args);
        }
        async stop(args: any) {
            return (daemonVoiceAgentStop as any)(args);
        }
    },
}));

vi.mock('@/utils/platform/microphonePermissions', () => ({
    requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
    ensureModelPackInstalled: (params: any, overrides?: any) => (ensureModelPackInstalled as any)(params, overrides),
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
    resolveModelPackManifestUrl: (params: any) => (resolveModelPackManifestUrl as any)(params),
}));

// The production binary speech tunnel is a network boundary. Local-engine unit
// suites exercise the deterministic JSON-RPC compatibility path beneath it.
vi.mock('@/voice/runtime/daemonInference/DaemonSpeechStreamProductionTunnelTransport', () => ({
    createProductionDaemonSpeechStreamingSttTransport: vi.fn(async () => null),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Text: 'Text',
                    Dimensions: {
                        get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
                    },
                    Platform: {
                        get OS() {
                                    return platformOsState.value;
                                },
                        select: (spec: any) => (spec && (spec.ios ?? spec.default)) ?? undefined,
                    },
                }
    );
});

vi.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    AudioModule: {
        setAudioModeAsync: vi.fn(async () => {}),
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

vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///tmp/' },
    File: class {
        uri: string;
        size = 3;
        constructor(...uris: any[]) {
            const [base, name] = uris;
            this.uri = `${String(base)}${String(name ?? '')}`;
        }
        open() {
            let offset = 0;
            return {
                size: this.size,
                get offset() { return offset; },
                set offset(next: number) { offset = next; },
                readBytes: (length: number) => new Uint8Array([1, 2, 3]).slice(offset, offset + length),
                close: () => {},
            };
        }
        write(_content: any) { }
        delete = fileDelete;
    },
    deleteAsync: () => {
        throw new Error('deprecated_deleteAsync_called');
    },
}));

vi.mock(
    '@happier-dev/audio-stream-native',
    () => {
        const listeners = new Map<string, Set<(event: any) => void>>();
        (globalThis as any)[AUDIO_STREAM_STATE_KEY] = { listeners };

        const addListener = (eventName: string, cb: (event: any) => void) => {
            const set = listeners.get(eventName) ?? new Set();
            set.add(cb);
            listeners.set(eventName, set);
            return { remove: () => set.delete(cb) };
        };

        return {
            createVoiceFileRecording: () => ({
                start: async () => {},
                setMuted: async () => {},
                stop: async () => recorderUri,
            }),
            getSharedVoicePcmCapture: () => ({
                acquire: async (request: any) => {
                    const subscription = addListener('audioFrame', (event: any) => {
                        if (request.shouldDeliver?.() === false) return;
                        void Promise.resolve(request.onFrame(event)).catch((error) => request.onError?.(error));
                    });
                    await (audioStreamStart as any)({
                        sampleRate: request.format.sampleRate,
                        channels: request.format.channels,
                        frameMs: request.format.frameMs,
                    });
                    let released = false;
                    return {
                        id: `test-pcm-capture:${String(request.ownerId)}`,
                        release: async () => {
                            if (released) return;
                            released = true;
                            subscription.remove();
                            await (audioStreamStop as any)();
                        },
                        waitForDrain: async () => {},
                    };
                },
            }),
            getSharedVoiceAudioSessionCoordinator: () => ({
                acquire: async () => ({
                    id: 'test-audio-session-lease',
                    capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
                    release: () => audioSessionRelease(),
                }),
                subscribe: () => ({ remove: () => {} }),
                getSnapshot: () => ({ generation: 0, leaseCount: 0, configuration: null, capabilities: null }),
                dispose: async () => {},
            }),
        };
    },
);

vi.mock('@happier-dev/sherpa-native', () => ({
    getOptionalHappierSherpaNativeModule: () => sherpaNativeModuleAvailable
        ? {
            createStreamingRecognizer: (...args: any[]) => (sherpaStreamingCreate as any)(...args),
            pushAudioFrame: (...args: any[]) => (sherpaStreamingPushFrame as any)(...args),
            finishStreaming: (...args: any[]) => (sherpaStreamingFinish as any)(...args),
            cancel: (...args: any[]) => (sherpaStreamingCancel as any)(...args),
        }
        : null,
}));

vi.mock('@/sync/domains/state/storage', () => {
    const subscribers = new Set<() => void>();
    let throwNextGetState: unknown = null;
    const state: any = {
        settings: {
            ...BASE_SETTINGS,
        },
        sessions: {},
        sessionMessages: {},
    };

    const liveStorage = createLiveStorageStoreMock(() => state);
    const readLiveStorageState = liveStorage.getState;
    const storage = Object.assign(liveStorage, {
        getState: () => {
            if (throwNextGetState) {
                const error = throwNextGetState;
                throwNextGetState = null;
                throw error;
            }
            return readLiveStorageState();
        },
        subscribe: (fn: () => void) => {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        __setState: (patch: any) => {
            const normalizedPatch = { ...patch };
            if (patch?.sessions && typeof patch.sessions === 'object') {
                const normalizedSessions: Record<string, any> = {};
                for (const [id, session] of Object.entries(patch.sessions)) {
                    if (!session || typeof session !== 'object') {
                        normalizedSessions[id] = session;
                        continue;
                    }
                    const metadata = (session as any).metadata && typeof (session as any).metadata === 'object'
                        ? (session as any).metadata
                        : {};
                    const ownerMetadataView =
                        (session as any).ownerMetadataView && typeof (session as any).ownerMetadataView === 'object'
                            ? (session as any).ownerMetadataView
                            : {};
                    const executionMetadata = {
                        host: 'test',
                        machineId: 'machine-1',
                        path: `/Users/test/.happier/worktree/${String(id)}`,
                        agentRuntimeCapabilitiesV1: {
                            localControl: { supported: true },
                        },
                        ...((session as any).metadataLayoutVersion === 1 ? ownerMetadataView : metadata),
                    };
                    normalizedSessions[id] = {
                        ...session,
                        // Voice runtime paths often need these for session-root target resolution.
                        ...((session as any).metadataLayoutVersion === 1
                            ? { metadata, ownerMetadataView: executionMetadata }
                            : { metadata: executionMetadata }),
                    };
                }
                normalizedPatch.sessions = normalizedSessions;
            }
            Object.assign(state, normalizedPatch);
        },
        __notify: () => subscribers.forEach((fn) => fn()),
        __throwGetStateOnce: (err: unknown) => {
            throwNextGetState = err;
        },
    });

    return createStorageModuleStub({
        storage,
        useSetting: createStableStorageReader((key: string) => state.settings?.[key] ?? null),
        useProfile: createStableStorageReader(() => state.profile ?? null),
        useActiveServerAccountScope: createStableStorageReader(() => state.profileScope ?? null),
    });
});

export function registerLocalVoiceEngineHarnessHooks(options?: Readonly<{
    resetModulesBetweenTests?: boolean;
}>) {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const originalCreateObjectURL = (globalThis as any)?.URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as any)?.URL?.revokeObjectURL;
    const originalAudioCtor = (globalThis as any)?.Audio;

    beforeEach(async () => {
        if (options?.resetModulesBetweenTests !== false) {
            vi.resetModules();
        }
        vi.doUnmock('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.doUnmock('@/voice/input/DeviceSttController');
        vi.doUnmock('@/voice/input/SherpaStreamingSttController');
        vi.doUnmock('@/voice/runtime/mic/NativeMicSession');
        console.error = (() => {}) as any;
        sendMessage.mockReset();
        submitMessage.mockReset();
        submitMessage.mockResolvedValue(undefined);
        enqueuePendingMessage.mockClear();
        blockPendingDelivery.mockReset();
        blockPendingDelivery.mockResolvedValue(undefined);
        markPendingDeliveryHandled.mockReset();
        markPendingDeliveryHandled.mockResolvedValue(undefined);
        daemonVoiceAgentStart.mockReset();
        daemonVoiceAgentSendTurn.mockReset();
        daemonVoiceAgentStartTurnStream.mockReset();
        daemonVoiceAgentReadTurnStream.mockReset();
        daemonVoiceAgentCancelTurnStream.mockReset();
        daemonVoiceAgentCommit.mockReset();
        daemonVoiceAgentStop.mockReset();
        sessionExecutionRunList.mockReset();
        sessionExecutionRunList.mockResolvedValue({ runs: [] });
        sessionExecutionRunGet.mockReset();
        sessionExecutionRunGet.mockResolvedValue({ error: 'not-found' });
        sendSessionMessageWithServerScope.mockReset();
        sessionRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockReset();
        platformOsState.value = 'ios';
        createdAudioPlayers.length = 0;
        nextRecorderPrepareError = null;
        recorderUri = 'file:///tmp/rec.m4a';
        fileDelete.mockReset();
        expoSpeechSpeak.mockReset();
        expoSpeechStop.mockReset();
        speechRecStart.mockReset();
        speechRecStop.mockReset();
        speechRecAbort.mockReset();
        speechRecRequestPermissionsAsync.mockReset();
        audioStreamStart.mockReset();
        audioStreamStop.mockReset();
        audioSessionRelease.mockReset();
        sherpaStreamingCreate.mockReset();
        sherpaStreamingPushFrame.mockReset();
        sherpaStreamingFinish.mockReset();
        sherpaStreamingCancel.mockReset();
        ensureModelPackInstalled.mockReset();
        resolveModelPackManifestUrl.mockReset();
        audioStreamStart.mockResolvedValue({ streamId: 'audio-stream-1' });
        audioStreamStop.mockResolvedValue(undefined);
        audioSessionRelease.mockResolvedValue(undefined);
        sherpaStreamingPushFrame.mockResolvedValue({ text: '', isEndpoint: false });
        sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: '' });
        sherpaStreamingCreate.mockResolvedValue(undefined);
        sherpaStreamingCancel.mockResolvedValue(undefined);
        ensureModelPackInstalled.mockResolvedValue({
            packDirUri: 'file:///docs/happier/voice/modelPacks/dummy-pack',
            manifest: {
                packId: 'dummy-pack',
                kind: 'stt_sherpa',
                model: 'zipformer',
                version: '1.0.0',
                files: [{ path: 'tokens.txt', url: 'https://example.com/tokens.txt', sha256: 'a'.repeat(64), sizeBytes: 1 }],
            },
        });
        resolveModelPackManifestUrl.mockReturnValue('https://example.com/manifest.json');
        isRuntimeFeatureEnabled.mockReset();
        isRuntimeFeatureEnabled.mockResolvedValue(true);
        speechRecRecognitionAvailable = true;
        sherpaNativeModuleAvailable = true;
        setExpoSpeechStubState({
            speakImpl: (...args: any[]) => (expoSpeechSpeak as any)(...args),
            stopImpl: (...args: any[]) => (expoSpeechStop as any)(...args),
        });
        setExpoSpeechRecognitionStubState({
            recognitionAvailable: true,
            listeners: new Map(),
            startImpl: (...args: any[]) => (speechRecStart as any)(...args),
            stopImpl: (...args: any[]) => (speechRecStop as any)(...args),
            abortImpl: (...args: any[]) => (speechRecAbort as any)(...args),
            requestPermissionsImpl: (...args: any[]) => (speechRecRequestPermissionsAsync as any)(...args),
        });
        globalThis.fetch = vi.fn() as any;
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            switch (request?.method) {
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT: {
                    const recipient = createTransferRecipientKeyPair();
                    return {
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        chunkSizeBytes: 64 * 1024,
                        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                    };
                }
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK:
                    return { success: true };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE:
                    return {
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        sizeBytes: 3,
                        sha256: 'a'.repeat(64),
                    };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE: {
                    // These legacy engine-behavior suites use fetch queues only as
                    // deterministic third-party response fixtures. Production UI
                    // still crosses the machine-scoped daemon RPC boundary above.
                    const response = await (globalThis.fetch as any)('http://localhost:8000/v1/audio/transcriptions', {
                        method: 'POST',
                        body: request?.payload ?? null,
                        signal: request?.signal,
                    });
                    const body = await response.json();
                    return {
                        ok: true,
                        requestId: String(request?.payload?.requestId ?? ''),
                        text: String(body?.text ?? ''),
                    };
                }
                default:
                    throw new Error(`unexpected local voice engine machine RPC: ${String(request?.method)}`);
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
        daemonVoiceAgentSendTurn.mockResolvedValue({ assistantText: 'Daemon reply' });
        daemonVoiceAgentStartTurnStream.mockResolvedValue({ streamId: 'stream-1' });
        daemonVoiceAgentReadTurnStream.mockResolvedValue({
            streamId: 'stream-1',
            events: [
                { t: 'delta', textDelta: 'Daemon ' },
                { t: 'done', assistantText: 'Daemon reply' },
            ],
            nextCursor: 2,
            done: true,
        });
        daemonVoiceAgentCancelTurnStream.mockResolvedValue({ ok: true });
        daemonVoiceAgentCommit.mockResolvedValue({ commitText: 'Daemon commit' });
        daemonVoiceAgentStop.mockResolvedValue({ ok: true });
        sessionExecutionRunStop.mockReset();
        sessionExecutionRunStop.mockResolvedValue({ ok: true });
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        getMachineContributionRegistryProjectionRevision.mockReset();
        getMachineContributionRegistryProjectionRevision.mockReturnValue(0);
        machinePluginSettingsGet.mockReset();
        machinePluginSettingsGet.mockResolvedValue({ supported: false, reason: 'not-supported' });
        machinePluginSettingsSet.mockReset();
        machinePluginSettingsSet.mockResolvedValue({ supported: false, reason: 'not-supported' });
        machineSpawnNewSession.mockReset();
        machineSpawnNewSession.mockImplementation(async (args: any) => {
            const machineId = typeof args?.machineId === 'string' ? args.machineId : 'machine-1';
            const directory = typeof args?.directory === 'string' ? args.directory : '/Users/test/.happier/voice-agent';
            const spawnedAgentId = args?.backendTarget?.kind === 'builtInAgent'
                && typeof args.backendTarget.agentId === 'string'
                ? args.backendTarget.agentId
                : 'claude';
            const sessionId = 'voice-home-session';
            const storage = await getStorage();
            const current: any = storage.getState();
            if (typeof (storage as any).__setState === 'function') {
                const existing = current.sessions?.[sessionId];
                (storage as any).__setState({
                    ...current,
                    sessions: {
                        ...(current.sessions ?? {}),
                        [sessionId]: existing ?? {
                            id: sessionId,
                            active: true,
                            updatedAt: Date.now(),
                            metadata: {
                                ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
                                flavor: spawnedAgentId,
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
            }
            return { type: 'success' as const, sessionId };
        });

        const storage = await getStorage();
        const machine = {
            id: 'machine-1',
            active: true,
            createdAt: Date.now(),
            activeAt: Date.now(),
            metadata: {
                host: 'test',
                happyHomeDir: '/Users/test/.happier',
            },
        };
        storage.__setState({
            settings: { ...BASE_SETTINGS },
            sessions: {},
            sessionMessages: {},
            machines: {
                'machine-1': machine,
            },
            machineListByServerId: {
                'server-a': [machine],
            },
        });

    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
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
}
