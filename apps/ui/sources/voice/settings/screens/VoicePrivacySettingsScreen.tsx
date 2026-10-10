import * as React from 'react';
import { View } from 'react-native';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { t } from '@/text';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { VoiceDiagnosticsSettingsSection } from '@/voice/diagnostics/VoiceDiagnosticsSettingsSection';
import { VoiceHistorySettingsEntry } from '@/voice/history/VoiceHistorySettingsEntry';
import { VoiceAgentMemorySection } from '@/voice/settings/panels/VoiceAgentMemorySection';
import { VoiceLiveUpdatesSection } from '@/voice/settings/panels/VoiceLiveUpdatesSection';
import { VoicePrivacyPolicyEntry } from '@/voice/settings/panels/VoicePrivacyPolicyEntry';
import { VoicePrivacySection } from '@/voice/settings/panels/VoicePrivacySection';
import { VoiceProviderProcessingDisclosureSection } from '@/voice/settings/panels/VoiceProviderProcessingDisclosureSection';
import { resolveVoiceSettingsRouteFocus } from '@/voice/settings/voiceSettingsRouteFocus';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';

/**
 * Privacy & data: where your voice goes now, then each payload the voice service can read (when a
 * conversation starts, while you talk, the Voice agent's memory), the diagnostic recordings Happier
 * keeps, and the history and policy destinations.
 */
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
  const popoverBoundaryRef = React.useRef<any>(null);

  return (
    <View style={{ flex: 1 }} ref={popoverBoundaryRef}>
      <ItemList
        ref={focusRegistry.scrollRef}
        onLayout={focusRegistry.onViewportLayout}
        onContentSizeChange={focusRegistry.onContentSizeChange}
        onScroll={focusRegistry.onScroll}
        scrollEventThrottle={16}
      >
        <SettingsPageHeader description={t('settingsVoice.pages.privacy.description')} />
        <VoiceProviderProcessingDisclosureSection voice={voice} />
        <View testID="settings.voice.section.privacy" onLayout={onPrivacySectionLayout}>
          <VoicePrivacySection voice={voice} setVoice={setVoice} />
        </View>
        <VoiceLiveUpdatesSection voice={voice} setVoice={setVoice} />
        <VoiceAgentMemorySection voice={voice} setVoice={setVoice} />
        <VoiceDiagnosticsSettingsSection voice={voice} setVoice={setVoice} />
        <ItemGroup title={t('settingsVoice.pages.privacy.moreTitle')}>
          <VoiceHistorySettingsEntry />
          <VoicePrivacyPolicyEntry />
        </ItemGroup>
      </ItemList>
    </View>
  );
}
