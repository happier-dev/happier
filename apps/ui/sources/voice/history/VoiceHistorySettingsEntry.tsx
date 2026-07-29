import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export const VoiceHistorySettingsEntry = React.memo(function VoiceHistorySettingsEntry() {
  const router = useRouter();
  const { theme } = useUnistyles();

  return (
    <ItemGroup
      title={t('settingsVoice.history.sectionTitle')}
      footer={t('settingsVoice.history.sectionFooter')}
    >
      <Item
        testID="settings-voice-history-entry"
        title={t('settingsVoice.history.entryTitle')}
        subtitle={t('settingsVoice.history.entrySubtitle')}
        icon={(
          <Ionicons
            name="time-outline"
            size={22}
            color={theme.colors.text.secondary}
          />
        )}
        accessibilityRole="button"
        accessibilityLabel={t('settingsVoice.history.entryTitle')}
        onPress={() => router.push('/settings/voice-history')}
      />
    </ItemGroup>
  );
});
