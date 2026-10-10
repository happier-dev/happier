import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingRow } from '@/components/settings/shell/SettingRow';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const VoiceHistorySettingsEntry = React.memo(function VoiceHistorySettingsEntry() {
  const router = useRouter();

  return (
      <SettingRow
        setting={VOICE_PRIVACY_SETTINGS.settings.voiceHistory}
        testID="settings-voice-history-entry"
        icon={<Icon name="clock-counter-clockwise" />}
        accessibilityRole="button"
        accessibilityLabel={t('settingsVoice.history.entryTitle')}
        onPress={() => router.push(SETTINGS_ROUTES.voiceHistory)}
      />
  );
});
