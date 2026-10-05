import * as React from 'react';

import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import type { VoiceLocalConversationSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

type HandsFree = VoiceLocalConversationSettings['handsFree'];

const ENDPOINTING_MAX_MS = 5000;

/**
 * The Hear rows after the recognizer: hands-free (with its timing) and interrupting a reply by
 * speaking. Hands-free stays visible for every recognizer; one that hears in batches says why it
 * cannot listen hands-free instead of the row disappearing.
 */
export function VoiceHearControls(props: Readonly<{
  handsFree: HandsFree;
  /** The selected recognizer finds the end of speech itself (device speech or a Happier speech model). */
  handsFreeSupported: boolean;
  setHandsFree: (next: HandsFree) => void;
  bargeInEnabled: boolean;
  setBargeInEnabled: (next: boolean) => void;
  testIDPrefix: string;
}>) {
  const { handsFree } = props;
  const handsFreeOn = props.handsFreeSupported && handsFree.enabled;
  const timingReason = !props.handsFreeSupported
    ? t('settingsVoice.pages.conversations.handsFreeUnsupported')
    : handsFree.enabled
      ? undefined
      : t('settingsVoice.pages.conversations.handsFreeTimingUnavailable');
  const commitEndpointing = (key: 'silenceMs' | 'minSpeechMs') => (draft: string) => {
    const next = Math.max(0, Math.min(ENDPOINTING_MAX_MS, Math.round(Number(draft) * 1000)));
    if (!Number.isFinite(next)) return String(handsFree.endpointing[key] / 1000);
    props.setHandsFree({ ...handsFree, endpointing: { ...handsFree.endpointing, [key]: next } });
    return String(next / 1000);
  };
  return (
    <>
      <SettingRow
        setting={VOICE_CONVERSATIONS_SETTINGS.settings.handsFree}
        subtitle={props.handsFreeSupported ? undefined : t('settingsVoice.pages.conversations.handsFreeUnsupported')}
        subtitleLines={0}
        disabled={!props.handsFreeSupported}
        rightElement={(
          <Switch
            testID={`${props.testIDPrefix}.handsFree`}
            accessibilityLabel={t(VOICE_CONVERSATIONS_SETTINGS.settings.handsFree.titleKey)}
            value={handsFreeOn}
            disabled={!props.handsFreeSupported}
            onValueChange={(enabled) => props.setHandsFree({ ...handsFree, enabled })}
          />
        )}
      />
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs}>
        <FieldValueItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs.titleKey)}
          subtitle={timingReason}
          subtitleLines={0}
          fieldTestID={`${props.testIDPrefix}.handsFree.silenceMs.field`}
          kind="decimal"
          unit="s"
          disabled={!handsFreeOn}
          value={String(handsFree.endpointing.silenceMs / 1000)}
          onCommit={commitEndpointing('silenceMs')}
        />
      </SettingAnchor>
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs}>
        <FieldValueItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs.titleKey)}
          subtitle={timingReason}
          subtitleLines={0}
          fieldTestID={`${props.testIDPrefix}.handsFree.minSpeechMs.field`}
          kind="decimal"
          unit="s"
          disabled={!handsFreeOn}
          value={String(handsFree.endpointing.minSpeechMs / 1000)}
          onCommit={commitEndpointing('minSpeechMs')}
        />
      </SettingAnchor>
      <SettingRow
        setting={VOICE_CONVERSATIONS_SETTINGS.settings.bargeInEnabled}
        rightElement={(
          <Switch
            testID={`${props.testIDPrefix}.bargeIn`}
            accessibilityLabel={t('settingsVoice.pages.conversations.interruptTitle')}
            value={props.bargeInEnabled}
            onValueChange={props.setBargeInEnabled}
          />
        )}
      />
    </>
  );
}
