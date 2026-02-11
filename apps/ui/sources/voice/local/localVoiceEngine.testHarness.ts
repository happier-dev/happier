import { afterEach, beforeEach, vi } from 'vitest';

export const sendMessage = vi.fn();
export const daemonMediatorStart = vi.fn();
export const createdAudioPlayers: any[] = [];
export const deleteAsync = vi.fn(async () => {});
export const expoSpeechSpeak = vi.fn();
export const expoSpeechStop = vi.fn();
export const speechRecStart = vi.fn();
export const speechRecStop = vi.fn();
export const speechRecAbort = vi.fn();
export const speechRecRequestPermissionsAsync = vi.fn(async () => ({ granted: true }));

let platformOs: 'ios' | 'web' = 'ios';
let nextRecorderPrepareError: Error | null = null;
let speechRecRecognitionAvailable = true;

const EXPO_SPEECH_STATE_KEY = Symbol.for('happier.vitest.expoSpeechStub.state');
const EXPO_SPEECH_REC_STATE_KEY = Symbol.for('happier.vitest.expoSpeechRecognitionStub.state');

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

export const BASE_SETTINGS = {
    voiceLocalSttBaseUrl: 'http://localhost:8000',
    voiceLocalSttApiKey: null,
    voiceLocalSttModel: 'whisper-1',
    voiceLocalTtsBaseUrl: null,
    voiceLocalTtsApiKey: null,
    voiceLocalTtsModel: 'tts-1',
    voiceLocalTtsVoice: 'alloy',
    voiceLocalTtsFormat: 'mp3',
    voiceLocalAutoSpeakReplies: false,
    voiceLocalConversationMode: 'direct_session',
    voiceLocalMediatorBackend: 'daemon',
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
    sync: { sendMessage },
}));

vi.mock('@/voice/mediator/daemonMediatorClient', () => ({
    DaemonMediatorClient: class {
        async start(args: any) {
            return (daemonMediatorStart as any)(args);
        }
        async sendTurn() {
            return { assistantText: 'Daemon reply' };
        }
        async commit() {
            return { commitText: 'Daemon commit' };
        }
        async stop() { }
    },
}));

vi.mock('@/utils/platform/microphonePermissions', () => ({
    requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('react-native', () => ({
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

    beforeEach(async () => {
        vi.resetModules();
        sendMessage.mockReset();
        daemonMediatorStart.mockReset();
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

        const storage = await getStorage();
        storage.__setState({
            settings: { ...BASE_SETTINGS },
            sessions: {},
            sessionMessages: {},
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });
}
