import { sync } from '@/sync/sync';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { resolveKokoroOperationTimeoutMs } from '@/voice/kokoro/config/kokoroConfig';
import { speakDeviceText } from '@/voice/local/speakDeviceText';
import { speakGoogleCloudText } from '@/voice/output/GoogleCloudTtsController';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { speakOpenAiCompatText } from '@/voice/output/TtsController';
import { DaemonTtsController } from '@/voice/runtime/daemonInference/DaemonTtsController';
import {
    resolveDaemonVoiceInferenceExecution,
    resolveLocalNeuralExecutionPolicy,
} from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

export type LocalVoiceTtsRequest = Readonly<{
    sessionId?: string | null;
    text: string;
    settings: any;
    tts: VoiceLocalTtsSettings;
    networkTimeoutMs: number;
    registerPlaybackStopper: VoicePlaybackStopperRegistrar;
    onSpeaking: () => void;
    /**
     * Surface a non-fallback TTS synthesis/playback failure to the runtime as a
     * recoverable `tts_failed` machine error (audit Finding 7). Optional so
     * callers that treat TTS as pure best-effort can omit it.
     */
    onTtsFailed?: (error: VoiceMachineError) => void;
}>;

/** True when an error is an abort/interrupt rather than a genuine synth failure. */
function isTtsAbortError(error: unknown): boolean {
    const candidate = error as { name?: unknown; message?: unknown } | null;
    if (candidate?.name === 'AbortError') return true;
    const message = typeof candidate?.message === 'string'
        ? candidate.message
        : typeof error === 'string'
            ? error
            : '';
    return message.includes('aborted') || message.includes('turn_aborted');
}

/** Report a genuine (non-abort) TTS failure as a recoverable `tts_failed` error. */
function reportTtsFailure(ctx: LocalVoiceTtsRequest, error: unknown): void {
    if (isTtsAbortError(error)) {
        return;
    }
    ctx.onTtsFailed?.(createVoiceMachineError({
        kind: 'tts_failed',
        reason: error instanceof Error && error.message ? error.message : 'tts_failed',
    }));
}

export type LocalVoiceTtsProviderId = VoiceLocalTtsSettings['provider'];

export type LocalVoiceTtsProviderController = Readonly<{
    speak: (ctx: LocalVoiceTtsRequest) => Promise<void>;
}>;

export type LocalVoiceTtsController = Readonly<{
    speak: (ctx: LocalVoiceTtsRequest) => Promise<void>;
}>;

function normalizeLocalNeuralTtsSettings(tts: VoiceLocalTtsSettings): Readonly<{
    assetSetId: string | null;
    execution: VoiceLocalTtsSettings['localNeural']['execution'];
    model: string;
    speed: number;
    voiceId: string;
}> {
    const localNeural = (tts.localNeural ?? null) as any;
    return {
        assetSetId: typeof localNeural?.assetId === 'string' && localNeural.assetId.trim() ? localNeural.assetId.trim() : null,
        execution: localNeural?.execution ?? 'auto',
        model: typeof localNeural?.model === 'string' && localNeural.model.trim() ? localNeural.model.trim() : 'kokoro',
        speed: typeof localNeural?.speed === 'number' && Number.isFinite(localNeural.speed) ? localNeural.speed : 1,
        voiceId: typeof localNeural?.voiceId === 'string' && localNeural.voiceId.trim() ? localNeural.voiceId.trim() : 'af_heart',
    };
}

async function speakWithDeviceSpeech(ctx: LocalVoiceTtsRequest): Promise<void> {
    // Bridge the playback stopper to an AbortController. `speakDeviceText` is the
    // single owner of the device speech stop call: it checks the signal before
    // invoking `ExpoSpeech.speak()` and stops the live engine when the signal
    // aborts mid-speech. Keeping the provider stopper signal-only avoids a
    // duplicate ExpoSpeech.stop() call on explicit stop/barge-in.
    const abortController = new AbortController();
    let clearStopper = () => {};
    try {
        clearStopper = ctx.registerPlaybackStopper(() => {
            abortController.abort();
        });
        try {
            // `onSpeaking` fires inside speakDeviceText only after we commit to
            // speaking (and not when the signal is already aborted), so the
            // `speaking` transition happens only once audio actually starts.
            await speakDeviceText(ctx.text, ctx.onSpeaking, { signal: abortController.signal });
        } catch (error) {
            reportTtsFailure(ctx, error);
        }
    } finally {
        clearStopper();
    }
}

async function speakWithLocalNeuralDeviceRuntime(
    ctx: LocalVoiceTtsRequest,
    params: Readonly<{
        assetSetId: string | null;
        speed: number;
        voiceId: string;
    }>,
): Promise<boolean> {
    ctx.onSpeaking();
    return await speakKokoroText({
        text: ctx.text,
        assetSetId: params.assetSetId,
        voiceId: params.voiceId,
        speed: params.speed,
        timeoutMs: resolveKokoroOperationTimeoutMs(ctx.networkTimeoutMs),
        registerPlaybackStopper: ctx.registerPlaybackStopper,
    })
        .then(() => true)
        .catch(() => false);
}

function readDaemonVoiceInferenceErrorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
}

function shouldFallbackFromDaemonLocalNeuralTtsError(error: unknown): boolean {
    const code = readDaemonVoiceInferenceErrorCode(error);
    return code === 'feature_disabled'
        || code === 'machine_unreachable'
        || code === 'runtime_unavailable'
        || code === 'model_not_installed'
        || code === 'request_timeout'
        || code === 'unsupported_codec'
        || code === 'download_failed'
        || code === 'internal_error';
}

function isDaemonLocalNeuralTtsCancelled(error: unknown): boolean {
    return readDaemonVoiceInferenceErrorCode(error) === 'cancelled';
}

