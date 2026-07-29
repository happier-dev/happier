import {
    parseLocalVoiceSttSettings,
    resolveLocalSttProvider,
    resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import {
    resolveLocalNeuralExecutionPolicy,
} from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';

import type {
    LocalNeuralCaptureExecution,
    LocalVoiceCaptureProvider,
} from './LocalVoiceCaptureOwner';

export type VoiceSttCapturePlan = Readonly<{
    provider: LocalVoiceCaptureProvider;
    localNeuralExecution?: LocalNeuralCaptureExecution;
}>;

/**
 * Canonical bridge from the selected STT setting to the capture owner.
 * Streaming-capable providers capture text directly; all other providers
 * record one bounded utterance for the provider-neutral transcription owner.
 */
export function resolveVoiceSttCapturePlan(settings: any): VoiceSttCapturePlan {
    const sttProvider = resolveLocalSttProvider(settings);
    if (sttProvider === 'device') {
        return { provider: 'device' };
    }
    if (sttProvider === 'local_neural') {
        const { config } = resolveLocalVoiceAdapterSettings(settings);
        const stt = parseLocalVoiceSttSettings(config?.stt);
        const policy = resolveLocalNeuralExecutionPolicy({
            requestedExecution: stt.localNeural.execution,
        });
        return {
            provider: 'local_neural',
            localNeuralExecution: policy.preferredExecution,
        };
    }
    return { provider: 'recorded_audio' };
}
