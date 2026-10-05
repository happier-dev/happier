import * as React from 'react';

import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  VoiceLocalConversationSchema,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { VOICE_ADVANCED_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

// The admitted range is the setting's own schema; this row only converts it to seconds.
const TIMEOUT_SCHEMA = VoiceLocalConversationSchema.shape.networkTimeoutMs.unwrap();
const MIN_TIMEOUT_MS = TIMEOUT_SCHEMA.minValue ?? 0;
const MAX_TIMEOUT_MS = TIMEOUT_SCHEMA.maxValue ?? Number.MAX_SAFE_INTEGER;

/**
 * "Give up on a speech request after": Local voice's request timeout for endpoints and speech
 * models, in seconds, within the setting's own admitted range. A settings document still on the
 * released direct-session adapter keeps editing that adapter's value.
 */
export function VoiceConnectionSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
  const voice = voiceSettingsParse(props.voice);
  const legacyDirect = resolveVoiceProviderIdFromSettings(voice) === 'local_direct';
  const timeoutMs = legacyDirect
    ? readLocalDirectVoiceSettings(voice).networkTimeoutMs
    : readLocalConversationVoiceSettings(voice).networkTimeoutMs;
  const write = (nextMs: number) => {
    if (legacyDirect) {
      const cfg = readLocalDirectVoiceSettings(voice);
      props.setVoice(writeLocalDirectVoiceSettings(voice, { ...cfg, networkTimeoutMs: nextMs }));
      return;
    }
    const cfg = readLocalConversationVoiceSettings(voice);
    props.setVoice(writeLocalConversationVoiceSettings(voice, { ...cfg, networkTimeoutMs: nextMs }));
  };
  return (
    <SettingSection section={VOICE_ADVANCED_SETTINGS.sectionRefs.connection}>
      <ItemGroup title={t('settingsVoice.pages.advanced.connectionTitle')}>
        <SettingAnchor setting={VOICE_ADVANCED_SETTINGS.settings.networkTimeoutMs}>
          <FieldValueItem
            title={t(VOICE_ADVANCED_SETTINGS.settings.networkTimeoutMs.titleKey)}
            subtitle={t('settingsVoice.pages.advanced.timeoutDescription')}
            fieldTestID="settings.voice.local.networkTimeoutMs.field"
            kind="integer"
            stepper={{ min: MIN_TIMEOUT_MS / 1000, max: MAX_TIMEOUT_MS / 1000, step: 1 }}
            unit={t('settingsVoice.pages.privacy.secondsUnit')}
            value={String(Math.round(timeoutMs / 1000))}
            onCommit={(draft) => {
              const seconds = Math.floor(Number(draft));
              if (!Number.isFinite(seconds)) return String(Math.round(timeoutMs / 1000));
              const nextMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, seconds * 1000));
              write(nextMs);
              return String(nextMs / 1000);
            }}
          />
        </SettingAnchor>
      </ItemGroup>
    </SettingSection>
  );
}
