import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DotGrid, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import { usageGridTooltip } from '../usageGridPresentation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import {
  formatUsageDuration,
  formatUsageUtcOffset,
  usageNightGridPresentation,
} from './usageHowYouWorkPresentation';

const weekdayLabel = (weekday: number) =>
  formatWithCachedDateTimeFormatter(
    new Date(Date.UTC(2024, 0, 7 + weekday)),
    undefined,
    { weekday: 'narrow', timeZone: 'UTC' },
  );
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/**
 * "Night shift": agent work recorded inside the stated night hours, on the query's own clock. It is a
 * fact about when work was recorded, never a claim about whether anyone was asleep or away.
 */
export function UsageNightShiftWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const night = props.slice.howYouWork?.nightShift ?? null;
  const [chosen, setChosen] = useSettingMutable('usageNightHoursV1');
  const settingsScope = useAccountSettingsScope();
  const [draft, setDraft] = React.useState<{ startHour: number | null; endHour: number | null }>(() => chosen ?? { startHour: null, endHour: null });
  const [open, setOpen] = React.useState<'startHour' | 'endHour' | null>(null);
  React.useEffect(() => { setDraft(chosen ?? { startHour: null, endHour: null }); setOpen(null); }, [chosen, settingsScope]);
  const controls = <View style={styles.controls}>
    {(['startHour', 'endHour'] as const).map(endpoint => <DropdownMenu key={endpoint}
      testID={`${props.testID}.${endpoint}`} open={open === endpoint} onOpenChange={value => setOpen(value ? endpoint : null)}
      selectedId={draft[endpoint] === null ? null : String(draft[endpoint])}
      itemTrigger={{ title: t(endpoint === 'startHour' ? 'usage.board.howYouWork.nightStart' : 'usage.board.howYouWork.nightEnd'),
        placeholder: t('usage.board.howYouWork.nightChooseHour') }}
      items={[...Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), title: clock(hour),
        disabled: draft[endpoint === 'startHour' ? 'endHour' : 'startHour'] === hour })),
        { id: 'clear', title: t('usage.board.howYouWork.nightClear') }]}
      onSelect={id => {
        setOpen(null);
        if (id === 'clear') { setDraft({ startHour: null, endHour: null }); setChosen(null); return; }
        const next = { ...draft, [endpoint]: Number(id) };
        setDraft(next);
        if (next.startHour !== null && next.endHour !== null && next.startHour !== next.endHour) {
          setChosen({ startHour: next.startHour, endHour: next.endHour });
        }
      }} />)}
  </View>;
  const buckets =
    props.slice.howYouWork?.activity?.weekdayHourBuckets ??
    props.slice.accounting?.activity?.weekdayHourBuckets;
  const accent = usageSignatureAccent(theme);
  const grid = React.useMemo(
    () =>
      night && buckets
        ? usageNightGridPresentation({
            buckets,
            night,
            accentColor: accent,
            emptyColor: theme.colors.surface.inset,
            weekdayLabel,
            eventsLabel: (count) =>
              `${formatHappierDataValue(count)} ${t('usage.events')}`,
          })
        : null,
    [night, buckets, accent, theme.colors.surface.inset],
  );
  useWidgetFrameBodyCaption(night ? usagePeriodPhrase(props.query) : null);
  if (!night) {
    return (
      <View style={styles.body}>{controls}<UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.nightUnknownTitle')}
        reason={t('usage.board.howYouWork.nightUnknownReason')}
      /></View>
    );
  }
  const window = t('usage.board.howYouWork.nightWindow', {
    start: clock(night.startHour),
    end: clock(night.endHour),
    offset: formatUsageUtcOffset(props.query.timeZoneOffsetMinutes ?? 0),
  });
  const observedDuration = night.observedBusyMs !== null;
  const value = observedDuration ? formatUsageDuration(night.observedBusyMs!)
    : night.recordedActivityCount !== null ? t('usage.board.howYouWork.eventCount', { count: night.recordedActivityCount })
      : t('usage.board.howYouWork.notRecorded');
  return (
    <View style={styles.body} testID={`${props.testID}.night`}>
      {controls}
      <View style={styles.hero}>
        <Icon name="moon" size={ICON_SIZE.lg} color={accent} />
        <View style={styles.heroText}>
          <HappierDataMetric theme={chartTheme} size="hero" testID={`${props.testID}.headline`}
            label={window} value={value}
            caption={observedDuration
              ? t('usage.board.howYouWork.nightBusySub', { window })
              : t('usage.board.howYouWork.nightEventsSub', { window })} />
          {night.observedBusyMs !== null &&
          night.recordedActivityCount !== null ? (
            <Text style={styles.note}>
              {t('usage.board.howYouWork.eventCount', {
                count: night.recordedActivityCount,
              })}
            </Text>
          ) : null}
        </View>
      </View>
      {grid ? (
        <DotGrid
          testID={`${props.testID}.grid`}
          theme={chartTheme}
          showReadout={false}
          {...grid}
          renderCell={usageGridTooltip(accent, 'usage-night-cell-trigger')}
        />
      ) : null}
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting', 'how_you_work']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 16, minWidth: 0 },
  controls: { gap: 4, minWidth: 0 },
  hero: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  heroText: { flex: 1, minWidth: 0, gap: 2 },
  note: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
