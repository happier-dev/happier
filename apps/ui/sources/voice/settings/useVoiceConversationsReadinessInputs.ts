import * as React from 'react';

import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import {
  resolveVoiceDaemonModelAvailabilityFromCatalogState,
  resolveVoiceDaemonRouteDiagnosticReason,
  useVoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';

/**
 * What the Conversations readiness model (`useVoiceConversationsReadinessModel`) is computed from:
 * server support, the execution machine, the daemon model catalog and this device's speech
 * availability. One owner for the Conversations page and the Voice setup item, so the gallery and
 * the setup steps cannot read readiness differently.
 *
 * `probeMachine: false` keeps a surface passive (Home's setup tile, a hub): the daemon model catalog
 * is not asked, so a local service's model facts stay unknown rather than being fetched because a
 * page opened. The open setup panel and the Conversations page pass `true` (the person asked).
 */
export function useVoiceConversationsReadinessInputs(voice: VoiceSettings, options: Readonly<{ probeMachine: boolean }>) {
  const happierVoiceSupported = useHappierVoiceSupport();
  const providerId = resolveVoiceProviderId(voice.providerId);
  const daemonCatalogEnabled = options.probeMachine
    && (providerId === 'local_direct' || providerId === 'local_conversation');
  const executionMachine = useVoiceExecutionMachinePresentation();
  const daemonMachineId = daemonCatalogEnabled ? executionMachine.machineId : null;
  const daemonModelCatalog = useDaemonVoiceModelCatalogState({
    enabled: daemonCatalogEnabled,
    refreshKey: daemonMachineId,
  });
  const activeLocalAdapter = providerId === 'local_direct'
    ? readLocalDirectVoiceSettings(voice)
    : readLocalConversationVoiceSettings(voice);
  const activeLocalStt = parseLocalVoiceSttSettings(activeLocalAdapter.stt);
  const activeLocalTts = parseLocalVoiceTtsSettings(activeLocalAdapter.tts);
  const requiresDaemonSttModel = activeLocalStt.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalStt.localNeural.execution,
    }).preferredExecution === 'daemon';
  const requiresDaemonTtsModel = activeLocalTts.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalTts.localNeural.execution,
    }).preferredExecution === 'daemon';
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
  const localAvailability = useVoiceProviderLocalAvailability({
    daemonModelState: daemonModelAvailability.modelState,
    daemonRuntimeState: daemonModelAvailability.runtimeState,
    daemonMachineId,
  });
  const daemonRouteDiagnosticReason = React.useMemo(
    () => resolveVoiceDaemonRouteDiagnosticReason(localAvailability),
    [localAvailability],
  );
  return { happierVoiceSupported, executionMachine, daemonModelCatalog, localAvailability, daemonRouteDiagnosticReason };
}
