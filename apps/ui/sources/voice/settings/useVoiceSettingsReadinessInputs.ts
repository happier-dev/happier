import * as React from 'react';

import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { useSelectedVoiceSpeechModelCatalog } from './useSelectedVoiceSpeechModelCatalog';
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
  const { executionMachine, activeLocalStt, activeLocalTts, requiresDaemonSttModel,
    requiresDaemonTtsModel, daemonModelCatalog } = useSelectedVoiceSpeechModelCatalog(voice, options);
  const daemonMachineId = executionMachine.machineId;
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
