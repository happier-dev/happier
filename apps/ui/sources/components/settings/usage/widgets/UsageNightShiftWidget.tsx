import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DotGrid, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSetting } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import { usageGridTooltip } from '../usageGridPresentation';
import { USAGE_SETTINGS } from '../usageSettings';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { UsagePlanDisclosure } from './plans/UsagePlanParts';
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
    { weekday: 'short', timeZone: 'UTC' },
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
  const chosen = useSetting('usageNightHoursV1');
  const { setSetting, isCurrent } = useSettingActionFeedback({ serverId: props.serverId });
  const settingsScope = useAccountSettingsScope();
  const [draft, setDraft] = React.useState<{ startHour: number | null; endHour: number | null }>(() => chosen ?? { startHour: null, endHour: null });
  const [open, setOpen] = React.useState<'startHour' | 'endHour' | null>(null);
  React.useEffect(() => { setDraft(chosen ?? { startHour: null, endHour: null }); setOpen(null); }, [chosen, settingsScope]);
  const choose = async (endpoint: 'startHour' | 'endHour', id: string, context?: ActionExecutorContext) => {
    if (!isCurrent()) return false;
    setOpen(null);
    if (id === 'clear') {
      const accepted = await setSetting(USAGE_SETTINGS.settings.nightHours, null, { callerContext: context });
      if (accepted && isCurrent()) setDraft({ startHour: null, endHour: null });
      return accepted;
    }
    const next = { ...draft, [endpoint]: Number(id) };
    setDraft(next);
    if (next.startHour !== null && next.endHour !== null && next.startHour !== next.endHour) {
      return await setSetting(USAGE_SETTINGS.settings.nightHours,
        { startHour: next.startHour, endHour: next.endHour }, { callerContext: context });
    }
    return true;
  };
  const commands = useCurrentUiContextLocalCommands((['startHour', 'endHour'] as const).flatMap(endpoint => {
    const label = t(endpoint === 'startHour' ? 'usage.board.howYouWork.nightStart' : 'usage.board.howYouWork.nightEnd');
    return [
      { key: `menu:${endpoint}`, title: `${label}: ${t(open === endpoint ? 'common.close' : 'common.open')}`,
        invoke: () => { setOpen(current => current === endpoint ? null : endpoint); return true; } },
      ...Array.from({ length: 24 }, (_, hour) => hour)
        .filter(hour => draft[endpoint === 'startHour' ? 'endHour' : 'startHour'] !== hour)
        .map(hour => ({ key: `${endpoint}:${hour}`, title: `${label}: ${clock(hour)}`,
          invoke: (_input?: unknown, context?: ActionExecutorContext) => choose(endpoint, String(hour), context) })),
      { key: `${endpoint}:clear`, title: `${label}: ${t('usage.board.howYouWork.nightClear')}`,
        invoke: (_input?: unknown, context?: ActionExecutorContext) => choose(endpoint, 'clear', context) },
    ];
  }));
  const controls = <View style={styles.controls}>
    {(['startHour', 'endHour'] as const).map(endpoint => <DropdownMenu key={endpoint}
      testID={`${props.testID}.${endpoint}`} open={open === endpoint} onOpenChange={value => {
        if (value !== (open === endpoint)) void commands.invoke(`menu:${endpoint}`);
      }}
      selectedId={draft[endpoint] === null ? null : String(draft[endpoint])}
      itemTrigger={{ title: t(endpoint === 'startHour' ? 'usage.board.howYouWork.nightStart' : 'usage.board.howYouWork.nightEnd'),
        placeholder: t('usage.board.howYouWork.nightChooseHour') }}
      items={[...Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), title: clock(hour),
        disabled: draft[endpoint === 'startHour' ? 'endHour' : 'startHour'] === hour })),
        { id: 'clear', title: t('usage.board.howYouWork.nightClear') }]}
      onSelect={id => { void commands.invoke(`${endpoint}:${id}`); }} />)}
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
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!night) {
    // What is missing first, then the one choice that fills it (lab uloop N keeps settings out of the chart).
    return (
      <View style={styles.body}><UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.nightUnknownTitle')}
        reason={t('usage.board.howYouWork.nightUnknownReason')}
      />{controls}</View>
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
      {/* Known hours are a quiet fact with Change behind it, never a form above the result. */}
      <UsagePlanDisclosure testID={`${props.testID}.hours`} title={t('usage.board.howYouWork.nightHoursTitle')}
        meta={`${clock(night.startHour)}–${clock(night.endHour)}`}>
        {controls}
      </UsagePlanDisclosure>
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
  body: { gap: theme.space.s16, minWidth: 0 },
  controls: { gap: theme.space.s4, minWidth: 0 },
  hero: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  heroText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
