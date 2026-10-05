import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { DaemonTtsController } from '@/voice/runtime/daemonInference/DaemonTtsController';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/** The same settings sample playback owner serves Test, the native voice picker and Actions. */
export async function previewLocalNeuralTts(input: Readonly<{
    config: VoiceLocalTtsSettings['localNeural'];
    sample: string;
    timeoutMs: number;
    registerPlaybackStopper: VoicePlaybackStopperRegistrar;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<void> {
    const execution = await resolveDaemonVoiceInferenceExecution({ requestedExecution: input.config.execution, surface: 'tts' });
    throwIfAborted(input.signal);
    if (input.isCurrent?.() === false) throw new Error('voice_preview_retired');
    if (execution === 'daemon') {
        await new DaemonTtsController().speak({ text: input.sample,
            packId: resolveKokoroDaemonTtsPackId(input.config.assetId), voiceId: input.config.voiceId,
            speed: input.config.speed ?? 1, registerPlaybackStopper: input.registerPlaybackStopper, onSpeaking: () => {} });
        return;
    }
    await speakKokoroText({ text: input.sample, assetSetId: input.config.assetId, voiceId: input.config.voiceId,
        speed: input.config.speed ?? 1, timeoutMs: input.timeoutMs, registerPlaybackStopper: input.registerPlaybackStopper });
}
