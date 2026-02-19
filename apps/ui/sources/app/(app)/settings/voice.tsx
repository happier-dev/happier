import * as React from 'react';
import { View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { t } from '@/text';
import { LANGUAGES } from '@/constants/Languages';

import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { VoiceProviderSection } from '@/voice/settings/panels/VoiceProviderSection';
import { VoicePrivacySection } from '@/voice/settings/panels/VoicePrivacySection';
import { VoiceUiSection } from '@/voice/settings/panels/VoiceUiSection';
import { RealtimeElevenLabsSection } from '@/voice/settings/panels/RealtimeElevenLabsSection';
import { LocalDirectSection } from '@/voice/settings/panels/LocalDirectSection';
import { LocalConversationSection } from '@/voice/settings/panels/LocalConversationSection';

export default function VoiceSettingsScreen() {
  const { theme } = useUnistyles();
  const [voice, setVoice] = useVoiceSettingsMutable();
  const happierVoiceSupported = useHappierVoiceSupport();
  const popoverBoundaryRef = React.useRef<any>(null);
  const [openMenu, setOpenMenu] = React.useState<null | 'assistantLanguage'>(null);

  React.useEffect(() => {
    if (happierVoiceSupported !== false) return;
    if (voice.providerId !== 'realtime_elevenlabs') return;
    if (voice.adapters.realtime_elevenlabs.billingMode !== 'happier') return;
    setVoice({ ...voice, providerId: 'off' });
  }, [happierVoiceSupported, setVoice, voice]);

  const effectiveAssistantLanguageId =
    voice.adapters?.realtime_elevenlabs?.assistantLanguage
    ?? voice.assistantLanguage
    ?? null;

  return (
    <View style={{ flex: 1 }} ref={popoverBoundaryRef}>
      <ItemList>
        <VoiceProviderSection voice={voice} setVoice={setVoice} happierVoiceSupported={happierVoiceSupported} />

        <ItemGroup title={t('settingsVoice.languageTitle')} footer={t('settingsVoice.languageDescription')}>
          <DropdownMenu
            open={openMenu === 'assistantLanguage'}
            onOpenChange={(next) => setOpenMenu(next ? 'assistantLanguage' : null)}
            variant="selectable"
            search={true}
            searchPlaceholder={t('settingsVoice.preferredLanguage')}
            selectedId={effectiveAssistantLanguageId ?? ''}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={popoverBoundaryRef}
            itemTrigger={{
              title: t('settingsVoice.preferredLanguage'),
              subtitle: t('settingsVoice.preferredLanguageSubtitle'),
              showSelectedSubtitle: false,
            }}
            items={[
              {
                id: '',
                title: t('settingsVoice.language.autoDetect'),
                subtitle: 'Use device language (recommended).',
                icon: (
                  <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="sparkles-outline" size={20} color={theme.colors.textSecondary} />
                  </View>
                ),
              },
              ...LANGUAGES.flatMap((lang) => {
                const code = lang.code;
                if (typeof code !== 'string' || code.length === 0) return [];
                return [
                  {
                    id: code,
                    title: lang.name,
                    subtitle: code,
                    icon: (
                      <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="language-outline" size={20} color={theme.colors.textSecondary} />
                      </View>
                    ),
                  },
                ];
              }),
            ]}
            onSelect={(id) => {
              const nextLanguage = id ? id : null;
              setVoice({
                ...voice,
                assistantLanguage: nextLanguage,
                adapters: {
                  ...voice.adapters,
                  realtime_elevenlabs: {
                    ...voice.adapters.realtime_elevenlabs,
                    assistantLanguage: nextLanguage,
                  },
                },
              });
              setOpenMenu(null);
            }}
          />
        </ItemGroup>

        <VoiceUiSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />

        <RealtimeElevenLabsSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
        <LocalDirectSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
        <LocalConversationSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />

        <VoicePrivacySection voice={voice} setVoice={setVoice} />
      </ItemList>
    </View>
  );
}
