import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { LANGUAGES, getLanguageDisplayNameForCode } from '@/constants/Languages';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { projectConversationLanguage, projectConversationLanguagePreference, projectConversationLanguagePreferenceSelection } from '@/voice/settings/language/conversationLanguage';
import { VOICE_CONVERSATIONS_SETTINGS, resolveVoiceConversationLanguageSetting } from '@/voice/settings/voiceSettingsDeclarations';
import { updateVoiceConversationLanguagePreference } from '@/voice/settings/voiceSettingBinding';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';

const SETTINGS = VOICE_CONVERSATIONS_SETTINGS.settings;
/** "Same as I speak" is a real choice (no reply preference); an empty menu id would read as unchosen. */
const SAME_AS_SPOKEN_ID = 'same';

/**
 * Conversations → Language: Reply in (`assistantLanguage`, the reply preference). Recognition and the
 * output voice belong to their engines and are set in Hear and Speak on this same page, never through
 * a second row here that sends the person there. Realtime services contribute whether recognition is
 * automatic, reply is independent, or one language controls both. Services without that fact own
 * their language behavior themselves.
 */
export function VoiceConversationLanguageSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<unknown> | null;
  registry?: VoiceProviderRegistry;
}>) {
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const { theme } = useUnistyles();
  const [replyMenuOpen, setReplyMenuOpen] = React.useState(false);
  const defaultRegistry = React.useMemo(() => createDefaultVoiceProviderRegistry(), []);
  const registry = props.registry ?? defaultRegistry;
  useVoiceProviderRegistryRevision(registry);
  const language = projectConversationLanguage(props.voice, registry);
  const preference = projectConversationLanguagePreference(props.voice, registry);
  const languageSetting = resolveVoiceConversationLanguageSetting(props.voice, registry);
  if (language.mode === 'off') return searchPrerequisite({ settings: [languageSetting, SETTINGS.greeting], reason: t('settingsVoice.pages.search.chooseService'), group: true });

  const languageIcon = (name: 'sparkle' | 'translate') => (
    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={name} size={20} color={theme.colors.text.secondary} />
    </View>
  );

  const local = language.mode === 'local' ? language : null;
  const coupled = preference.kind === 'single_language' ? preference : null;
  const automatic = language.mode === 'service' && language.language?.kind === 'automatic_recognition';
  const { value: normalizedPreference, unavailableValue: unavailablePreference } = projectConversationLanguagePreferenceSelection(props.voice, preference);

  return (
    <ItemGroup
      title={t('settingsVoice.pages.conversations.languageTitle')}
      description={coupled ? t('settingsVoice.pages.conversations.languageCoupledDescription') : local
        ? t('settingsVoice.pages.conversations.languageDescription')
        : t('settingsVoice.pages.conversations.languageServiceDescription')}
    >
      {automatic ? <Item
        testID="settings.voice.language.iSpeak"
        title={t('settingsVoice.pages.conversations.iSpeakTitle')}
        subtitle={t('settingsVoice.pages.conversations.languageAutomaticDescription')}
        detail={t('settingsVoice.pages.conversations.iSpeakAutomatic')}
      /> : null}
      <SettingAnchor setting={languageSetting}>
      {preference.kind === 'unavailable' ? <Item
        testID="settings.voice.language.replyIn"
        title={t(languageSetting.titleKey)}
        subtitle={t('settingsVoice.pages.conversations.languageManagedDescription')}
      /> :
        <DropdownMenu
          open={replyMenuOpen}
          onOpenChange={setReplyMenuOpen}
          variant="selectable"
          search={true}
          searchPlaceholder={t('settingsVoice.preferredLanguage')}
          selectedId={unavailablePreference ?? normalizedPreference ?? SAME_AS_SPOKEN_ID}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t(languageSetting.titleKey),
            // A single-language service explains its coupling once, in the section description.
            subtitle: coupled ? undefined : languageSetting.descriptionKey ? t(languageSetting.descriptionKey) : undefined,
            showSelectedSubtitle: unavailablePreference !== null,
            itemProps: { subtitleLines: 0 },
          }}
          items={[
            { id: SAME_AS_SPOKEN_ID, title: t(coupled ? 'settingsVoice.pages.conversations.languageServiceDefault' : 'settingsVoice.pages.conversations.replySame'), icon: languageIcon('sparkle') },
            ...(unavailablePreference ? [{ id: unavailablePreference, title: getLanguageDisplayNameForCode(unavailablePreference), subtitle: t('common.unavailable'), disabled: true, icon: languageIcon('translate') }] : []),
            ...(coupled ? coupled.supportedLanguageCodes.map((code) => ({ id: code, title: getLanguageDisplayNameForCode(code), icon: languageIcon('translate') })) : LANGUAGES.flatMap((entry) => (typeof entry.code === 'string' && entry.code.length > 0
              ? [{ id: entry.code, title: entry.name, subtitle: entry.code, icon: languageIcon('translate') }]
              : []))),
          ]}
          onSelect={(id) => {
            const next = updateVoiceConversationLanguagePreference(props.voice, id === SAME_AS_SPOKEN_ID ? null : id, registry);
            if (next) props.setVoice(next);
            setReplyMenuOpen(false);
          }}
        />}
      </SettingAnchor>
      {/* Read-only: Reply in follows I speak on a single-language service; there is nothing to choose. */}
      {coupled ? <Item
        testID="settings.voice.language.replyIn"
        mode="info"
        title={t('settingsVoice.pages.conversations.replyInTitle')}
        detail={t('settingsVoice.pages.conversations.replySame')}
        showChevron={false}
      /> : null}
    </ItemGroup>
  );
}
