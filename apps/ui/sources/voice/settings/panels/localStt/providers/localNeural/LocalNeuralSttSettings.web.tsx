import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { DaemonVoiceInferenceModelSection } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceModelSection';

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
    requestedExecution: props.cfg.localNeural.execution,
    platformOs: 'web',
  }), [props.cfg.localNeural.execution]);
  const execution = executionPolicy.selectableExecution as 'auto' | 'daemon';
  return (
    <>
      <DaemonVoiceInferenceExecutionDropdown
        execution={execution}
        setExecution={(execution) => props.setCfg({
          ...props.cfg,
          provider: 'local_neural',
          localNeural: {
            ...props.cfg.localNeural,
            execution,
          },
        })}
        popoverBoundaryRef={props.popoverBoundaryRef}
        allowDeviceSelection={executionPolicy.allowDeviceSelection}
      />
      <DaemonVoiceInferenceModelSection
        packId={props.cfg.localNeural.assetId}
        kind="stt"
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />
    </>
  );
}
