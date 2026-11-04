import type { DaemonVoiceInferenceAudioOutput } from '@happier-dev/protocol';

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import {
    createTtsPlaybackController,
    type TtsChunk,
} from '@/voice/output/TtsController';
import { createVoicePlaybackController, type VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import {
    DaemonVoiceInferenceClient,
    type DaemonSegmentedTtsSegment,
    type DaemonSegmentedTtsSession,
} from './DaemonVoiceInferenceClient';
import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';

type SupportedPlaybackFormat = 'wav';

type SupportedDaemonTtsOutput = Extract<DaemonVoiceInferenceAudioOutput, Readonly<{
    codec: SupportedPlaybackFormat;
}>>;

function normalizeDaemonTtsOutput(
    output: Readonly<{ codec?: unknown; mimeType?: unknown }> | null | undefined,
): SupportedDaemonTtsOutput {
    const codec = typeof output?.codec === 'string' ? output.codec : '';
    const mimeType = typeof output?.mimeType === 'string' ? output.mimeType : '';

    if (codec === 'wav') {
        const allowed = new Set(['audio/wav', 'audio/wave', 'audio/x-wav']);
        if (!allowed.has(mimeType)) {
            throw createDaemonVoiceInferenceClientError('unsupported_codec');
        }
        return { codec: 'wav', mimeType: 'audio/wav' };
    }

    throw createDaemonVoiceInferenceClientError('unsupported_codec');
}

function toPlayableAudioFormat(output: DaemonVoiceInferenceAudioOutput): SupportedPlaybackFormat {
    return normalizeDaemonTtsOutput(output).codec;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer;
}

function toDaemonTtsControllerErrorCode(code: string): Parameters<typeof createDaemonVoiceInferenceClientError>[0] {
    switch (code) {
        case 'runtime_unavailable':
        case 'model_not_installed':
        case 'machine_unreachable':
        case 'request_timeout':
        case 'invalid_audio_input':
        case 'unsupported_codec':
        case 'cancelled':
            return code;
        default:
            return 'internal_error';
    }
}

export type DaemonTtsControllerDeps = Readonly<{
    client: Pick<DaemonVoiceInferenceClient, 'startSegmentedTts'>;
    playAudioBytesWithStopper: typeof playAudioBytesWithStopper;
}>;

type DaemonTtsSegmentPayload = Readonly<{
    bytes: ArrayBuffer;
    format: SupportedPlaybackFormat;
    segment: DaemonSegmentedTtsSegment;
}>;

export class DaemonTtsController {
    private readonly deps: DaemonTtsControllerDeps;
    private speakEpoch = 0;

    constructor(deps?: Partial<DaemonTtsControllerDeps>) {
        this.deps = {
            client: new DaemonVoiceInferenceClient(),
            playAudioBytesWithStopper,
            ...deps,
        };
    }

    private async waitForNextOrStop<T>(params: Readonly<{
        signal: AbortSignal;
        next: () => Promise<T>;
        producerTermination: Promise<null>;
    }>): Promise<T | null> {
        const { signal } = params;
        if (signal.aborted) {
            return null;
        }
        let abortListener!: () => void;
        const aborted = new Promise<null>((resolve) => {
            abortListener = () => resolve(null);
            signal.addEventListener('abort', abortListener, { once: true });
        });
        try {
            return await Promise.race([
                params.next(),
                aborted,
                params.producerTermination,
            ]);
        } finally {
            signal.removeEventListener('abort', abortListener);
        }
    }

    async speak(params: Readonly<{
        sessionId?: string | null;
        text: string;
        packId: string | null;
        voiceId: string | null;
        speed: number | null;
        registerPlaybackStopper: VoicePlaybackStopperRegistrar;
        onSpeaking: () => void;
        output?: DaemonVoiceInferenceAudioOutput | null;
        signal?: AbortSignal | null;
    }>): Promise<void> {
        if (params.signal?.aborted) {
            return;
        }
        const abortController = new AbortController();
        const abortListener = () => abortController.abort();
        if (params.signal) {
            params.signal.addEventListener('abort', abortListener, { once: true });
            if (params.signal.aborted) {
                abortController.abort();
            }
        }

        const playback = createVoicePlaybackController();
        const registerPlaybackOnly = playback.registerStopper.captureAttempt?.() ?? playback.registerStopper;
        let clearStopper = () => {};
        const stopActivePlayback = () => playback.interrupt();
        abortController.signal.addEventListener('abort', stopActivePlayback);

        try {
            if (abortController.signal.aborted) {
                return;
            }
            clearStopper = params.registerPlaybackStopper(() => {
                abortController.abort();
            });

            if (abortController.signal.aborted) {
                return;
            }

            let speakingNotified = false;
            const notifySpeakingOnce = () => {
                if (speakingNotified) {
                    return;
                }
                speakingNotified = true;
                params.onSpeaking();
            };

            const requestedOutput = params.output ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec;
            const normalizedOutput = normalizeDaemonTtsOutput(requestedOutput);
            await this.speakSegmented({
                sessionId: params.sessionId ?? null,
                text: params.text,
                packId: params.packId,
                voiceId: params.voiceId,
                speed: params.speed,
                output: normalizedOutput,
                registerPlaybackOnly,
                stopActivePlayback,
                onSpeaking: notifySpeakingOnce,
                abortController,
                startSegmentedTts: this.deps.client.startSegmentedTts.bind(this.deps.client),
            });
        } finally {
            params.signal?.removeEventListener('abort', abortListener);
            abortController.signal.removeEventListener('abort', stopActivePlayback);
            clearStopper();
        }
    }

    private async speakSegmented(params: Readonly<{
        sessionId: string | null;
        text: string;
        packId: string | null;
        voiceId: string | null;
        speed: number | null;
        output: SupportedDaemonTtsOutput;
        registerPlaybackOnly: VoicePlaybackStopperRegistrar;
        stopActivePlayback: () => void;
        onSpeaking: () => void;
        abortController: AbortController;
        startSegmentedTts: DaemonTtsControllerDeps['client']['startSegmentedTts'];
    }>): Promise<void> {
        const epoch = ++this.speakEpoch;
        let stream: DaemonSegmentedTtsSession | null = null;
        let abortObserved = params.abortController.signal.aborted;
        let cancelDelivery: Promise<void> | null = null;
        let abortPlayback: (() => void) | null = null;
        const playbackOutcome: { failure?: Readonly<{ error: unknown }> } = {};
        const maxResidentSegments = 2;
        let producerTerminated = false;
        let resolveProducerTermination!: () => void;
        const producerTermination = new Promise<null>((resolve) => {
            resolveProducerTermination = () => resolve(null);
        });
        const residentSegmentIds = new Set<string>();
        const residencyWaiters = new Set<() => void>();
        const wakeResidencyWaiters = () => {
            const waiters = [...residencyWaiters];
            residencyWaiters.clear();
            for (const resolve of waiters) resolve();
        };
        const releaseResidentSegment = (segmentId: string) => {
            if (!residentSegmentIds.delete(segmentId)) {
                return;
            }
            wakeResidencyWaiters();
        };
        const terminateProducer = () => {
            if (producerTerminated) {
                return;
            }
            producerTerminated = true;
            resolveProducerTermination();
            residentSegmentIds.clear();
            wakeResidencyWaiters();
        };
        const cancelDeliveredStream = (): Promise<void> => {
            const activeStream = stream;
            if (!activeStream) {
                return Promise.resolve();
            }
            cancelDelivery ??= Promise.resolve()
                .then(async () => await activeStream.cancel())
                .catch(() => undefined);
            return cancelDelivery;
        };
        const waitForResidencySlot = async (): Promise<boolean> => {
            while (
                residentSegmentIds.size >= maxResidentSegments
                && !producerTerminated
                && !params.abortController.signal.aborted
            ) {
                await new Promise<void>((resolve) => residencyWaiters.add(resolve));
            }
            return !producerTerminated && !params.abortController.signal.aborted;
        };

        const playbackController = createTtsPlaybackController<DaemonTtsSegmentPayload>({
            playChunk: async (chunk) => {
                try {
                    await this.deps.playAudioBytesWithStopper({
                        bytes: chunk.bytes,
                        format: chunk.format,
                        registerPlaybackStopper: params.registerPlaybackOnly,
                        onPlaybackStarted: params.onSpeaking,
                    });
                } finally {
                    // Local playback completion releases residency immediately;
                    // the remote acknowledgement must never hold the next ready segment.
                    releaseResidentSegment(chunk.segment.segmentId);
                }
            },
            confirmPlayback: async (chunk) => {
                if (this.speakEpoch !== epoch || abortObserved || params.abortController.signal.aborted) {
                    return;
                }
                await stream?.ackSegment(chunk.segment);
            },
            onPlaybackError: async (_chunk, error) => {
                terminateProducer();
                if (this.speakEpoch !== epoch || abortObserved || params.abortController.signal.aborted) {
                    return;
                }
                playbackOutcome.failure ??= { error };
                abortPlayback?.();
                await cancelDeliveredStream();
            },
            onConfirmationError: async (_chunk, error) => {
                terminateProducer();
                params.stopActivePlayback();
                if (this.speakEpoch !== epoch || abortObserved || params.abortController.signal.aborted) {
                    return;
                }
                playbackOutcome.failure ??= { error };
                abortPlayback?.();
                await cancelDeliveredStream();
            },
            prefetchDepth: 2,
        });
        const playback = playbackController.speak();
        abortPlayback = playback.abort;
        const abortListener = () => {
            abortObserved = true;
            terminateProducer();
            playback.abort();
            void cancelDeliveredStream();
        };
        params.abortController.signal.addEventListener('abort', abortListener, { once: true });

        try {
            stream = await params.startSegmentedTts({
                sessionId: params.sessionId,
                text: params.text,
                packId: params.packId,
                voiceId: params.voiceId,
                speed: params.speed,
                output: params.output,
                signal: params.abortController.signal,
            });
            if (abortObserved || params.abortController.signal.aborted) {
                abortObserved = true;
                await cancelDeliveredStream();
                await playback.done;
                return;
            }
            let receivedSegments = 0;
            while (
                this.speakEpoch === epoch
                && !producerTerminated
                && !params.abortController.signal.aborted
                && receivedSegments < stream.segmentCount
            ) {
                if (!await waitForResidencySlot()) {
                    break;
                }
                const event = await this.waitForNextOrStop({
                    signal: params.abortController.signal,
                    next: () => stream!.next(),
                    producerTermination,
                });
                if (
                    !event
                    || producerTerminated
                    || this.speakEpoch !== epoch
                    || params.abortController.signal.aborted
                ) {
                    break;
                }
                if (event.type === 'done') {
                    break;
                }
                if (event.type === 'error') {
                    throw createDaemonVoiceInferenceClientError(
                        toDaemonTtsControllerErrorCode(event.errorCode),
                        event.error,
                    );
                }
                receivedSegments += 1;
                residentSegmentIds.add(event.segmentId);
                const chunk: TtsChunk<DaemonTtsSegmentPayload> = {
                    groupId: stream.streamId,
                    chunkIndex: event.segmentIndex,
                    isLastChunk: event.isLastSegment,
                    bytes: toExactArrayBuffer(event.bytes),
                    format: toPlayableAudioFormat(event.output),
                    segment: event,
                };
                playbackController.enqueue(chunk);
            }
            await playback.done;
            if (playbackOutcome.failure) {
                throw playbackOutcome.failure.error;
            }
        } catch (error) {
            terminateProducer();
            params.stopActivePlayback();
            playback.abort();
            await cancelDeliveredStream();
            throw error;
        } finally {
            params.abortController.signal.removeEventListener('abort', abortListener);
            if (abortObserved || params.abortController.signal.aborted) {
                abortObserved = true;
                await cancelDeliveredStream();
            }
        }
    }
}
