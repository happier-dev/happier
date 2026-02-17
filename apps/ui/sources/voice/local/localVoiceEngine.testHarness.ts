import { afterEach, beforeEach, vi } from 'vitest';

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
export const createdAudioPlayers: any[] = [];
export const deleteAsync = vi.fn(async () => {});
export const expoSpeechSpeak = vi.fn();
export const expoSpeechStop = vi.fn();
export const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patch: (metadata: any) => any) => {});
export const onSessionVisible = vi.fn((_sessionId: string) => {});
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
                    endpointing: { silenceMs: 450, minSpeechMs: 120 },
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
                    endpointing: { silenceMs: 450, minSpeechMs: 120 },
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

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage,
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

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => ({ refreshFromActiveServer }),
}));

vi.mock('expo-router', () => ({
    router: { navigate: (...args: any[]) => routerNavigate(...args) },
}));

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

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Platform: {
        get OS() {
            return platformOs;
        },
        select: (spec: any) => (spec && (spec.ios ?? spec.default)) ?? undefined,
    },
}));

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
    },
    deleteAsync,
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
        __setState: (patch: any) => Object.assign(state, patch),
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

    beforeEach(async () => {
        vi.resetModules();
        console.error = (() => {}) as any;
        sendMessage.mockReset();
        daemonVoiceAgentStart.mockReset();
        daemonVoiceAgentSendTurn.mockReset();
        daemonVoiceAgentStartTurnStream.mockReset();
        daemonVoiceAgentReadTurnStream.mockReset();
        daemonVoiceAgentCancelTurnStream.mockReset();
        daemonVoiceAgentCommit.mockReset();
        daemonVoiceAgentStop.mockReset();
        platformOs = 'ios';
        createdAudioPlayers.length = 0;
        nextRecorderPrepareError = null;
        deleteAsync.mockReset();
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

        const storage = await getStorage();
        storage.__setState({
            settings: { ...BASE_SETTINGS },
            sessions: {},
            sessionMessages: {},
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });
}