type DaemonLocalNeuralTtsAttemptResult = 'ok' | 'fallback' | 'cancelled';

async function speakWithLocalNeuralDaemonRuntime(
    ctx: LocalVoiceTtsRequest,
    params: Readonly<{
        assetSetId: string | null;
        speed: number;
        voiceId: string;
    }>,
): Promise<DaemonLocalNeuralTtsAttemptResult> {
    return await new DaemonTtsController().speak({
        sessionId: ctx.sessionId ?? null,
        text: ctx.text,
        packId: resolveKokoroDaemonTtsPackId(params.assetSetId),
        voiceId: params.voiceId,
        speed: params.speed,
        registerPlaybackStopper: ctx.registerPlaybackStopper,
        onSpeaking: ctx.onSpeaking,
    })
        .then(() => 'ok' as const)
        .catch((error) => {
            if (isDaemonLocalNeuralTtsCancelled(error)) {
                return 'cancelled';
            }
            if (shouldFallbackFromDaemonLocalNeuralTtsError(error)) {
                return 'fallback';
            }
            // Daemon TTS is a best-effort path; if it fails for an unexpected reason
            // (e.g. daemon down, network error, or a non-RPC exception), fall back to
            // device speech instead of bubbling the error to the voice runtime.
            return 'fallback';
        });
}

async function speakWithLocalNeuralTts(ctx: LocalVoiceTtsRequest): Promise<void> {
    const localNeural = normalizeLocalNeuralTtsSettings(ctx.tts);
    if (localNeural.model !== 'kokoro') {
        return;
    }

    const executionPolicy = resolveLocalNeuralExecutionPolicy({
        requestedExecution: localNeural.execution,
    });
    const resolvedExecution = await resolveDaemonVoiceInferenceExecution({
        requestedExecution: localNeural.execution,
        sessionId: ctx.sessionId ?? null,
        surface: 'tts',
    });

    if (resolvedExecution === 'daemon') {
        const attempt = await speakWithLocalNeuralDaemonRuntime(ctx, localNeural);
        if (attempt === 'ok' || attempt === 'cancelled') {
            return;
        }

        if (executionPolicy.allowDeviceSelection) {
            const ok = await speakWithLocalNeuralDeviceRuntime(ctx, localNeural);
            if (ok) {
                return;
            }
        }

        await speakWithDeviceSpeech(ctx);
        return;
    }

    const ok = executionPolicy.preferredExecution === 'device'
        ? await speakWithLocalNeuralDeviceRuntime(ctx, localNeural)
        : false;

    if (ok) {
        return;
    }

    await speakWithDeviceSpeech(ctx);
}

async function speakWithGoogleCloudTts(ctx: LocalVoiceTtsRequest): Promise<void> {
    const googleCloud = (ctx.tts.googleCloud ?? null) as any;
    const apiKey = googleCloud?.apiKey ? (sync.decryptSecretValue(googleCloud.apiKey) ?? null) : null;
    if (!apiKey) {
        return;
    }

    const voiceName = typeof googleCloud?.voiceName === 'string' && googleCloud.voiceName.trim() ? googleCloud.voiceName.trim() : null;
    const languageCode =
        typeof googleCloud?.languageCode === 'string' && googleCloud.languageCode.trim() ? googleCloud.languageCode.trim() : null;
    const androidCertSha1 =
        typeof googleCloud?.androidCertSha1 === 'string' && googleCloud.androidCertSha1.trim()
            ? googleCloud.androidCertSha1.trim()
            : null;
    const format = googleCloud?.format === 'wav' ? 'wav' : 'mp3';
    const speakingRate =
        typeof googleCloud?.speakingRate === 'number' && Number.isFinite(googleCloud.speakingRate) ? googleCloud.speakingRate : null;
    const pitch = typeof googleCloud?.pitch === 'number' && Number.isFinite(googleCloud.pitch) ? googleCloud.pitch : null;

    ctx.onSpeaking();
    await speakGoogleCloudText({
        apiKey,
        androidCertSha1,
        input: ctx.text,
        voiceName,
        languageCode,
        format,
        speakingRate,
        pitch,
        timeoutMs: ctx.networkTimeoutMs,
        registerPlaybackStopper: ctx.registerPlaybackStopper,
    }).catch((error) => reportTtsFailure(ctx, error));
}

async function speakWithOpenAiCompatTts(ctx: LocalVoiceTtsRequest): Promise<void> {
    const baseUrl = String(ctx.tts.openaiCompat.baseUrl ?? '').trim();
    if (!baseUrl) {
        return;
    }
    const apiKey = ctx.tts.openaiCompat.apiKey ? (sync.decryptSecretValue(ctx.tts.openaiCompat.apiKey) ?? null) : null;
    const model = ctx.tts.openaiCompat.model ?? 'tts-1';
    const voice = ctx.tts.openaiCompat.voice ?? 'alloy';
    const format = (ctx.tts.openaiCompat.format ?? 'mp3') as 'mp3' | 'wav';

    ctx.onSpeaking();
    await speakOpenAiCompatText({
        baseUrl,
        apiKey,
        model,
        voice,
        format,
        input: ctx.text,
        timeoutMs: ctx.networkTimeoutMs,
        registerPlaybackStopper: ctx.registerPlaybackStopper,
    }).catch((error) => reportTtsFailure(ctx, error));
}

export function createDefaultLocalVoiceTtsProviderControllers(): Record<LocalVoiceTtsProviderId, LocalVoiceTtsProviderController> {
    return {
        device: { speak: speakWithDeviceSpeech },
        google_cloud: { speak: speakWithGoogleCloudTts },
        local_neural: { speak: speakWithLocalNeuralTts },
        openai_compat: { speak: speakWithOpenAiCompatTts },
    };
}
