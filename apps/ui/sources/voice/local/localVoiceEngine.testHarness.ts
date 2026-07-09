import { afterEach, beforeEach, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import type { machineContributionRegistryProjectionDescribe as machineContributionRegistryProjectionDescribeFn } from '@/sync/ops/machineContributionRegistryProjection';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';

type MachineContributionRegistryProjectionDescribeFn = typeof machineContributionRegistryProjectionDescribeFn;

export const sendMessage = vi.fn();
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
export const createdAudioPlayers: any[] = [];
export const fileDelete = vi.fn(async () => {});
export const expoSpeechSpeak = vi.fn();
export const expoSpeechStop = vi.fn();
export const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patch: (metadata: any) => any) => {});
export const onSessionVisible = vi.fn((_sessionId: string) => {});
export const refreshSessions = vi.fn(async () => {});
export const speechRecStart = vi.fn();
export const speechRecStop = vi.fn();
export const speechRecAbort = vi.fn();
export const speechRecRequestPermissionsAsync = vi.fn(async () => ({ granted: true }));
export const audioStreamStart = vi.fn<(...args: any[]) => Promise<{ streamId: string }>>().mockResolvedValue({ streamId: 'audio-stream-1' });
export const audioStreamStop = vi.fn(async () => {});
export const sherpaStreamingCreate = vi.fn(async () => {});
export const sherpaStreamingPushFrame = vi.fn<(...args: any[]) => Promise<{ text: string; isEndpoint: boolean }>>().mockResolvedValue({
  text: '',
  isEndpoint: false,
});
export const sherpaStreamingFinish = vi.fn<(...args: any[]) => Promise<{ text: string }>>().mockResolvedValue({ text: '' });
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

let platformOs: 'ios' | 'web' = 'ios';
let nextRecorderPrepareError: Error | null = null;
let speechRecRecognitionAvailable = true;

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
        privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
            sharePermissionRequests: true,
            shareFilePaths: false,
            shareToolArgs: false,
        },
        adapters: {
            realtime_elevenlabs: {
                assistantLanguage: null,
                billingMode: 'happier',
                byo: { agentId: null, apiKey: null },
            },
	            local_direct: {
                stt: {
                    baseUrl: 'http://localhost:8000',
                    apiKey: null,
                    model: 'whisper-1',
                    useDeviceStt: false,
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'openai_compat',
                    openaiCompat: {
                        baseUrl: null,
                        apiKey: null,
                        model: 'tts-1',
                        voice: 'alloy',
                        format: 'mp3',
                    },
                    kokoro: { assetSetId: null, voiceId: null, speed: null },
                },
                networkTimeoutMs: 15_000,
	                handsFree: {
	                    enabled: false,
	                    endpointing: {
	                        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                    },
	                },
	            },
            local_conversation: {
                conversationMode: 'direct_session',
                stt: {
                    baseUrl: 'http://localhost:8000',
                    apiKey: null,
                    model: 'whisper-1',
                    useDeviceStt: false,
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'openai_compat',
                    openaiCompat: {
                        baseUrl: null,
                        apiKey: null,
                        model: 'tts-1',
                        voice: 'alloy',
                        format: 'mp3',
                    },
                    kokoro: { assetSetId: null, voiceId: null, speed: null },
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
                    backend: 'daemon',
                    agentSource: 'session',
                    agentId: 'claude',
                    permissionPolicy: 'read_only',
                    idleTtlSeconds: 300,
                    chatModelSource: 'custom',
                    chatModelId: 'default',
                    commitModelSource: 'chat',
                    commitModelId: 'default',
                    openaiCompat: {
                        chatBaseUrl: null,
                        chatApiKey: null,
                        chatModel: 'default',
                        commitModel: 'default',
                        temperature: 0.4,
                        maxTokens: null,
                    },
                    verbosity: 'short',
                },
                streaming: {
                    enabled: false,
                    ttsEnabled: false,
                    ttsChunkChars: 200,
                },
            },
        },
    },
} as const;

export function setPlatformOs(next: 'ios' | 'web') {
    platformOs = next;
}

export function setNextRecorderPrepareError(next: Error | null) {
    nextRecorderPrepareError = next;
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
        ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
        refreshSessionMessages: vi.fn(async () => {}),
        refreshSessions: (...args: any[]) => (refreshSessions as any)(...args),
        patchSessionMetadataWithRetry: async (sessionId: string, patch: (metadata: any) => any) => {
            (patchSessionMetadataWithRetry as any)(sessionId, patch);
            const { storage } = await import('@/sync/domains/state/storage');
            const state: any = storage.getState();
            const session: any = state.sessions?.[sessionId] ?? null;
            const nextMeta = patch(session?.metadata ?? {});
            if (typeof (storage as any).__setState === 'function') {
                (storage as any).__setState({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [sessionId]: session ? { ...session, metadata: nextMeta } : { id: sessionId, metadata: nextMeta },
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

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/ops/machines', () => ({
    machineSpawnNewSession: (...args: any[]) => machineSpawnNewSession(...args),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (
        machineId: Parameters<MachineContributionRegistryProjectionDescribeFn>[0],
        opts?: Parameters<MachineContributionRegistryProjectionDescribeFn>[1],
    ) => machineContributionRegistryProjectionDescribe(machineId, opts),
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
                                    return platformOs;
                                },
                        select: (spec: any) => (spec && (spec.ios ?? spec.default)) ?? undefined,
                    },
                }
    );
});

