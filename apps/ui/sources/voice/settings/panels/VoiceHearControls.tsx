import * as React from 'react';

import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import type { VoiceLocalConversationSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { MAX_VOICE_TIMER_DELAY_MS } from '@/voice/runtime/input/TurnEndpointDetector';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';

export const VOICE_HEAR_SETTINGS = [VOICE_CONVERSATIONS_SETTINGS.settings.handsFree,
  VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs, VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs,
  VOICE_CONVERSATIONS_SETTINGS.settings.bargeInEnabled] as const;

type HandsFree = VoiceLocalConversationSettings['handsFree'];

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
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const { handsFree } = props;
  const handsFreeOn = props.handsFreeSupported && handsFree.enabled;
  const commitEndpointing = (key: 'silenceMs' | 'minSpeechMs') => (draft: string) => {
    const { divisor } = VOICE_CONVERSATIONS_SETTINGS.settings[key].numberDisplay!;
    const next = Math.max(0, Math.min(MAX_VOICE_TIMER_DELAY_MS, Math.round(Number(draft) * divisor)));
    if (!Number.isFinite(next)) return String(handsFree.endpointing[key] / divisor);
    props.setHandsFree({ ...handsFree, endpointing: { ...handsFree.endpointing, [key]: next } });
    return String(next / divisor);
  };
  return (
    <>
      <SettingRow
        setting={VOICE_CONVERSATIONS_SETTINGS.settings.handsFree}
        subtitle={props.handsFreeSupported
          ? t('settingsVoice.pages.conversations.handsFreeDescription')
          : t('settingsVoice.pages.conversations.handsFreeUnsupported')}
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
      {/* The same Hands-free branch owns the timing rows and their search prerequisite. */}
      {handsFreeOn ? (
        <>
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs}>
          <FieldValueItem
            title={t(VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs.titleKey)}
            fieldTestID={`${props.testIDPrefix}.handsFree.silenceMs.field`}
            kind="decimal"
            unit={VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs.numberDisplay!.unit}
            value={String(handsFree.endpointing.silenceMs / VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs.numberDisplay!.divisor)}
            onCommit={commitEndpointing('silenceMs')}
          />
        </SettingAnchor>
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs}>
          <FieldValueItem
            title={t(VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs.titleKey)}
            fieldTestID={`${props.testIDPrefix}.handsFree.minSpeechMs.field`}
            kind="decimal"
            unit={VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs.numberDisplay!.unit}
            value={String(handsFree.endpointing.minSpeechMs / VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs.numberDisplay!.divisor)}
            onCommit={commitEndpointing('minSpeechMs')}
          />
        </SettingAnchor>
        </>
      ) : searchPrerequisite({ settings: [VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs, VOICE_CONVERSATIONS_SETTINGS.settings.minSpeechMs], reason: t(props.handsFreeSupported ? 'settingsVoice.pages.conversations.handsFreeTimingUnavailable' : 'settingsVoice.pages.conversations.handsFreeUnsupported') })}
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
