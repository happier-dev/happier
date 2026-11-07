import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { useVoiceExecutionMachineSelection } from '@/voice/credentials/useExecutionMachinePresentation';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';

/** Observe the speech roles admission selects, independently of the conversation service. */
export function useSelectedVoiceSpeechModelCatalog(voice: VoiceSettings, options: Readonly<{
    purpose: 'conversation' | 'dictation';
    probeMachine: boolean;
}>) {
    const executionMachine = useVoiceExecutionMachineSelection();
    const speechVoice = options.purpose === 'dictation'
        ? createVoiceDictationRuntimeSettingsSnapshot({ voice }).voice : voice;
    const { config } = resolveLocalVoiceAdapterSettingsFromVoice(speechVoice);
    const activeLocalStt = parseLocalVoiceSttSettings(config.stt);
    const activeLocalTts = parseLocalVoiceTtsSettings(config.tts);
    const requiresDaemonSttModel = activeLocalStt.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: activeLocalStt.localNeural.execution }).preferredExecution === 'daemon';
    const requiresDaemonTtsModel = options.purpose === 'conversation' && activeLocalTts.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: activeLocalTts.localNeural.execution }).preferredExecution === 'daemon';
    const daemonModelCatalog = useDaemonVoiceModelCatalogState({
        enabled: options.probeMachine && (requiresDaemonSttModel || requiresDaemonTtsModel),
        refreshKey: executionMachine.machineId,
    });
    return { executionMachine, activeLocalStt, activeLocalTts, requiresDaemonSttModel, requiresDaemonTtsModel, daemonModelCatalog };
}
