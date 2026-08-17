import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoiceProcessingDisclosures } from '@/voice/settings/projectVoiceProcessingDisclosures';

const registry = createDefaultVoiceProviderRegistry();

function localizedText(value: string | Readonly<{ key: string; fallback: string }>): string {
  if (typeof value === 'string') return value;
  const translated = tLoose(value.key);
  return translated === value.key ? value.fallback : translated;
}

export function VoiceProviderProcessingDisclosureSection(props: Readonly<{ voice: VoiceSettings }>) {
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const voice = voiceSettingsParse(props.voice);
  const disclosures = projectVoiceProcessingDisclosures(voice, registry);

  if (disclosures.length === 0) return null;

  return (
    <ItemGroup title={t('settingsVoice.intents.privacy.processingTitle')}>
      {disclosures.map((entry) => (
        <Item
          key={entry.id}
          testID={`settings.voice.provider.disclosure.${encodeURIComponent(entry.providerIds[0]!)}${
            entry.roles.length === 1 && entry.roles[0] === 'conversation' ? '' : `.${entry.roles.join('-')}`
          }`}
          mode="info"
          title={tLoose(entry.titleKey)}
          subtitle={localizedText(entry.disclosure)}
          subtitleLines={0}
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
}
