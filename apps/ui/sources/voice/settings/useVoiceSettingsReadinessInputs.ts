import * as React from 'react';

import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useVoiceExecutionMachineSelection } from '@/voice/credentials/useExecutionMachinePresentation';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import {
  resolveVoiceDaemonModelAvailabilityFromCatalogState,
  resolveVoiceDaemonModelKindAvailabilityFromCatalogState,
  resolveVoiceDaemonRouteDiagnosticReason,
  useVoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';

/**
 * What the Voice readiness models are computed from:
 * server support, the execution machine, the daemon model catalog and this device's speech
 * availability. Hub, Dictation, Conversations and setup share the same observation;
 * each purpose projects only its selected speech roles.
 *
 * `probeMachine: false` keeps a surface passive (Home's setup tile, a hub): the daemon model catalog
 * is not asked. It observes the catalog owner's established facts for this Account and machine,
 * or remains unknown when none exist. The open setup panel and Conversations page pass `true`.
 */
export function useVoiceSettingsReadinessInputs(voice: VoiceSettings, options: Readonly<{
  probeMachine: boolean;
  purpose: 'conversation' | 'dictation';
}>) {
  const happierVoiceSupported = useHappierVoiceSupport();
  const providerId = resolveVoiceProviderId(voice.providerId);
  const executionMachine = useVoiceExecutionMachineSelection();
  const daemonMachineId = executionMachine.machineId;
  const speechVoice = options.purpose === 'dictation'
    ? createVoiceDictationRuntimeSettingsSnapshot({ voice }).voice : voice;
  const activeLocalAdapter = speechVoice.providerId === 'local_direct'
    ? readLocalDirectVoiceSettings(speechVoice)
    : readLocalConversationVoiceSettings(speechVoice);
  const activeLocalStt = parseLocalVoiceSttSettings(activeLocalAdapter.stt);
  const activeLocalTts = parseLocalVoiceTtsSettings(activeLocalAdapter.tts);
  const requiresDaemonSttModel = activeLocalStt.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalStt.localNeural.execution,
    }).preferredExecution === 'daemon';
  const requiresDaemonTtsModel = options.purpose === 'conversation' && activeLocalTts.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalTts.localNeural.execution,
    }).preferredExecution === 'daemon';
  const daemonCatalogEnabled = options.probeMachine
    && (options.purpose === 'dictation'
      ? requiresDaemonSttModel
      : providerId === 'local_direct' || providerId === 'local_conversation');
  const daemonModelCatalog = useDaemonVoiceModelCatalogState({
    enabled: daemonCatalogEnabled,
    refreshKey: daemonMachineId,
  });
  const daemonModelAvailability = React.useMemo(
    () => resolveVoiceDaemonModelAvailabilityFromCatalogState({
      loading: daemonModelCatalog.state.loading,
      errorCode: daemonModelCatalog.state.errorCode,
      statuses: daemonModelCatalog.state.statuses,
      selectedSttPackId: activeLocalStt.localNeural?.assetId ?? null,
      selectedTtsPackId: activeLocalTts.localNeural?.assetId ?? null,
      requireStt: requiresDaemonSttModel,
      requireTts: requiresDaemonTtsModel,
    }),
    [
      activeLocalStt.localNeural?.assetId,
      activeLocalTts.localNeural?.assetId,
      daemonModelCatalog.state.errorCode,
      daemonModelCatalog.state.loading,
      daemonModelCatalog.state.statuses,
      requiresDaemonSttModel,
      requiresDaemonTtsModel,
    ],
  );
  const daemonSpeech = React.useMemo(() => ({
    stt: resolveVoiceDaemonModelKindAvailabilityFromCatalogState({ ...daemonModelCatalog.state,
      kind: 'stt_sherpa', selectedPackId: activeLocalStt.localNeural.assetId }),
    tts: resolveVoiceDaemonModelKindAvailabilityFromCatalogState({ ...daemonModelCatalog.state,
      kind: 'tts_sherpa', selectedPackId: activeLocalTts.localNeural.assetId }),
  }), [daemonModelCatalog.state, activeLocalStt.localNeural.assetId, activeLocalTts.localNeural.assetId]);
  const localAvailability = useVoiceProviderLocalAvailability({
    daemonModelState: daemonModelAvailability.modelState,
    daemonRuntimeState: daemonModelAvailability.runtimeState,
    daemonSpeech,
    daemonMachineId,
  });
  const daemonRouteDiagnosticReason = React.useMemo(
    () => resolveVoiceDaemonRouteDiagnosticReason(localAvailability),
    [localAvailability],
  );
  return { happierVoiceSupported, executionMachine, daemonModelCatalog, localAvailability, daemonRouteDiagnosticReason };
}
