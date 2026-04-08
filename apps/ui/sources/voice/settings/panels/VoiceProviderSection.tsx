import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

export function VoiceProviderSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  happierVoiceSupported: boolean;
}) {
  const { theme } = useUnistyles();
  const select = (next: VoiceSettings) => props.setVoice(next);

  const providerId = resolveVoiceProviderId(props.voice.providerId);
  const billingMode = props.voice.adapters.realtime_elevenlabs.billingMode;
  const isOff = providerId === 'off';
  const isHappier = providerId === 'realtime_elevenlabs' && billingMode === 'happier';
  const isByo = providerId === 'realtime_elevenlabs' && billingMode === 'byo';
  const isLocal = providerId === 'local_direct' || providerId === 'local_conversation';

  return (
    <ItemGroup title={t('settingsVoice.modeTitle')}>
      <Item
        title={t('settingsVoice.mode.off')}
        subtitle={t('settingsVoice.mode.offSubtitle')}
        rightElement={isOff ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
        onPress={() => select({ ...props.voice, providerId: 'off' })}
        showChevron={false}
      />

      {props.happierVoiceSupported === false ? null : (
        <Item
          title={t('settingsVoice.mode.happier')}
          subtitle={t('settingsVoice.mode.happierSubtitle')}
          rightElement={isHappier ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
          onPress={() =>
            select({
              ...props.voice,
              providerId: 'realtime_elevenlabs',
              adapters: {
                ...props.voice.adapters,
                realtime_elevenlabs: { ...props.voice.adapters.realtime_elevenlabs, billingMode: 'happier' },
              },
            })
          }
          showChevron={false}
        />
      )}

      <Item
        title={t('settingsVoice.mode.byo')}
        subtitle={t('settingsVoice.mode.byoSubtitle')}
        rightElement={isByo ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
        onPress={() =>
          select({
            ...props.voice,
            providerId: 'realtime_elevenlabs',
            adapters: {
              ...props.voice.adapters,
              realtime_elevenlabs: { ...props.voice.adapters.realtime_elevenlabs, billingMode: 'byo' },
            },
          })
        }
        showChevron={false}
      />

      <Item
        title={t('settingsVoice.mode.local')}
        subtitle={t('settingsVoice.mode.localSubtitle')}
        rightElement={isLocal ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
        onPress={() => select({ ...props.voice, providerId: 'local_conversation' })}
        showChevron={false}
      />
    </ItemGroup>
  );
}
