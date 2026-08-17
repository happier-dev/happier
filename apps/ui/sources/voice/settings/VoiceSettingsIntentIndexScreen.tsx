import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import {
  resolveLegacyVoiceSettingsIntent,
  VOICE_SETTINGS_INTENTS,
} from '@/voice/settings/voiceSettingsIntents';

export function VoiceSettingsIntentIndexScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const legacyIntent = resolveLegacyVoiceSettingsIntent(routeParams.focus);
  const navigateWithFocusReturn = useNavigationFocusReturn();

  React.useEffect(() => {
    if (!legacyIntent) return;
    const definition = VOICE_SETTINGS_INTENTS.find((candidate) => candidate.id === legacyIntent);
    if (!definition) return;
    router.replace({
      pathname: definition.route as never,
      params: { focus: routeParams.focus as string },
    });
  }, [legacyIntent, routeParams.focus, router]);

  return (
    <ItemList testID="settings.voice.intents" style={{ paddingTop: 0 }}>
      <ItemGroup title={t('settings.voiceAssistant')}>
        {VOICE_SETTINGS_INTENTS.map((intent) => {
          const title = t(intent.titleKey);
          const subtitle = t(intent.subtitleKey);
          return (
            <Item
              key={intent.id}
              testID={`settings.voice.intent.${intent.id}`}
              title={title}
              subtitle={subtitle}
              subtitleLines={0}
              accessibilityLabel={`${title}. ${subtitle}`}
              accessibilityRole="button"
              showChevron={true}
              onPress={() => navigateWithFocusReturn(() => router.push(intent.route as never))}
            />
          );
        })}
      </ItemGroup>
    </ItemList>
  );
}
