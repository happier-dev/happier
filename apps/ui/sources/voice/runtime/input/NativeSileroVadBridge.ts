import type { NativeVadBridge } from './NativeVadController';
import { VOICE_PCM_CONVERSATION_AUDIO_SESSION } from '@/voice/runtime/nativePcmAudioSession';

const VAD_SAMPLE_RATE = 16_000;
const VAD_CHANNELS = 1;
const VAD_FRAME_MS = 20;

type NativePcmFrame = Readonly<{
    pcm16leBase64: string;
    sampleRate: number;
    channels: number;
}>;

type NativePcmCaptureLease = Readonly<{
    release: () => void | Promise<void>;
}>;

export type NativePcmFrameSource = Readonly<{
    acquire: (request: Readonly<{
        ownerId: string;
        format: Readonly<{
            sampleRate: number;
            channels: 1 | 2;
            frameMs: number;
        }>;
        audioSession: typeof VOICE_PCM_CONVERSATION_AUDIO_SESSION;
        onFrame: (frame: NativePcmFrame) => void;
        onError?: (error: unknown) => void;
    }>) => NativePcmCaptureLease | Promise<NativePcmCaptureLease>;
}>;

type FrameFedVadResult = Readonly<{
    speechStarted: boolean;
    speechEnded: boolean;
}>;

type FrameFedSileroVadNativeModule = Readonly<{
    createVadDetector: (params: Readonly<{
        detectorId: string;
        minSpeechMs: number;
        redemptionMs: number;
        sampleRate: number;
    }>) => void | Promise<void>;
    pushVadAudioFrame: (params: Readonly<{
        detectorId: string;
        pcm16leBase64: string;
        sampleRate: number;
        channels: number;
    }>) => FrameFedVadResult | Promise<FrameFedVadResult>;
    cancelVadDetector: (params: Readonly<{
        detectorId: string;
    }>) => void | Promise<void>;
}>;

type ResolveNativeSileroVadBridgeOptions = Readonly<{
    frameSource?: NativePcmFrameSource | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFrameFedSileroVadNativeModule(value: unknown): value is FrameFedSileroVadNativeModule {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.createVadDetector === 'function'
        && typeof value.pushVadAudioFrame === 'function'
        && typeof value.cancelVadDetector === 'function'
    );
}

function isNativePcmFrameSource(value: unknown): value is NativePcmFrameSource {
    return isRecord(value) && typeof value.acquire === 'function';
}

async function getOptionalSherpaNativeModule(): Promise<unknown> {
    try {
        const mod = await import('@happier-dev/sherpa-native') as unknown;
        if (!isRecord(mod)) {
            return null;
        }
        const getter = mod.getOptionalHappierSherpaNativeModule;
        return typeof getter === 'function' ? (getter as () => unknown)() : null;
    } catch {
        return null;
    }
}

async function getOptionalNativePcmFrameSource(): Promise<NativePcmFrameSource | null> {
    try {
        const mod = await import('@happier-dev/audio-stream-native') as unknown;
        if (!isRecord(mod)) {
            return null;
        }
        const getter = mod.getSharedVoicePcmCapture;
        if (typeof getter !== 'function') {
            return null;
        }
        const source = (getter as () => unknown)();
        return isNativePcmFrameSource(source) ? source : null;
    } catch {
        return null;
    }
}

let nextDetectorOrdinal = 1;

export async function resolveNativeSileroVadBridge(
    nativeModule?: unknown,
    options: ResolveNativeSileroVadBridgeOptions = {},
): Promise<NativeVadBridge | null> {
    const resolvedNativeModule = nativeModule === undefined
        ? await getOptionalSherpaNativeModule()
        : nativeModule;
    const frameSource = options.frameSource === undefined
        ? await getOptionalNativePcmFrameSource()
        : options.frameSource;

    if (!isFrameFedSileroVadNativeModule(resolvedNativeModule) || !frameSource) {
        return null;
    }

    return {
        startSession: async ({ minSpeechMs, onSpeechEnd, onSpeechStart, redemptionMs, sessionId }) => {
            const detectorId = `voice-vad:${sessionId}:${nextDetectorOrdinal++}`;
            await resolvedNativeModule.createVadDetector({
                detectorId,
                minSpeechMs,
                redemptionMs,
                sampleRate: VAD_SAMPLE_RATE,
            });

            let stopped = false;
            let speechActive = false;
            let captureLease: NativePcmCaptureLease | null = null;
            let pushTail: Promise<void> = Promise.resolve();

            const cancelDetector = async (): Promise<void> => {
                try {
                    await resolvedNativeModule.cancelVadDetector({ detectorId });
                } catch {
                    // Native detector cleanup is best-effort after ownership has ended.
                }
            };

            const releaseCapture = async (): Promise<void> => {
                const lease = captureLease;
                captureLease = null;
                if (!lease) {
                    return;
                }
                try {
                    await lease.release();
                } catch {
                    // The shared capture owner remains responsible for its own final teardown.
                }
            };

            const stopAfterFrameFailure = (): void => {
                if (stopped) {
                    return;
                }
                stopped = true;
                void releaseCapture();
                void cancelDetector();
            };

            const onFrame = (frame: NativePcmFrame): void => {
                if (stopped || frame.sampleRate !== VAD_SAMPLE_RATE || frame.channels !== VAD_CHANNELS) {
                    return;
                }
                pushTail = pushTail.then(async () => {
                    if (stopped) {
                        return;
                    }
                    const result = await resolvedNativeModule.pushVadAudioFrame({
                        detectorId,
                        pcm16leBase64: frame.pcm16leBase64,
                        sampleRate: frame.sampleRate,
                        channels: frame.channels,
                    });
                    if (stopped) {
                        return;
                    }
                    if (result.speechStarted && !speechActive) {
                        speechActive = true;
                        onSpeechStart?.();
                    }
                    if (result.speechEnded && speechActive) {
                        speechActive = false;
                        onSpeechEnd();
                    }
                }).catch(stopAfterFrameFailure);
            };

            try {
                captureLease = await frameSource.acquire({
                    ownerId: `native-silero-vad:${sessionId}`,
                    format: {
                        sampleRate: VAD_SAMPLE_RATE,
                        channels: VAD_CHANNELS,
                        frameMs: VAD_FRAME_MS,
                    },
                    audioSession: VOICE_PCM_CONVERSATION_AUDIO_SESSION,
                    onFrame,
                    onError: () => stopAfterFrameFailure(),
                });
            } catch (error) {
                stopped = true;
                await cancelDetector();
                throw error;
            }

            return {
                stop: async () => {
                    if (stopped) {
                        return;
                    }
                    stopped = true;
                    await releaseCapture();
                    await pushTail.catch(() => {});
                    await cancelDetector();
                },
            };
        },
    };
}
