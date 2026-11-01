import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  localSttProviderSupportsHandsFree,
  resolveConfiguredLocalSttProvider,
  resolveEffectiveLocalSttProvider,
} from '@/voice/local/localVoiceSettings';

type HandsFreeSettings = {
  enabled: boolean;
  endpointing: { silenceMs: number; minSpeechMs: number };
};

function clampEndpointMs(raw: string | null): number | null {
  if (raw === null) return null;
  const next = Number(String(raw).trim());
  if (!Number.isFinite(next)) return null;
  return Math.max(0, Math.min(5000, Math.floor(next)));
}

/**
 * Hands-free settings for the local voice adapters. Shown only when the STT provider this client
 * runs supports hands-free; recorder-based providers get an explicit push-to-talk note instead.
 */
export function LocalVoiceHandsFreeGroup(props: {
  cfgStt: unknown;
  handsFree: HandsFreeSettings;
  setHandsFree: (next: HandsFreeSettings) => void;
}) {
  const provider = resolveEffectiveLocalSttProvider(resolveConfiguredLocalSttProvider(props.cfgStt));
  const { handsFree, setHandsFree } = props;

  if (!localSttProviderSupportsHandsFree(provider)) {
    return (
      <ItemGroup title={t('settingsVoice.local.conversation.handsFree.title')}>
        <Item
          title={t('settingsVoice.local.conversation.handsFree.pushToTalkTitle')}
          subtitle={t('settingsVoice.local.conversation.handsFree.pushToTalkSubtitle')}
          showChevron={false}
        />
      </ItemGroup>
    );
  }

  const promptEndpointMs = (key: 'silenceMs' | 'minSpeechMs', title: string) => {
    fireAndForget((async () => {
      const raw = await Modal.prompt(title, undefined, {
        inputType: 'numeric',
        placeholder: String(handsFree.endpointing[key]),
      });
      const next = clampEndpointMs(raw);
      if (next === null) return;
      setHandsFree({ ...handsFree, endpointing: { ...handsFree.endpointing, [key]: next } });
    })(), { tag: `LocalVoiceHandsFreeGroup.prompt.${key}` });
  };

  return (
    <ItemGroup title={t('settingsVoice.local.conversation.handsFree.title')}>
      <Item
        title={t('settingsVoice.local.conversation.handsFree.enableTitle')}
        rightElement={
          <Switch value={handsFree.enabled} onValueChange={(v) => setHandsFree({ ...handsFree, enabled: v })} />
        }
      />
      <Item
        title={t('settingsVoice.local.conversation.handsFree.silenceTitle')}
        detail={String(handsFree.endpointing.silenceMs)}
        onPress={() => promptEndpointMs('silenceMs', t('settingsVoice.local.conversation.handsFree.silenceTitle'))}
      />
      <Item
        title={t('settingsVoice.local.conversation.handsFree.minSpeechTitle')}
        detail={String(handsFree.endpointing.minSpeechMs)}
        onPress={() => promptEndpointMs('minSpeechMs', t('settingsVoice.local.conversation.handsFree.minSpeechTitle'))}
      />
    </ItemGroup>
  );
}
