import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics, isHappierPageRowNarrow } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoicePrivacyPath, type VoicePrivacyRow } from '@/voice/settings/projectVoicePrivacyPath';

const registry = createDefaultVoiceProviderRegistry();
const ID = 'settings.voice.privacy.path';
const GLYPH_PX = 14;

function rowAccessibilityLabel(row: VoicePrivacyRow): string {
  const path = row.stops.map((stop) => stop.label).join(' → ');
  return `${row.title}: ${path}${row.note ? `, ${row.note}` : ''}`;
}

const PathRow = React.memo(function PathRow(props: Readonly<{ row: VoicePrivacyRow; narrow: boolean }>) {
  const { theme } = useUnistyles();
  const { row, narrow } = props;
  return (
    <View testID={`${ID}.${row.key}`} role="listitem" accessible accessibilityLabel={rowAccessibilityLabel(row)}
      style={[styles.row, narrow && styles.rowStacked]}>
      <Text style={[styles.label, narrow && styles.stackedText]}>{row.title}</Text>
      <View style={[styles.value, narrow && styles.stackedText]}>
        {row.stops.map((stop, index) => (
          <React.Fragment key={`${index}:${stop.label}`}>
            {index > 0 ? <Icon name="arrow-right" size={GLYPH_PX - 2} color={theme.colors.text.tertiary} /> : null}
            <View style={styles.stop}>
              {stop.icon ? <Icon name={stop.icon} size={GLYPH_PX} color={theme.colors.text.secondary} /> : null}
              <Text style={[styles.stopLabel, stop.strong && styles.stopStrong]}>{stop.label}</Text>
            </View>
          </React.Fragment>
        ))}
        {row.note ? <Text style={styles.note}>{row.note}</Text> : null}
      </View>
    </View>
  );
});

/**
 * "Where your voice goes now" (lab settings P): one block that names the actual path. What runs where
 * comes from the pipeline owner, what each service declares from the disclosure owner; this only
 * draws it. A service's full disclosure text stays one tap away, once for the whole block.
 */
export function VoiceProviderProcessingDisclosureSection(props: Readonly<{ voice: VoiceSettings }>) {
  const [expanded, setExpanded] = React.useState(false);
  // The shared narrow-row rule: on a phone each label sits above its value.
  const [narrow, setNarrow] = React.useState(false);
  const onFactsLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = isHappierPageRowNarrow(event.nativeEvent.layout.width);
    setNarrow((current) => (current === next ? current : next));
  }, []);
  React.useSyncExternalStore(
    registry.subscribe ?? (() => () => {}),
    registry.getRevision ?? (() => 0),
    registry.getRevision ?? (() => 0),
  );
  const machine = useVoiceExecutionMachinePresentation();
  const voice = voiceSettingsParse(props.voice);
  const path = projectVoicePrivacyPath({ voice, machine: { machineId: machine.selectedMachineId, machineLabel: machine.machineLabel }, registry });
  // Recordings alone says nothing about where voice goes.
  if (!path.rows.some((row) => row.key !== 'recordings')) return null;

  return (
    <ItemGroup
      title={t('settingsVoice.pages.privacy.whereTitle')}
      description={path.serviceTitle ? t('settingsVoice.pages.privacy.whereDescriptionFor', { service: path.serviceTitle }) : t('settingsVoice.pages.privacy.whereDescription')}
    >
      <SectionContentRow>
        <View testID={`${ID}.facts`} role="list" accessibilityLabel={t('settingsVoice.pages.privacy.whereTitle')} style={styles.rows} onLayout={onFactsLayout}>
          {path.rows.map((row) => <PathRow key={row.key} row={row} narrow={narrow} />)}
        </View>
      </SectionContentRow>
      {path.details.length > 0 ? (
        <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
          header={({ headerProps }) => <Item {...headerProps} testID={`${ID}.details`} title={t('common.details')} />}>
          <View testID={`${ID}.full`}>
            {path.details.map((detail) => (
              <Item key={detail.id} mode="info" title={detail.title} subtitle={detail.text} subtitleLines={0} showChevron={false} />
            ))}
          </View>
        </ExpandableItem>
      ) : null}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  rows: { gap: PAGE_LIST_METRICS.groupHeadingGapPx },
  row: { flexDirection: 'row', alignItems: 'flex-start', columnGap: PAGE_LIST_METRICS.rowLeadingGapPx },
  rowStacked: { flexDirection: 'column', rowGap: 0 },
  label: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary, width: 96 },
  value: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s6, rowGap: theme.space.s2 },
  stackedText: { flex: 0, width: 'auto' },
  stop: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space.s4 },
  stopLabel: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
  stopStrong: { ...Typography.default('semiBold') },
  note: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
}));
