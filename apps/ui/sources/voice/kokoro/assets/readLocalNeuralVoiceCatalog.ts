import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { resolveDaemonTtsVoiceSelection } from '@/voice/settings/panels/localTts/resolveDaemonTtsVoiceSelection';
import { resolveKokoroDaemonTtsPackId } from './resolveKokoroDaemonTtsPackId';
import { readInstalledKokoroVoices } from './readInstalledKokoroVoices';

/** One selected-pack catalog for Work and Session playback, using the existing device/daemon owners. */
export async function readLocalNeuralVoiceCatalog(input: Readonly<{
  config: VoiceLocalTtsSettings['localNeural'];
  sessionId?: string | null;
  originMachineId?: string | null;
  resolvedExecution?: 'device' | 'daemon';
}>) {
  if (input.config.model !== 'kokoro') throw new Error('local_neural_tts_model_unavailable');
  const execution = input.resolvedExecution ?? await resolveDaemonVoiceInferenceExecution({
    requestedExecution: input.config.execution, sessionId: input.sessionId, surface: 'tts',
  });
  const packId = resolveKokoroDaemonTtsPackId(input.config.assetId);
  const selection = execution === 'daemon'
    ? resolveDaemonTtsVoiceSelection({ packId, configuredVoiceId: input.config.voiceId,
      statuses: await new DaemonVoiceInferenceClient().getModelsStatus([packId],
        input.originMachineId ? { machineId: input.originMachineId } : undefined) })
    : null;
  const voices = selection?.voices ?? await readInstalledKokoroVoices({ packId });
  return { execution, rows: voices.map(voice => ({ id: voice.id, name: voice.title,
    ...(voice.subtitle ? { subtitle: voice.subtitle } : {}) })) };
}
