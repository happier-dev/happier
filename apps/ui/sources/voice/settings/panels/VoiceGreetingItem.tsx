import * as React from 'react';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import type { VoiceWelcomeSelection } from '@/voice/settings/welcome';

/**
 * Conversations → Greeting: the one control for the shared `voice.welcome` choice, whichever service
 * consumes it (Local voice's Think section or a realtime service's own group). Callers anchor it with
 * the Greeting declaration and write through `applyVoiceWelcomeSelection`.
 */
export function VoiceGreetingItem(props: Readonly<{
  value: VoiceWelcomeSelection;
  onChange: (next: VoiceWelcomeSelection) => void;
  /** Replaces the chosen option's description when the service cannot honour it as chosen. */
  explanation?: string;
}>) {
  const describe = (id: VoiceWelcomeSelection, description: string) => (
    props.explanation && id === props.value ? props.explanation : description
  );
  return (
    <SegmentedChoiceItem<VoiceWelcomeSelection>
      title={t('settingsVoice.pages.conversations.greetingTitle')}
      subtitleLines={0}
      testIDPrefix="settings.voice.greeting"
      value={props.value}
      onChange={props.onChange}
      options={[
        { id: 'off', label: t('settingsVoice.pages.conversations.greetingOff'), description: describe('off', t('settingsVoice.pages.conversations.greetingOffDescription')) },
        { id: 'immediate', label: t('settingsVoice.pages.conversations.greetingRightAway'), description: describe('immediate', t('settingsVoice.pages.conversations.greetingRightAwayDescription')) },
        { id: 'on_first_turn', label: t('settingsVoice.pages.conversations.greetingAfterISpeak'), description: describe('on_first_turn', t('settingsVoice.pages.conversations.greetingAfterISpeakDescription')) },
      ]}
    />
  );
}
