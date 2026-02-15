import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

export function VoiceProviderSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  happierVoiceSupported: boolean | null;
}) {
  const select = (next: VoiceSettings) => props.setVoice(next);

  const billingMode = props.voice.adapters.realtime_elevenlabs.billingMode;
  const isOff = props.voice.providerId === 'off';
  const isHappier = props.voice.providerId === 'realtime_elevenlabs' && billingMode === 'happier';
  const isByo = props.voice.providerId === 'realtime_elevenlabs' && billingMode === 'byo';
  const isLocal = props.voice.providerId === 'local_direct' || props.voice.providerId === 'local_conversation';

  return (
    <ItemGroup title={t('settingsVoice.modeTitle')}>
      <Item
        title={t('settingsVoice.mode.off')}
        subtitle={t('settingsVoice.mode.offSubtitle')}
        rightElement={isOff ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
        onPress={() => select({ ...props.voice, providerId: 'off' })}
        showChevron={false}
      />

      {props.happierVoiceSupported === false ? null : (
        <Item
          title={t('settingsVoice.mode.happier')}
          subtitle={t('settingsVoice.mode.happierSubtitle')}
          rightElement={isHappier ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
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
        rightElement={isByo ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
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
        rightElement={isLocal ? <Ionicons name="checkmark-circle" size={24} color="#007AFF" /> : null}
        onPress={() => select({ ...props.voice, providerId: 'local_conversation' })}
        showChevron={false}
      />
    </ItemGroup>
  );
}
