import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { resolveKokoroOperationTimeoutMs } from '@/voice/kokoro/config/kokoroConfig';
import { speakDeviceText } from '@/voice/local/speakDeviceText';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { DaemonTtsController } from '@/voice/runtime/daemonInference/DaemonTtsController';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

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
     * recoverable `tts_failed` machine error. Callers that omit the callback
     * receive the same typed fields on the rejected error.
     */
    onTtsFailed?: (error: VoiceMachineError) => void;
}>;

/** True when an error is an abort/interrupt rather than a genuine synth failure. */
function isTtsAbortError(error: unknown): boolean {
    const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null;
    if (candidate?.code === 'cancelled') return true;
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
    const machineError = createVoiceMachineError({
        kind: 'tts_failed',
        reason: error instanceof Error && error.message ? error.message : 'tts_failed',
    });
    if (ctx.onTtsFailed) {
        ctx.onTtsFailed(machineError);
        return;
    }
    throw Object.assign(new Error(machineError.reason), machineError);
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
    voiceId: string | null;
}> {
    const localNeural = (tts.localNeural ?? null) as any;
    return {
        assetSetId: typeof localNeural?.assetId === 'string' && localNeural.assetId.trim() ? localNeural.assetId.trim() : null,
        execution: localNeural?.execution ?? 'auto',
        model: typeof localNeural?.model === 'string' && localNeural.model.trim() ? localNeural.model.trim() : 'kokoro',
        speed: typeof localNeural?.speed === 'number' && Number.isFinite(localNeural.speed) ? localNeural.speed : 1,
        voiceId: typeof localNeural?.voiceId === 'string' && localNeural.voiceId.trim() ? localNeural.voiceId.trim() : null,
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
            // `onSpeaking` fires from Expo Speech's actual playback-start event.
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
        voiceId: string | null;
    }>,
): Promise<void> {
    try {
        await speakKokoroText({
            text: ctx.text,
            assetSetId: params.assetSetId,
            voiceId: params.voiceId ?? 'af_heart',
            speed: params.speed,
            timeoutMs: resolveKokoroOperationTimeoutMs(ctx.networkTimeoutMs),
            registerPlaybackStopper: ctx.registerPlaybackStopper,
            onPlaybackStarted: ctx.onSpeaking,
        });
    } catch (error) {
        reportTtsFailure(ctx, error);
    }
}

async function speakWithLocalNeuralDaemonRuntime(
    ctx: LocalVoiceTtsRequest,
    params: Readonly<{
        assetSetId: string | null;
        speed: number;
        voiceId: string | null;
    }>,
): Promise<void> {
    try {
        await new DaemonTtsController().speak({
            sessionId: ctx.sessionId ?? null,
            text: ctx.text,
            packId: resolveKokoroDaemonTtsPackId(params.assetSetId),
            voiceId: params.voiceId,
            speed: params.speed,
            registerPlaybackStopper: ctx.registerPlaybackStopper,
            onSpeaking: ctx.onSpeaking,
        });
    } catch (error) {
        reportTtsFailure(ctx, error);
    }
}

async function speakWithLocalNeuralTts(ctx: LocalVoiceTtsRequest): Promise<void> {
    const localNeural = normalizeLocalNeuralTtsSettings(ctx.tts);
    if (localNeural.model !== 'kokoro') {
        reportTtsFailure(ctx, new Error('local_neural_tts_model_unavailable'));
        return;
    }

    let resolvedExecution: 'device' | 'daemon';
    try {
        resolvedExecution = await resolveDaemonVoiceInferenceExecution({
            requestedExecution: localNeural.execution,
            sessionId: ctx.sessionId ?? null,
            surface: 'tts',
        });
    } catch (error) {
        reportTtsFailure(ctx, error);
        return;
    }

    if (resolvedExecution === 'daemon') {
        await speakWithLocalNeuralDaemonRuntime(ctx, localNeural);
        return;
    }

    await speakWithLocalNeuralDeviceRuntime(ctx, localNeural);
}

export async function speakWithBundledSpeechTts(
    providerId: string,
    ctx: LocalVoiceTtsRequest,
): Promise<boolean> {
    // Loading the complete first-party registry while the built-in TTS controller
    // module initializes creates a registry -> runtime -> TTS cycle. Resolve the
    // optional bundled leaf only when a selected non-built-in provider is used.
    const [registryModule, runtimeModule, descriptorModule] = await Promise.all([
        import('@/voice/registry/defaultRegistry'),
        import('@/voice/runtime/bundledSpeech/bundledSpeechRuntime'),
        import('@/voice/settings/panels/bundledSpeech/descriptor'),
    ]);
    const registry = registryModule.createDefaultVoiceProviderRegistry();
    const contribution = registry.get(providerId);
    if (
        !contribution
        || contribution.source.kind === 'built_in'
        || contribution.kind !== 'voice.speech-engine.v1'
        || (contribution.role !== 'tts' && contribution.role !== 'both')
    ) {
        return false;
    }
    const descriptor = descriptorModule.readBundledSpeechSettingsDescriptorFromEntry(
        providerId,
        contribution,
    );
    if (!descriptor || (descriptor.role !== 'tts' && descriptor.role !== 'both')) return false;
    const runtime = runtimeModule.createBundledSpeechRuntime({ registry });
    await runtime.speak(providerId, {
        text: ctx.text,
        providerConfig: readVoiceProviderSettingsConfig(
            voiceSettingsParse(ctx.settings?.voice),
            providerId,
        ),
        registerPlaybackStopper: ctx.registerPlaybackStopper,
        onPlaybackStarted: ctx.onSpeaking,
    }).catch((error) => reportTtsFailure(ctx, error));
    return true;
}

export function createDefaultLocalVoiceTtsProviderControllers(): ReadonlyMap<string, LocalVoiceTtsProviderController> {
    const entries: Array<readonly [string, LocalVoiceTtsProviderController]> = [
        ['device', { speak: speakWithDeviceSpeech }],
        ['local_neural', { speak: speakWithLocalNeuralTts }],
    ];
    return new Map(entries);
}
