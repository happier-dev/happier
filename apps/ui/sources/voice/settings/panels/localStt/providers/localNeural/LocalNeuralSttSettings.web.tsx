import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useVoiceSttPurpose, useVoiceSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getSherpaSttPackOptions } from '@/voice/sherpa/stt/sherpaStreamingSttPacks';
import { t } from '@/text';
import { LocalNeuralSttLanguageItem } from './LocalNeuralSttLanguageItem';

export function LocalNeuralSttSettings(props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
  hideLanguage?: boolean;
}) {
  const settings = useVoiceSttSettingRefs();
  const purpose = useVoiceSttPurpose();
  const [packOpen, setPackOpen] = React.useState(false);
  const [languageOpen, setLanguageOpen] = React.useState(false);
  const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
    requestedExecution: props.cfg.localNeural.execution,
    platformOs: 'web',
  }), [props.cfg.localNeural.execution]);
  const execution = executionPolicy.selectableExecution as 'auto' | 'daemon';
  const packOptions = getSherpaSttPackOptions({ streamingOnly: purpose !== 'dictation' });
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
      <SettingAnchor setting={settings.sttAssetId}>
        <DropdownMenu
          open={packOpen}
          onOpenChange={setPackOpen}
          variant="selectable"
          search={false}
          selectedId={props.cfg.localNeural.assetId ?? ''}
          showCategoryTitles={false}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.localNeuralStt.modelPack.title'),
            subtitle: t('settingsVoice.local.localNeuralStt.modelPack.subtitle'),
            showSelectedSubtitle: false,
          }}
          items={packOptions}
          onSelect={(assetId) => {
            props.setCfg({ ...props.cfg, localNeural: { ...props.cfg.localNeural, assetId } });
            setPackOpen(false);
          }}
        />
      </SettingAnchor>
      {props.hideLanguage ? null : <LocalNeuralSttLanguageItem
        language={props.cfg.localNeural.language}
        open={languageOpen}
        onOpenChange={setLanguageOpen}
        popoverBoundaryRef={props.popoverBoundaryRef}
        onSelect={(language) => props.setCfg({
          ...props.cfg,
          provider: 'local_neural',
          localNeural: { ...props.cfg.localNeural, language },
        })}
      />}
      <SelectedDaemonModelPackRow
        packId={props.cfg.localNeural.assetId}
        kind="stt_sherpa"
        setting={settings.sttAssetId}
      />
    </>
  );
}