vi.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    AudioModule: {
        AudioRecorder: class {
            uri: string | null = null;
            async prepareToRecordAsync() {
                if (nextRecorderPrepareError) {
                    const error = nextRecorderPrepareError;
                    nextRecorderPrepareError = null;
                    throw error;
                }
            }
            record() { }
            async stop() {
                this.uri = 'file:///tmp/rec.m4a';
            }
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
        constructor(...uris: any[]) {
            const [base, name] = uris;
            this.uri = `${String(base)}${String(name ?? '')}`;
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
            getOptionalHappierAudioStreamNativeModule: () => ({
                start: (...args: any[]) => (audioStreamStart as any)(...args),
                stop: (...args: any[]) => (audioStreamStop as any)(...args),
                addListener,
            }),
        };
    },
);

vi.mock('@happier-dev/sherpa-native', () => ({
    getOptionalHappierSherpaNativeModule: () => ({
        createStreamingRecognizer: (...args: any[]) => (sherpaStreamingCreate as any)(...args),
        pushAudioFrame: (...args: any[]) => (sherpaStreamingPushFrame as any)(...args),
        finishStreaming: (...args: any[]) => (sherpaStreamingFinish as any)(...args),
        cancel: (...args: any[]) => (sherpaStreamingCancel as any)(...args),
    }),
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
        // Realtime status mirror sink: the realtime transport singleton subscribes
        // to the runtime machine and mirrors realtime-owned snapshots into these
        // store setters. They are storage-boundary no-ops for the local engine.
        setRealtimeStatus: () => {},
        setRealtimeMode: () => {},
        clearRealtimeModeDebounce: () => {},
    };

    const storage = {
        getState: () => {
            if (throwNextGetState) {
                const error = throwNextGetState;
                throwNextGetState = null;
                throw error;
            }
            return state;
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
                    normalizedSessions[id] = {
                        ...session,
                        // Voice runtime paths often need these for session-root target resolution.
                        metadata: {
                            host: 'test',
                            machineId: 'machine-1',
                            path: `/Users/test/.happier/worktree/${String(id)}`,
                            ...metadata,
                        },
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
    };

    return { storage };
});

export function registerLocalVoiceEngineHarnessHooks() {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const originalCreateObjectURL = (globalThis as any)?.URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as any)?.URL?.revokeObjectURL;
    const originalAudioCtor = (globalThis as any)?.Audio;

    beforeEach(async () => {
        vi.resetModules();
        vi.doUnmock('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.doUnmock('@/voice/input/DeviceSttController');
        vi.doUnmock('@/voice/input/SherpaStreamingSttController');
        vi.doUnmock('@/voice/runtime/mic/NativeMicSession');
        console.error = (() => {}) as any;
        sendMessage.mockReset();
        daemonVoiceAgentStart.mockReset();
        daemonVoiceAgentSendTurn.mockReset();
        daemonVoiceAgentStartTurnStream.mockReset();
        daemonVoiceAgentReadTurnStream.mockReset();
        daemonVoiceAgentCancelTurnStream.mockReset();
        daemonVoiceAgentCommit.mockReset();
        daemonVoiceAgentStop.mockReset();
        sendSessionMessageWithServerScope.mockReset();
        sessionRpcWithServerScope.mockReset();
        platformOs = 'ios';
        createdAudioPlayers.length = 0;
        nextRecorderPrepareError = null;
        fileDelete.mockReset();
        expoSpeechSpeak.mockReset();
        expoSpeechStop.mockReset();
        speechRecStart.mockReset();
        speechRecStop.mockReset();
        speechRecAbort.mockReset();
        speechRecRequestPermissionsAsync.mockReset();
        audioStreamStart.mockReset();
        audioStreamStop.mockReset();
        sherpaStreamingCreate.mockReset();
        sherpaStreamingPushFrame.mockReset();
        sherpaStreamingFinish.mockReset();
        sherpaStreamingCancel.mockReset();
        ensureModelPackInstalled.mockReset();
        resolveModelPackManifestUrl.mockReset();
        audioStreamStart.mockResolvedValue({ streamId: 'audio-stream-1' });
        audioStreamStop.mockResolvedValue(undefined);
        sherpaStreamingPushFrame.mockResolvedValue({ text: '', isEndpoint: false });
        sherpaStreamingFinish.mockResolvedValue({ text: '' });
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
        machineSpawnNewSession.mockReset();
        machineSpawnNewSession.mockImplementation(async (args: any) => {
            const machineId = typeof args?.machineId === 'string' ? args.machineId : 'machine-1';
            const directory = typeof args?.directory === 'string' ? args.directory : '/Users/test/.happier/voice-agent';
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
            spawnReadinessStatus: 'ready',
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
