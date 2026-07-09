import type { DaemonVoiceInferenceAudioOutput } from '@happier-dev/protocol';

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import {
    createTtsPlaybackController,
    type TtsChunk,
} from '@/voice/output/TtsController';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import {
    DaemonVoiceInferenceClient,
    type DaemonSegmentedTtsSegment,
    type DaemonSegmentedTtsSession,
} from './DaemonVoiceInferenceClient';
import { recordDaemonVoiceInferenceTtsLatencySample } from './daemonVoiceInferencePolicy';
import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';

type SupportedPlaybackFormat = 'mp3' | 'wav';

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

    if (codec === 'mp3') {
        const allowed = new Set(['audio/mpeg', 'audio/mp3']);
        if (!allowed.has(mimeType)) {
            throw createDaemonVoiceInferenceClientError('unsupported_codec');
        }
        return { codec: 'mp3', mimeType: 'audio/mpeg' };
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
    client: Pick<DaemonVoiceInferenceClient, 'synthesizeText'> & Partial<Pick<DaemonVoiceInferenceClient, 'startSegmentedTts'>>;
    playAudioBytesWithStopper: typeof playAudioBytesWithStopper;
    now: () => number;
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
            now: () => Date.now(),
            ...deps,
        };
    }

    private waitForAbort(signal: AbortSignal): Promise<null> {
        if (signal.aborted) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(null), { once: true });
        });
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
        const abortController = new AbortController();
        const abortListener = () => abortController.abort();
        if (params.signal) {
            params.signal.addEventListener('abort', abortListener, { once: true });
        }

        let stopPlayback: (() => void) | null = null;
        let clearStopper = () => {};

        try {
            clearStopper = params.registerPlaybackStopper(() => {
                abortController.abort();
                try {
                    stopPlayback?.();
                } catch {
                    // ignore
                }
            });

            const registerPlaybackOnly: VoicePlaybackStopperRegistrar = (stopper) => {
                stopPlayback = stopper;
                return () => {
                    if (stopPlayback === stopper) {
                        stopPlayback = null;
                    }
                };
            };

            let speakingNotified = false;
            const notifySpeakingOnce = () => {
                if (speakingNotified) {
                    return;
                }
                speakingNotified = true;
                params.onSpeaking();
            };

            const synthesisStartedAtMs = this.deps.now();
            const requestedOutput = params.output ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec;
            const normalizedOutput = normalizeDaemonTtsOutput(requestedOutput);
            const startSegmentedTts = this.deps.client.startSegmentedTts;
            if (typeof startSegmentedTts === 'function') {
                await this.speakSegmented({
                    sessionId: params.sessionId ?? null,
                    text: params.text,
                    packId: params.packId,
                    voiceId: params.voiceId,
                    speed: params.speed,
                    output: normalizedOutput,
                    registerPlaybackOnly,
                    onSpeaking: notifySpeakingOnce,
                    abortController,
                    synthesisStartedAtMs,
                    startSegmentedTts,
                });
                return;
            }

            const synthesized = await this.deps.client.synthesizeText({
                sessionId: params.sessionId ?? null,
                text: params.text,
                packId: params.packId,
                voiceId: params.voiceId,
                speed: params.speed,
                output: normalizedOutput,
                signal: abortController.signal,
            });
            recordDaemonVoiceInferenceTtsLatencySample({
                sessionId: params.sessionId ?? null,
                elapsedMs: this.deps.now() - synthesisStartedAtMs,
            });

            await this.deps.playAudioBytesWithStopper({
                bytes: toExactArrayBuffer(synthesized.bytes),
                format: toPlayableAudioFormat(synthesized.output),
                registerPlaybackStopper: registerPlaybackOnly,
                onPlaybackStarted: notifySpeakingOnce,
            });
        } finally {
            params.signal?.removeEventListener('abort', abortListener);
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
        onSpeaking: () => void;
        abortController: AbortController;
        synthesisStartedAtMs: number;
        startSegmentedTts: NonNullable<DaemonTtsControllerDeps['client']['startSegmentedTts']>;
    }>): Promise<void> {
        const epoch = ++this.speakEpoch;
        let stream: DaemonSegmentedTtsSession | null = null;
        let firstSegmentRecorded = false;
        let cancelRequested = false;
        let abortPlayback: (() => void) | null = null;

        const playbackController = createTtsPlaybackController<DaemonTtsSegmentPayload>({
            playChunk: async (chunk) => {
                await this.deps.playAudioBytesWithStopper({
                    bytes: chunk.bytes,
                    format: chunk.format,
                    registerPlaybackStopper: params.registerPlaybackOnly,
                    onPlaybackStarted: params.onSpeaking,
                });
            },
            confirmPlayback: async (chunk) => {
                if (this.speakEpoch !== epoch || params.abortController.signal.aborted) {
                    return;
                }
                await stream?.ackSegment(chunk.segment);
            },
            onPlaybackError: async () => {
                if (this.speakEpoch !== epoch || params.abortController.signal.aborted || cancelRequested) {
                    return;
                }
                cancelRequested = true;
                abortPlayback?.();
                await stream?.cancel().catch(() => undefined);
            },
            prefetchDepth: 2,
        });
        const playback = playbackController.speak();
        abortPlayback = playback.abort;
        const abortListener = () => {
            playback.abort();
            if (!cancelRequested) {
                cancelRequested = true;
                void stream?.cancel();
            }
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
            let receivedSegments = 0;
            while (
                this.speakEpoch === epoch
                && !params.abortController.signal.aborted
                && receivedSegments < stream.segmentCount
            ) {
                const event = await Promise.race([
                    stream.next(),
                    this.waitForAbort(params.abortController.signal),
                ]);
                if (!event || this.speakEpoch !== epoch || params.abortController.signal.aborted) {
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
                if (!firstSegmentRecorded) {
                    firstSegmentRecorded = true;
                    recordDaemonVoiceInferenceTtsLatencySample({
                        sessionId: params.sessionId,
                        elapsedMs: this.deps.now() - params.synthesisStartedAtMs,
                    });
                }
                receivedSegments += 1;
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
        } finally {
            params.abortController.signal.removeEventListener('abort', abortListener);
            if (params.abortController.signal.aborted && !cancelRequested) {
                cancelRequested = true;
                await stream?.cancel().catch(() => undefined);
            }
        }
    }
}
