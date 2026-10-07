import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
  const [expandedIds, setExpandedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const voice = voiceSettingsParse(props.voice);
  const disclosures = projectVoiceProcessingDisclosures(voice, registry);

  if (disclosures.length === 0) return null;

  return (
    <ItemGroup
      title={t('settingsVoice.pages.privacy.whereTitle')}
      description={t('settingsVoice.pages.privacy.whereDescription')}
    >
      {disclosures.map((entry) => {
        const id = `settings.voice.provider.disclosure.${encodeURIComponent(entry.providerIds[0]!)}${
          entry.roles.length === 1 && entry.roles[0] === 'conversation' ? '' : `.${entry.roles.join('-')}`
        }`;
        const facts = entry.facts;
        const expanded = expandedIds.has(entry.id);
        const rows = facts ? [
          { key: 'audioDestination', title: t('settingsVoice.pages.privacy.audioTitle'), value: facts.audioDestination },
          { key: 'processor', title: t('settingsVoice.pages.privacy.processorTitle'), value: facts.processor },
          { key: 'retention', title: t('settingsVoice.pages.privacy.retentionTitle'), value: facts.retention },
        ] : [];
        const details = [entry.disclosure, facts?.details].filter((value) => value != null).map(localizedText).join('\n\n');
        return <React.Fragment key={entry.id}>
          <SectionContentRow>
            <View style={styles.service}>
              <Text accessibilityRole="header" style={styles.serviceTitle}>{tLoose(entry.titleKey)}</Text>
              {rows.length > 0 ? <View testID={`${id}.facts`} role="list" accessibilityLabel={tLoose(entry.titleKey)} style={styles.facts}>
                {rows.map((row) => {
                  const value = localizedText(row.value);
                  return <View key={row.key} testID={`${id}.${row.key}`} role="listitem" accessible
                    accessibilityLabel={`${row.title}: ${value}`} style={styles.fact}>
                    <Text style={styles.factLabel}>{row.title}</Text>
                    <Text style={styles.factValue}>{value}</Text>
                  </View>;
                })}
              </View> : null}
            </View>
          </SectionContentRow>
          {details ? <ExpandableItem expanded={expanded} onExpandedChange={(next) => setExpandedIds((current) => {
            const ids = new Set(current);
            if (next) ids.add(entry.id); else ids.delete(entry.id);
            return ids;
          })} header={({ headerProps }) => <Item {...headerProps} testID={`${id}.details`} title={t('common.details')}
            accessibilityLabel={`${t('common.details')}: ${tLoose(entry.titleKey)}`} />}>
            <Item testID={`${id}.full`} mode="info" title={tLoose(entry.titleKey)}
              subtitle={details} subtitleLines={0} showChevron={false} />
          </ExpandableItem> : null}
        </React.Fragment>;
      })}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  service: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
  serviceTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.primary },
  facts: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
  fact: { flexDirection: 'row', alignItems: 'flex-start', columnGap: PAGE_LIST_METRICS.rowLeadingGapPx },
  factLabel: { ...Typography.default('medium'), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary, flex: 1 },
  factValue: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary, flex: 3 },
}));
