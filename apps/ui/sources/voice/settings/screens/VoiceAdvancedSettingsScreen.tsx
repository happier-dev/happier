import * as React from 'react';
import { View } from 'react-native';

import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { t } from '@/text';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { VoiceUiSection } from '@/voice/settings/panels/VoiceUiSection';
import { VoiceConnectionSection } from '@/voice/settings/panels/VoiceConnectionSection';
import { VoiceSpeechModelsSection } from '@/voice/settings/panels/VoiceSpeechModelsSection';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { resolveVoicePresenceContainer } from '@/components/voice/presence/useVoicePresenceContainer';
import { useDeviceType } from '@/utils/platform/responsive';

export function VoiceAdvancedSettingsScreen() {
  const [voice, setVoice] = useVoiceSettingsMutable();
  // The presence preference is device-local. This screen owns its storage access and the
  // presentational section receives only the current value and setter.
  const [presencePreference, setVoicePresenceContainer] = useLocalSettingMutable('voicePresenceContainer');
  const [voiceHoldToTalkEnabled, setVoiceHoldToTalkEnabled] = useLocalSettingMutable('voiceHoldToTalkEnabled');
  const deviceType = useDeviceType();
  const voicePresenceContainer = resolveVoicePresenceContainer(presencePreference, deviceType);
  const popoverBoundaryRef = React.useRef<any>(null);

  return (
    <View style={{ flex: 1 }} ref={popoverBoundaryRef}>
      <ItemList>
        <SettingsPageHeader description={t('settingsVoice.pages.advanced.description')} />
        <VoiceUiSection
          voice={voice}
          setVoice={setVoice}
          voicePresenceContainer={voicePresenceContainer}
          setVoicePresenceContainer={setVoicePresenceContainer}
          voiceHoldToTalkEnabled={voiceHoldToTalkEnabled}
          setVoiceHoldToTalkEnabled={setVoiceHoldToTalkEnabled}
          popoverBoundaryRef={popoverBoundaryRef}
        />
        <VoiceExecutionMachineSection voice={voice} setVoice={setVoice} intent="advanced" popoverBoundaryRef={popoverBoundaryRef} />
        <VoiceSpeechModelsSection voice={voice} setVoice={setVoice} />
        <VoiceConnectionSection voice={voice} setVoice={setVoice} />
      </ItemList>
    </View>
  );
}
