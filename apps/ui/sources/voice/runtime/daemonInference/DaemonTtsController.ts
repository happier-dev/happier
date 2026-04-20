import type { DaemonVoiceInferenceAudioOutput } from '@happier-dev/protocol';

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import { DaemonVoiceInferenceClient } from './DaemonVoiceInferenceClient';
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

export type DaemonTtsControllerDeps = Readonly<{
    client: Pick<DaemonVoiceInferenceClient, 'synthesizeText'>;
    playAudioBytesWithStopper: typeof playAudioBytesWithStopper;
    now: () => number;
}>;

export class DaemonTtsController {
    private readonly deps: DaemonTtsControllerDeps;

    constructor(deps?: Partial<DaemonTtsControllerDeps>) {
        this.deps = {
            client: new DaemonVoiceInferenceClient(),
            playAudioBytesWithStopper,
            now: () => Date.now(),
            ...deps,
        };
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

            params.onSpeaking();
            const synthesisStartedAtMs = this.deps.now();
            const requestedOutput = params.output ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec;
            const synthesized = await this.deps.client.synthesizeText({
                sessionId: params.sessionId ?? null,
                text: params.text,
                packId: params.packId,
                voiceId: params.voiceId,
                speed: params.speed,
                output: normalizeDaemonTtsOutput(requestedOutput),
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
            });
        } finally {
            params.signal?.removeEventListener('abort', abortListener);
            clearStopper();
        }
    }
}
