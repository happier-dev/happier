import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import {
  resolveVoiceProviderAvailability,
  type ResolveVoiceProviderAvailabilityInput,
} from '@/voice/settings/resolveVoiceProviderAvailability';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

export function VoiceProviderSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  happierVoiceSupported: boolean;
  platformOs?: string;
  localAvailability?: ResolveVoiceProviderAvailabilityInput['local'];
}) {
  const { theme } = useUnistyles();
  const select = (next: VoiceSettings) => props.setVoice(next);

  const providerId = resolveVoiceProviderId(props.voice.providerId);
  const availability = resolveVoiceProviderAvailability({
    happierVoiceSupported: props.happierVoiceSupported,
    platformOs: props.platformOs,
    local: props.localAvailability,
  });
  const billingMode = props.voice.adapters.realtime_elevenlabs.billingMode;
  const isOff = providerId === 'off';
  const isHappier = providerId === 'realtime_elevenlabs' && billingMode === 'happier';
  const isByo = providerId === 'realtime_elevenlabs' && billingMode === 'byo';

  return (
    <ItemGroup title={t('settingsVoice.modeTitle')}>
      <Item
        title={t('settingsVoice.mode.off')}
        subtitle={t('settingsVoice.mode.offSubtitle')}
        rightElement={isOff ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
        onPress={() => select({ ...props.voice, providerId: 'off' })}
        showChevron={false}
      />

      <Item
        title={t('settingsVoice.mode.happier')}
        subtitle={t('settingsVoice.mode.happierSubtitle')}
        rightElement={isHappier ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} /> : null}
        disabled={!availability.happier.enabled}
        onPress={availability.happier.enabled
          ? () =>
            select({
              ...props.voice,
              providerId: 'realtime_elevenlabs',
              adapters: {
                ...props.voice.adapters,
                realtime_elevenlabs: { ...props.voice.adapters.realtime_elevenlabs, billingMode: 'happier' },
              },
            })
          : undefined}
        showChevron={false}
      />

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
        rightElement={providerId === 'local_direct' || providerId === 'local_conversation'
          ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.accent.blue} />
          : null}
        disabled={!availability.local.enabled}
        onPress={availability.local.enabled
          ? () => select({ ...props.voice, providerId: 'local_conversation' })
          : undefined}
        showChevron={false}
      />
    </ItemGroup>
  );
}
