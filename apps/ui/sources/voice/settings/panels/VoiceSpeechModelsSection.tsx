import * as React from 'react';

import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { DaemonVoiceModelCatalogSection } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogSection';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { VOICE_ADVANCED_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * The speech models on the Voice computer: install, remove, update and the default pack per kind.
 * Defaults stay the canonical local-neural `assetId` of Local voice. The catalog is asked only while
 * this page shows a reachable Voice computer.
 */
export function VoiceSpeechModelsSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
  const machineId = useVoiceExecutionMachineId();
  const scope = useAccountSettingsScope();
  const actions = useMountedActionExecution(scope);
  const catalog = useDaemonVoiceModelCatalogState({ enabled: Boolean(machineId), refreshKey: machineId });
  if (!machineId) return (
    <SettingSection section={VOICE_ADVANCED_SETTINGS.sectionRefs.models}>
      <ItemGroup title={t(VOICE_ADVANCED_SETTINGS.settings.speechModels.titleKey)}>
        <Item mode="info" title={t('settingsVoice.pages.advanced.speechModelsNeedComputerTitle')}
          subtitle={t('settingsVoice.pages.advanced.speechModelsNeedComputer')} />
      </ItemGroup>
    </SettingSection>
  );

  const voice = voiceSettingsParse(props.voice);
  const { config: cfg } = resolveLocalVoiceAdapterSettings({ voice });
  const stt = parseLocalVoiceSttSettings(cfg.stt);
  const tts = parseLocalVoiceTtsSettings(cfg.tts);
  return (
    <SettingSection section={VOICE_ADVANCED_SETTINGS.sectionRefs.models}>
    <SettingAnchor setting={VOICE_ADVANCED_SETTINGS.settings.speechModels}>
    <DaemonVoiceModelCatalogSection
      selectedSttPackId={stt.localNeural?.assetId ?? null}
      selectedTtsPackId={tts.localNeural?.assetId ?? null}
      catalogController={catalog}
      onSelectDefault={async (_kind, packId) => {
        await actions.execute('settings.invoke', {
          anchor: VOICE_ADVANCED_SETTINGS.settings.defaultSpeechModel.anchor,
          input: { kind: 'model_pack', packId, machineId },
        });
      }}
    />
    </SettingAnchor>
    </SettingSection>
  );
}
