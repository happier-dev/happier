import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';
import { LocalNeuralSttLanguageItem } from './LocalNeuralSttLanguageItem';

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const settings = useVoiceSttSettingRefs();
  const [languageOpen, setLanguageOpen] = React.useState(false);
  const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
    requestedExecution: props.cfg.localNeural.execution,
    platformOs: 'web',
  }), [props.cfg.localNeural.execution]);
  const execution = executionPolicy.selectableExecution as 'auto' | 'daemon';
  return (
    <>
      <SettingAnchor setting={settings.sttExecution}>
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
      </SettingAnchor>
      <LocalNeuralSttLanguageItem
        language={props.cfg.localNeural.language}
        open={languageOpen}
        onOpenChange={setLanguageOpen}
        popoverBoundaryRef={props.popoverBoundaryRef}
        onSelect={(language) => props.setCfg({
          ...props.cfg,
          provider: 'local_neural',
          localNeural: { ...props.cfg.localNeural, language },
        })}
      />
      <SelectedDaemonModelPackRow
        packId={props.cfg.localNeural.assetId}
        kind="stt_sherpa"
        setting={settings.sttAssetId}
      />
    </>
  );
}
