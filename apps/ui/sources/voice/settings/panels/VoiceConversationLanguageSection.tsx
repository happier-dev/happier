import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTING_ANCHOR_QUERY_PARAM, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { LANGUAGES, getLanguageDisplayNameForCode } from '@/constants/Languages';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { projectConversationLanguage, projectConversationLanguagePreference } from '@/voice/settings/language/conversationLanguage';
import { getLocalSttProviderSpec } from '@/voice/settings/panels/localStt/providers/registry';
import { getLocalTtsProviderSpec } from '@/voice/settings/panels/localTts/providers/registry';
import { VOICE_CONVERSATIONS_SETTINGS, resolveVoiceConversationLanguageSetting } from '@/voice/settings/voiceSettingsDeclarations';
import { updateVoiceConversationLanguagePreference } from '@/voice/settings/voiceSettingBinding';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { resolveVoiceProviderLanguagePreference } from '@happier-dev/protocol';

function languageName(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

const SETTINGS = VOICE_CONVERSATIONS_SETTINGS.settings;
/** "Same as I speak" is a real choice (no reply preference); an empty menu id would read as unchosen. */
const SAME_AS_SPOKEN_ID = 'same';

/**
 * Conversations → Language: I speak (recognition), Reply in (`assistantLanguage`, the reply
 * preference) and Voice (the Speak engine's output voice). Recognition and the output voice belong
 * to their engines in Hear and Speak, so those rows say what is in effect and lead to that control;
 * Realtime services contribute whether recognition is automatic, reply is independent, or one
 * language controls both. Services without that fact own their language behavior themselves.
 */
export function VoiceConversationLanguageSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<unknown> | null;
  registry?: VoiceProviderRegistry;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [replyMenuOpen, setReplyMenuOpen] = React.useState(false);
  const defaultRegistry = React.useMemo(() => createDefaultVoiceProviderRegistry(), []);
  const registry = props.registry ?? defaultRegistry;
  useVoiceProviderRegistryRevision(registry);
  const language = projectConversationLanguage(props.voice, registry);
  const preference = projectConversationLanguagePreference(props.voice, registry);
  const languageSetting = resolveVoiceConversationLanguageSetting(props.voice, registry);
  if (language.mode === 'off') return null;

  const reveal = (setting: SettingRef) => router.setParams({ [SETTING_ANCHOR_QUERY_PARAM]: setting.anchor });
  const languageIcon = (name: 'sparkle' | 'translate') => (
    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={name} size={20} color={theme.colors.text.secondary} />
    </View>
  );

  const local = language.mode === 'local' ? language : null;
  const sttTitle = local ? getLocalSttProviderSpec(local.sttProvider)?.title ?? local.sttProvider : '';
  const ttsTitle = local ? getLocalTtsProviderSpec(local.ttsProvider)?.title ?? local.ttsProvider : '';
  const recognition = local?.recognition ?? null;
  const coupled = preference.kind === 'single_language' ? preference : null;
  const automatic = language.mode === 'service' && language.language?.kind === 'automatic_recognition';
  const normalizedPreference = coupled
    ? resolveVoiceProviderLanguagePreference(props.voice.assistantLanguage, coupled.supportedLanguageCodes)
    : props.voice.assistantLanguage;
  const unavailablePreference = coupled && props.voice.assistantLanguage !== null && normalizedPreference === null
    ? props.voice.assistantLanguage : null;

  return (
    <ItemGroup
      title={t('settingsVoice.pages.conversations.languageTitle')}
      description={coupled ? t('settingsVoice.pages.conversations.languageCoupledDescription') : local
        ? t('settingsVoice.pages.conversations.languageDescription')
        : t('settingsVoice.pages.conversations.languageServiceDescription')}
    >
      {local && recognition ? (
        <Item
          testID="settings.voice.language.iSpeak"
          title={t('settingsVoice.pages.conversations.iSpeakTitle')}
          subtitle={t('settingsVoice.pages.conversations.iSpeakEngineDescription', { engine: sttTitle })}
          subtitleLines={0}
          detail={recognition.kind === 'explicit' ? languageName(recognition.language) : t('settingsVoice.pages.conversations.languageEngineDefault')}
          accessibilityRole="button"
          onPress={() => reveal(local.sttProvider === 'local_neural' ? SETTINGS.sttLanguage : SETTINGS.sttProvider)}
        />
      ) : null}
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
      {local ? (
        <Item
          testID="settings.voice.language.voice"
          title={t('settingsVoice.pages.conversations.voiceTitle')}
          subtitle={t('settingsVoice.pages.conversations.voiceDescription', { engine: ttsTitle })}
          subtitleLines={0}
          detail={local.outputVoice.kind === 'engine_voice'
            ? local.outputVoice.voiceId ?? t('settingsVoice.pages.conversations.voiceDefault')
            : local.outputVoice.kind === 'device'
              ? t('settingsVoice.pages.conversations.voiceDevice')
              : t('settingsVoice.pages.conversations.voiceInEngine')}
          accessibilityRole="button"
          onPress={() => reveal(local.ttsProvider === 'local_neural' ? SETTINGS.ttsVoiceId : SETTINGS.ttsProvider)}
        />
      ) : null}
    </ItemGroup>
  );
}
