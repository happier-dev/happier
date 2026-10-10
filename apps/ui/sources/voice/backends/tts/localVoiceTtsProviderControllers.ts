import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { readLocalNeuralVoiceCatalog } from '@/voice/kokoro/assets/readLocalNeuralVoiceCatalog';
import { resolveSessionVoicePreference } from '@/voice/settings/resolveSessionVoicePreference';
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
import { storage } from '@/sync/domains/state/storage';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areSessionAddressesEqual } from '@/sync/domains/session/sessionAddress';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION, BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, readSessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { getVoiceSessionAttemptId } from '@/voice/session/voiceSessionStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { isCapturedVoiceExecutionMachineCurrent, resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';
import type { BundledSpeechPreparation } from '@/voice/runtime/bundledSpeech/bundledSpeechRuntime';

export type LocalVoiceTtsRequest = Readonly<{
    sessionId?: string | null;
    text: string;
    settings: Readonly<Pick<Settings, 'voice'>>;
    preparation?: BundledSpeechPreparation;
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
export function reportTtsFailure(ctx: LocalVoiceTtsRequest, error: unknown): void {
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
    sessionVoiceProviderId?: string;
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
    const localNeural = tts.localNeural;
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
            voiceId: params.voiceId,
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
    const preparation = ctx.preparation;
    const originMachineId = resolveVoiceExecutionMachineId();
    const current = () => (!preparation || preparation.isCurrent())
        && isCapturedVoiceExecutionMachineCurrent(originMachineId);
    if (!current()) return;
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

    let selectedVoiceId = localNeural.voiceId;
    let selectedName = selectedVoiceId;
    if (preparation?.preference) {
        try {
            const catalog = await readLocalNeuralVoiceCatalog({ config: ctx.tts.localNeural,
                sessionId: ctx.sessionId, originMachineId, resolvedExecution });
            if (!current()) return;
            const selected = resolveSessionVoicePreference({
                providerContributionId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID,
                declaration: BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION,
                providerConfig: { voiceId: localNeural.voiceId },
                preference: preparation.preference, catalog: catalog.rows,
            });
            if (selected.kind === 'unavailable') {
                reportTtsFailure(ctx, new Error(selected.reason));
                return;
            }
            const value = selected.providerConfig;
            selectedVoiceId = value && typeof value === 'object' && !Array.isArray(value)
                && typeof value.voiceId === 'string' ? value.voiceId : null;
            selectedName = selected.inUseVoice?.displayName ?? selectedVoiceId;
        } catch (error) {
            reportTtsFailure(ctx, error);
            return;
        }
    }
    if (!current()) return;
    const playbackRequest: LocalVoiceTtsRequest = { ...ctx, onSpeaking: () => {
        if (!current()) return;
        // Both engines fire this only after accepting the exact requested voice and starting audio.
        preparation?.onVoiceApplied?.(selectedVoiceId ? {
            providerContributionId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, settingFieldPath: 'voiceId',
            value: selectedVoiceId, displayName: selectedName ?? selectedVoiceId,
        } : null);
        ctx.onSpeaking();
    } };
    const selection = { ...localNeural, voiceId: selectedVoiceId };
    if (resolvedExecution === 'daemon') {
        await speakWithLocalNeuralDaemonRuntime(playbackRequest, selection);
        return;
    }

    await speakWithLocalNeuralDeviceRuntime(playbackRequest, selection);
}

export function prepareLocalVoiceTtsRequest(ctx: LocalVoiceTtsRequest): BundledSpeechPreparation | null {
    const accountLifetime = captureActiveServerAccountScopeCurrentness();
    const serverId = getAppliedActiveServerSnapshot().serverId;
    const attemptId = getVoiceSessionAttemptId();
    const resolveBinding = () => ctx.sessionId
        ? voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: ctx.sessionId })
            ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: ctx.sessionId })
        : null;
    const binding = resolveBinding();
    const target = binding?.targetSessionAddress ?? null;
    const metadata = target ? readVoiceSessionOwnerMetadataFromState(storage.getState(), target, { activeServerId: serverId }) : null;
    const preference = readSessionVoicePreferenceV1(metadata?.work?.voicePreference);
    const isCurrent = () => {
        if (!accountLifetime.isCurrent() || getVoiceSessionAttemptId() !== attemptId
            || !areServerProfileIdentifiersEquivalent(serverId, getAppliedActiveServerSnapshot().serverId)) return false;
        const current = resolveBinding();
        if (!binding) return current === null;
        return current?.controlSessionId === binding.controlSessionId
            && current.conversationSessionId === binding.conversationSessionId
            && current.updatedAt === binding.updatedAt
            && areSessionAddressesEqual(current.conversationSessionAddress, binding.conversationSessionAddress)
            && (target === null ? current.targetSessionAddress === null : areSessionAddressesEqual(current.targetSessionAddress, target))
            && (!target || metadata === null || readVoiceSessionOwnerMetadataFromState(storage.getState(), target, { activeServerId: serverId }) !== null);
    };
    if (!isCurrent()) return null;
    // The incumbent speech Machine chooser is Home-local. An inactive Home's
    // retained Session cannot authorize speech on the active Home's daemon.
    if (target && (!metadata || !areServerProfileIdentifiersEquivalent(target.serverId, serverId))) {
        reportTtsFailure(ctx, new Error('session_metadata_unavailable'));
        return null;
    }
    return Object.freeze({
        targetSessionAddress: target, preference, isCurrent,
        onVoiceApplied: inUseVoice => {
            if (!isCurrent() || !ctx.sessionId) return;
            voiceConversationRuntimeMachine.setInUseVoice({ controlSessionId: binding?.controlSessionId ?? ctx.sessionId, inUseVoice });
        },
    } satisfies BundledSpeechPreparation);
}

export async function speakWithBundledSpeechTts(
    providerId: string,
    ctx: LocalVoiceTtsRequest,
    preparation?: BundledSpeechPreparation,
): Promise<boolean> {
    const prepared = preparation ?? prepareLocalVoiceTtsRequest(ctx);
    if (!prepared) return true;
    const originMachineId = resolveVoiceExecutionMachineId();
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
    if (!prepared.isCurrent()) return true;
    const runtime = runtimeModule.createBundledSpeechRuntime({ registry });
    await runtime.speak(providerId, {
        text: ctx.text,
        providerConfig: readVoiceProviderSettingsConfig(
            voiceSettingsParse(ctx.settings?.voice),
            providerId,
        ),
        preparation: prepared,
        originMachineId,
        registerPlaybackStopper: ctx.registerPlaybackStopper,
        onPlaybackStarted: ctx.onSpeaking,
    }).catch((error) => reportTtsFailure(ctx, error));
    return true;
}

export function createDefaultLocalVoiceTtsProviderControllers(): ReadonlyMap<string, LocalVoiceTtsProviderController> {
    const entries: Array<readonly [string, LocalVoiceTtsProviderController]> = [
        ['device', { speak: speakWithDeviceSpeech }],
        ['local_neural', { speak: speakWithLocalNeuralTts, sessionVoiceProviderId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID }],
    ];
    return new Map(entries);
}
