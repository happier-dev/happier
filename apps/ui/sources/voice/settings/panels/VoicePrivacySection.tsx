import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

export function VoicePrivacySection(props: { voice: VoiceSettings; setVoice: (next: VoiceSettings) => void }) {
  const privacy = props.voice.privacy;

  const setPrivacy = (patch: Partial<VoiceSettings['privacy']>) => {
    props.setVoice({
      ...props.voice,
      privacy: { ...privacy, ...patch },
    });
  };

  return (
    <ItemGroup title={t('settingsVoice.privacy.title')}>
      <Item
        title={t('settingsVoice.privacy.shareSessionSummary')}
        rightElement={<Switch value={privacy.shareSessionSummary} onValueChange={(v) => setPrivacy({ shareSessionSummary: v })} />}
      />
      <Item
        title={t('settingsVoice.privacy.shareRecentMessages')}
        rightElement={<Switch value={privacy.shareRecentMessages} onValueChange={(v) => setPrivacy({ shareRecentMessages: v })} />}
      />
      {privacy.shareRecentMessages ? (
        <Item
          title={t('settingsVoice.privacy.recentMessagesCount')}
          subtitle={t('settingsVoice.privacy.recentMessagesCountSubtitle')}
          detail={String(privacy.recentMessagesCount)}
          onPress={() => {
            void (async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.privacy.recentMessagesCount'),
                t('settingsVoice.privacy.recentMessagesCountSubtitle'),
                { inputType: 'numeric', placeholder: String(privacy.recentMessagesCount) },
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setPrivacy({ recentMessagesCount: Math.max(0, Math.min(50, Math.floor(next))) });
            })();
          }}
        />
      ) : null}
      <Item
        title={t('settingsVoice.privacy.shareToolNames')}
        rightElement={<Switch value={privacy.shareToolNames} onValueChange={(v) => setPrivacy({ shareToolNames: v })} />}
      />
      <Item
        title={t('settingsVoice.privacy.sharePermissionRequests')}
        rightElement={
          <Switch value={privacy.sharePermissionRequests} onValueChange={(v) => setPrivacy({ sharePermissionRequests: v })} />
        }
      />
    </ItemGroup>
  );
}
