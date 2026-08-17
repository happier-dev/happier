import * as React from 'react';
import { View } from 'react-native';

import { useLocalSearchParams } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { VoiceHistorySettingsEntry } from '@/voice/history/VoiceHistorySettingsEntry';
import { VoicePrivacyPolicyEntry } from '@/voice/settings/panels/VoicePrivacyPolicyEntry';
import { VoicePrivacySection } from '@/voice/settings/panels/VoicePrivacySection';
import { VoiceProviderProcessingDisclosureSection } from '@/voice/settings/panels/VoiceProviderProcessingDisclosureSection';
import { resolveVoiceSettingsRouteFocus } from '@/voice/settings/voiceSettingsRouteFocus';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';

export function VoicePrivacySettingsScreen() {
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const routeFocus = resolveVoiceSettingsRouteFocus(routeParams.focus);
  const focusRegistry = useScrollRectIntoViewRegistry({
    activeKey: routeFocus === 'privacy' ? routeFocus : null,
    alignment: 'center',
    animated: false,
    once: true,
  });
  const onPrivacySectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('privacy'),
    [focusRegistry.registerItemLayout],
  );
  const [voice, setVoice] = useVoiceSettingsMutable();

  return (
    <ItemList
      ref={focusRegistry.scrollRef}
      onLayout={focusRegistry.onViewportLayout}
      onContentSizeChange={focusRegistry.onContentSizeChange}
      onScroll={focusRegistry.onScroll}
      scrollEventThrottle={16}
    >
      <VoiceProviderProcessingDisclosureSection voice={voice} />
      <View testID="settings.voice.section.privacy" onLayout={onPrivacySectionLayout}>
        <VoicePrivacySection voice={voice} setVoice={setVoice} />
      </View>
      <VoiceHistorySettingsEntry />
      <VoicePrivacyPolicyEntry />
    </ItemList>
  );
}
