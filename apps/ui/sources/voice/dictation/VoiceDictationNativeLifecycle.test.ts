import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    VoiceAudioSessionCoordinator,
    VoiceAudioSessionPlatform,
    VoiceAudioSessionPlatformEvent,
} from '@happier-dev/audio-stream-native';

import { createVoiceAudioSessionCoordinator } from '../../../../../packages/audio-stream-native/src/voiceAudioSessionCoordinator';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createLocalVoiceCaptureOwner } from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import { createExpoAudioRecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';

import { createVoiceDictationController } from './VoiceDictationController';

const nativeBoundary = vi.hoisted(() => ({
    coordinator: null as VoiceAudioSessionCoordinator | null,
    listeners: {} as Record<string, (event: unknown) => void>,
    recognizerStart: vi.fn(),
    recognizerStop: vi.fn(),
}));

vi.mock('@happier-dev/audio-stream-native', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/audio-stream-native')>(
        '@happier-dev/audio-stream-native',
    );
    return {
        ...actual,
        getSharedVoiceAudioSessionCoordinator: () => nativeBoundary.coordinator,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            Version: '18.0',
        },
    });
});

vi.mock('@/utils/platform/microphonePermissions', () => ({
    requestMicrophonePermission: vi.fn(async () => ({
        granted: true,
        canAskAgain: true,
    })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('expo-speech-recognition', () => ({
    ExpoSpeechRecognitionModule: {
        addListener: (eventName: string, listener: (event: unknown) => void) => {
            nativeBoundary.listeners[eventName] = listener;
            return {
                remove: () => {
                    if (nativeBoundary.listeners[eventName] === listener) {
                        delete nativeBoundary.listeners[eventName];
                    }
                },
            };
        },
        isRecognitionAvailable: () => true,
        requestPermissionsAsync: async () => ({ granted: true }),
        start: (...args: unknown[]) => nativeBoundary.recognizerStart(...args),
        stop: (...args: unknown[]) => nativeBoundary.recognizerStop(...args),
    },
}));

type NativeLifecycleEventFactory = (
    generation: number,
) => VoiceAudioSessionPlatformEvent;

const TERMINAL_NATIVE_EVENTS: ReadonlyArray<Readonly<{
    label: string;
    createEvent: NativeLifecycleEventFactory;
}>> = [
    {
        label: 'interruption',
        createEvent: (generation) => ({
            generation,
            kind: 'interruption_began',
        }),
    },
    {
        label: 'permanent focus loss',
        createEvent: (generation) => ({
            generation,
            kind: 'focus_changed',
            state: 'lost_permanent',
        }),
    },
    {
        label: 'backgrounding',
        createEvent: (generation) => ({
            generation,
            kind: 'lifecycle_changed',
            state: 'background',
        }),
    },
    {
        // Dictation records through the same native graph. A media-services
        // reset kills it while the attempt still looks like it is listening.
        label: 'dead native audio graph',
        createEvent: (generation) => ({
            generation,
            kind: 'audio_graph_terminal',
            reason: 'media_services_reset',
        }),
    },
];

function createNativeCoordinatorHarness(): Readonly<{
    coordinator: VoiceAudioSessionCoordinator;
    emit: (event: VoiceAudioSessionPlatformEvent) => void;
    restore: ReturnType<typeof vi.fn>;
}> {
    let listener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
    const restore = vi.fn(async () => {});
    const platform: VoiceAudioSessionPlatform = {
        apply: vi.fn(async ({ generation, configuration }) => ({
            generation,
            aecAvailable: true,
            aecActive: configuration.aec !== 'off',
            route: 'built-in',
        })),
        restore,
        subscribe: (next) => {
            listener = next;
            return {
                remove: () => {
                    listener = null;
                },
            };
        },
    };
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    return {
        coordinator,
        emit: (event) => listener?.(event),
        restore,
    };
}

function createRecordedDictationHarness(
    coordinator: VoiceAudioSessionCoordinator,
) {
    const recorderStop = vi.fn(async () => {});
    const createRecorder = vi.fn(() => ({
        uri: 'file:///native-dictation.m4a',
        prepareToRecordAsync: vi.fn(async () => {}),
        pause: vi.fn(),
        record: vi.fn(),
        stop: recorderStop,
    }));
    const captureOwner = createLocalVoiceCaptureOwner({
        getSettings: () => ({}),
        onCaptureError: vi.fn(),
        onCaptureStarted: vi.fn(),
    }, {
        createRecordingMicSession: () => createExpoAudioRecordingMicSession({
            createRecorder,
            requestPermission: async () => ({
                granted: true,
                canAskAgain: true,
            }),
        }),
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => ({
            voice: {
                dictation: {
                    sttBinding: 'explicit',
                    language: null,
                    stt: {
                        provider: 'happier.voice.openai-compat/stt',
                    },
                },
            },
        }),
        nativeAudioSessionCoordinator: coordinator,
        measureRecordedAudioBytes: async () => 4,
        deleteRecordedAudio: async () => {},
        transcribeRecordedAudio: vi.fn(),
    });
    return {
        controller,
        createRecorder,
        recorderStop,
    };
}

function createDeviceDictationHarness(
    coordinator: VoiceAudioSessionCoordinator,
) {
    const liveMicSessions: Array<Readonly<{
        teardown: ReturnType<typeof vi.fn>;
    }>> = [];
    const captureOwner = createLocalVoiceCaptureOwner({
        getSettings: () => ({}),
        onCaptureError: vi.fn(),
        onCaptureStarted: vi.fn(),
    }, {
        createDeviceSttController: (deps) => createDeviceSttController({
            ...deps,
            getAudioSessionCoordinator: () => coordinator,
            stopTimeoutMs: 0,
        }),
        createLiveMicSession: () => {
            const session = {
                ensureActive: vi.fn(async () => {}),
                setMuted: vi.fn(),
                isMuted: vi.fn(() => false),
                teardown: vi.fn(async () => {}),
                getStream: vi.fn(() => null),
            };
            liveMicSessions.push(session);
            return session;
        },
    });
    const controller = createVoiceDictationController({
        captureOwner,
        getSettings: () => ({
            voice: {
                dictation: {
                    sttBinding: 'explicit',
                    language: null,
                    stt: {
                        provider: 'device',
                    },
                },
            },
        }),
        nativeAudioSessionCoordinator: coordinator,
        measureRecordedAudioBytes: async () => 0,
        deleteRecordedAudio: async () => {},
        transcribeRecordedAudio: vi.fn(),
    });
    return {
        controller,
        liveMicSessions,
    };
}

async function proveTerminalLifecycleAndRetry(input: Readonly<{
    controller: ReturnType<typeof createVoiceDictationController>;
    coordinator: VoiceAudioSessionCoordinator;
    emit: (event: VoiceAudioSessionPlatformEvent) => void;
}>): Promise<void> {
    for (const nativeEvent of TERMINAL_NATIVE_EVENTS) {
        await expect(input.controller.toggle('dictation-session')).resolves.toEqual({
            kind: 'started',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);
        const currentGeneration = input.coordinator.getSnapshot().generation;

        input.emit(nativeEvent.createEvent(currentGeneration - 1));
        await Promise.resolve();
        expect(input.controller.getSnapshot()).toMatchObject({
            sessionId: 'dictation-session',
            status: 'listening',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);

        input.emit(nativeEvent.createEvent(currentGeneration));
        await vi.waitFor(() => {
            expect(input.controller.getSnapshot().status).toBe('idle');
            expect(input.coordinator.getSnapshot().leaseCount).toBe(0);
        });

        await expect(input.controller.toggle('dictation-session')).resolves.toEqual({
            kind: 'started',
        });
        expect(input.coordinator.getSnapshot().leaseCount).toBe(1);
        await input.controller.cancel('dictation-session');
        expect(input.coordinator.getSnapshot().leaseCount).toBe(0);
    }
}

describe('Dictation native audio lifecycle', () => {
    beforeEach(() => {
        nativeBoundary.listeners = {};
        nativeBoundary.recognizerStart.mockReset();
        nativeBoundary.recognizerStop.mockReset();
    });

    afterEach(async () => {
        nativeBoundary.coordinator = null;
    });

    it('settles recorded Dictation on current native terminal facts, ignores stale facts, releases, and retries', async () => {
        const native = createNativeCoordinatorHarness();
        nativeBoundary.coordinator = native.coordinator;
        const dictation = createRecordedDictationHarness(native.coordinator);

        await proveTerminalLifecycleAndRetry({
            controller: dictation.controller,
            coordinator: native.coordinator,
            emit: native.emit,
        });

        expect(dictation.recorderStop).toHaveBeenCalledTimes(8);
        expect(native.restore).toHaveBeenCalledTimes(8);
        await native.coordinator.dispose();
    });

    it('settles Device Dictation on current native terminal facts, ignores stale facts, releases, and retries', async () => {
        const native = createNativeCoordinatorHarness();
        nativeBoundary.coordinator = native.coordinator;
        const dictation = createDeviceDictationHarness(native.coordinator);

        await proveTerminalLifecycleAndRetry({
            controller: dictation.controller,
            coordinator: native.coordinator,
            emit: native.emit,
        });

        expect(nativeBoundary.recognizerStop).toHaveBeenCalledTimes(8);
        expect(dictation.liveMicSessions).toHaveLength(8);
        expect(dictation.liveMicSessions.every((session) => (
            session.teardown.mock.calls.length === 1
        ))).toBe(true);
        expect(native.restore).toHaveBeenCalledTimes(8);
        await native.coordinator.dispose();
    });
});
