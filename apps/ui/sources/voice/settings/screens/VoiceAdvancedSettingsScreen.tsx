import * as React from 'react';
import { View } from 'react-native';

import { ItemList } from '@/components/ui/lists/ItemList';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { VoiceDiagnosticsSettingsSection } from '@/voice/diagnostics/VoiceDiagnosticsSettingsSection';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { VoiceUiSection } from '@/voice/settings/panels/VoiceUiSection';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';

export function VoiceAdvancedSettingsScreen() {
  const [voice, setVoice] = useVoiceSettingsMutable();
  // The Orb preference is device-local. This screen owns its storage access and the
  // presentational section receives only the current value and setter.
  const [voiceOrbEnabled, setVoiceOrbEnabled] = useLocalSettingMutable('voiceOrbEnabled');
  const popoverBoundaryRef = React.useRef<any>(null);

  return (
    <View style={{ flex: 1 }} ref={popoverBoundaryRef}>
      <ItemList style={{ paddingTop: 0 }}>
        <VoiceUiSection
          voice={voice}
          setVoice={setVoice}
          voiceOrbEnabled={voiceOrbEnabled}
          setVoiceOrbEnabled={setVoiceOrbEnabled}
          popoverBoundaryRef={popoverBoundaryRef}
        />
        <VoiceExecutionMachineSection voice={voice} setVoice={setVoice} intent="advanced" popoverBoundaryRef={popoverBoundaryRef} />
        <VoiceDiagnosticsSettingsSection voice={voice} setVoice={setVoice} />
      </ItemList>
    </View>
  );
}
