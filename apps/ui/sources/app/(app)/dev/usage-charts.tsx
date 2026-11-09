import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { createUsageChartHarnessSlice } from '@/dev/usage/usageChartHarnessSlice';
import type { UsageBodyProps } from '@/components/settings/usage/widgets/usageBodyKit';
import {
  UsageDayStyleBody, UsageDaylightStyleBody, UsagePlanetBody, UsageRecordsStyleBody, UsageRunLengthBody, UsageScoreBody,
  UsageSkyStyleBody, UsageSteeringStyleBody, UsageWeekTideStyleBody,
} from '@/components/settings/usage/widgets/UsageChartStyleBodies';
import {
  UsageAtmosphereBody, UsageCalendarArtStyleBody, UsageMachinesBody, UsageMoonsBody, UsageProjectsBody,
} from '@/components/settings/usage/widgets/UsagePlanetFamilyBodies';

/**
 * Development harness: the real chart Style bodies fed by synthetic work facts pushed through the real How-you-work owner,
 * arranged as the How you work preset (lab u3how). For side-by-side judgement against the design lab only.
 */
export default function UsageChartsHarness() {
  const { slice, query } = React.useMemo(() => createUsageChartHarnessSlice(), []);
  const model = React.useMemo(() => ({ refresh: async () => {} }), []);
  const props = (id: UsageBodyProps['id'], testID: string, presentation?: UsageBodyProps['presentation']): UsageBodyProps => ({
    id, model, slice, query, serverId: 'harness', testID, ...(presentation ? { presentation } : {}) });
  const card = (title: string, body: React.ReactNode, inRow = false) => <View style={[styles.card, inRow ? styles.rowItem : null]}><Text style={styles.title}>{title}</Text>{body}</View>;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.note}>Development harness · synthetic facts through the real How-you-work owner · not product data</Text>
    {card('Sky of days', <UsageSkyStyleBody {...props('usage_rhythm', 'h.sky', { style: 'sky', colourBy: 'leadingAgent' })} />)}
    {card('Steering by Agent', <UsageSteeringStyleBody {...props('usage_human_loop', 'h.steer', { style: 'tide' })} />)}
    <View style={styles.row}>
      {card('A day in agents', <UsageDayStyleBody {...props('usage_parallel', 'h.lanes')} style="lanes" />, true)}
      {card('Your planet', <UsagePlanetBody {...props('usage_planet', 'h.planet')} />, true)}
    </View>
    <View style={styles.row}>
      {card('Run length', <UsageRunLengthBody {...props('usage_run_length', 'h.run')} />, true)}
      {card('Personal records', <UsageRecordsStyleBody {...props('usage_recap', 'h.records', { style: 'personalRecords' })} />, true)}
    </View>
    <View style={styles.row}>
      {card('Week tide', <UsageWeekTideStyleBody {...props('usage_rhythm', 'h.tide', { style: 'weekTide' })} />, true)}
      {card('Daylight', <UsageDaylightStyleBody {...props('usage_rhythm', 'h.daylight', { style: 'daylight' })} />, true)}
    </View>
    {card('A day in agents · Dial', <UsageDayStyleBody {...props('usage_parallel', 'h.dial')} style="dial" />)}
    {card('Score', <UsageScoreBody {...props('usage_score', 'h.score')} />)}
    <Text style={styles.note}>Calendar and planet family</Text>
    {card('Ninety planets', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.ninety')} style="ninetyPlanets" />)}
    <View style={styles.row}>
      {card('Streak thread', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.thread')} style="streakThread" />, true)}
      {card('Weeks skyline', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.skyline')} style="weeksSkyline" />, true)}
    </View>
    <View style={styles.row}>
      {card('Days on the surface', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.surface')} style="daysOnSurface" />, true)}
      {card('Around the period', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.orbit')} style="aroundPeriod" />, true)}
    </View>
    {card('Ringed by streaks', <UsageCalendarArtStyleBody {...props('usage_rhythm', 'h.rings')} style="ringedStreaks" />)}
    <View style={styles.row}>
      {card('Moons', <UsageMoonsBody {...props('usage_orbit', 'h.moons', { style: 'moons' })} />, true)}
      {card('Atmosphere', <UsageAtmosphereBody {...props('usage_atmosphere', 'h.atmosphere')} />, true)}
    </View>
    <View style={styles.row}>
      {card('Machines', <UsageMachinesBody {...props('usage_machines', 'h.machines')} />, true)}
      {card('Projects', <UsageProjectsBody {...props('usage_projects', 'h.projects')} />, true)}
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create((theme) => ({
  page: { padding: theme.space.s24, gap: theme.space.s16, maxWidth: 1180, width: '100%', alignSelf: 'center' },
  note: { color: theme.colors.text.secondary },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s16 },
  rowItem: { flexBasis: 360 },
  card: { flexGrow: 1, minWidth: 0, gap: theme.space.s12, padding: theme.space.s20, borderRadius: 16, backgroundColor: theme.colors.surface.base,
    borderWidth: 1, borderColor: theme.colors.border.default },
  title: { color: theme.colors.text.primary, fontWeight: '600' },
}));
