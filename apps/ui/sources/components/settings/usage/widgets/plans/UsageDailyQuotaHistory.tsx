import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BurnUpChart, ChartDatum, describeHappierSeriesBucket, formatHappierDataValue, HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1, type HappierSeries } from '@happier-dev/plugin-ui/presentation';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { deriveQuotaMeterValues } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
import { getPreferredLanguage, t } from '@/text';
import { usageSignatureAccent } from '../../usageAccent';
import { useUsageChartDetails } from '../usageMountedControls';
import { useUsagePluginTheme } from '../usageBodyKit';
import { usePlanText } from './UsagePlanParts';
import type { UsagePlanAccountName } from './useUsagePlans';
import type { UsagePlanAccount } from './usagePlansModel';
import { projectUsageDailyQuotaHistory, type UsageDailyQuotaHistorySeries } from './usageDailyQuotaHistoryModel';

function meterLabel(history: UsageDailyQuotaHistorySeries): string {
  return history.measure === 'amount' ? `${history.label} (${history.unit})` : history.label;
}

/** Historical day readings stay independent of the current window's exact pace and reset witness. */
export function UsageDailyQuotaHistory(props: Readonly<{
  accounts: readonly UsagePlanAccount[];
  nameOf(account: UsagePlanAccount): UsagePlanAccountName;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const text = usePlanText();
  const language = getPreferredLanguage();
  const histories = React.useMemo(() => projectUsageDailyQuotaHistory(props.accounts), [props.accounts]);
  const [pickedKey, setPickedKey] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const focus = histories.find(history => history.key === pickedKey) ?? histories[0];
  const items = React.useMemo(() => histories.map(history => ({ id: history.key,
    title: `${props.nameOf(history.account).title} · ${meterLabel(history)}` })), [histories, props.nameOf]);
  const title = focus ? `${props.nameOf(focus.account).title} · ${meterLabel(focus)}` : '';
  const commands = useCurrentUiContextLocalCommands(histories.length > 1 ? [
    { key: 'dailyMenuOpen', title: `${t('usage.board.plans.dailyHistoryTitle')}: ${t('common.open')}`, invoke: () => setPickerOpen(true) },
    { key: 'dailyMenuClose', title: `${t('usage.board.plans.dailyHistoryTitle')}: ${t('common.close')}`, invoke: () => setPickerOpen(false) },
    ...items.map(item => ({ key: item.id, title: `${t('usage.board.plans.dailyHistoryTitle')}: ${item.title}`,
      invoke: () => { setPickedKey(item.id); setPickerOpen(false); return true; } })),
  ] : []);
  const details = useUsageChartDetails(t('usage.board.plans.dailyHistoryTitle'), Boolean(focus));
  const accent = usageSignatureAccent(theme);
  const series = React.useMemo(() => focus ? buildDailySeries(focus, accent, theme.colors.text.tertiary, language) : [],
    [focus, accent, theme.colors.text.tertiary, language]);
  if (!focus) return null;
  const formatValue = (value: number) => `${formatHappierDataValue(value, language)}${focus.measure === 'percent' ? '%' : ''}`;
  return <View style={styles.body}>
    <Text style={[styles.title, text.title]}>{t('usage.board.plans.dailyHistoryTitle')}</Text>
    {histories.length > 1 ? <DropdownMenu testID={`${props.testID}.picker`} open={pickerOpen}
      onOpenChange={open => { if (open !== pickerOpen) void commands.invoke(open ? 'dailyMenuOpen' : 'dailyMenuClose'); }}
      selectedId={focus.key} items={items} matchTriggerWidth={false} onSelect={key => { void commands.invoke(key); }}
      trigger={({ toggle, open }) => <HappierPressable onPress={toggle} accessibilityRole="button"
        accessibilityLabel={`${t('usage.board.plans.windowPicker')}: ${title}`} expanded={open}
        style={state => [styles.picker, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
          focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
        <Text style={[styles.title, text.title]}>{title}</Text>
        <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
      </HappierPressable>} /> : <Text style={[styles.title, text.title]}>{title}</Text>}
    <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.dailyHistorySummary')}</Text>
    <BurnUpChart {...details} testID={props.testID} theme={chartTheme} size="full" label={title} series={series}
      unknownLabel={t('usage.board.plans.cellUnknown')} valueFormatter={formatValue}
      coordinateFormatter={value => formatUsageCalendarDate(value, 0, undefined, language)}
      valuesLabel={`${title}: ${t('usage.board.charts.showValues')}`} valuesCollapseLabel={t('usage.board.charts.hideValues')}
      renderBucket={(bucket, visual) => <ChartDatum datum={{ keyboard: false, label: title,
        value: describeHappierSeriesBucket(bucket, t('usage.board.plans.cellUnknown'), {
          formatCoordinate: value => formatUsageCalendarDate(value, 0, undefined, language), formatValue,
        }) }}><View style={{ height: '100%' }}>{visual}</View></ChartDatum>}
      showReadout={false} showAxis showScaleValues showLegend />
  </View>;
}

function buildDailySeries(history: UsageDailyQuotaHistorySeries, color: string, peakColor: string, language: string): HappierSeries[] {
  const amount = (value: number | null) => formatHappierDataValue(value, language, t('usage.board.plans.cellUnknown'));
  const points = history.days.map(day => {
    const annotation = day.windows.map(window => {
      const meter = window.lastSnapshot.meters[0]!;
      const values = deriveQuotaMeterValues(meter);
      const last = history.measure === 'amount' ? `${amount(values.used)}${meter.limit === null ? '' : ` / ${amount(meter.limit)}`}`
        : values.usedPct === null ? t('usage.board.plans.cellUnknown') : `${amount(values.usedPct)}%`;
      const when = (atMs: number | null) => atMs === null ? t('usage.board.plans.cellUnknown') : formatUsageCalendarDate(atMs, 0,
        { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, language);
      return [t('usage.board.plans.dailyHistoryWindow', { window: `${when(window.windowStartAtMs)}–${when(window.resetAtMs)}`,
        last, peak: amount(window.peakUsed), first: when(window.firstObservedAtMs), latest: when(window.lastObservedAtMs) }),
      ...window.resets.map(reset => t('usage.board.plans.dailyHistoryReset', { time: when(reset.resetAtMs), value: amount(reset.usedBeforeReset) }))].join(' · ');
    }).join(' · ');
    return { id: String(day.dayStartAtMs), x: day.dayStartAtMs, label: formatUsageCalendarDate(day.dayStartAtMs, 0, undefined, language), annotation };
  });
  return [
    { id: 'last', label: t('usage.board.plans.dailyHistoryLast'), color,
      points: points.map((point, index) => ({ ...point, y: history.days[index]!.last })) },
    { id: 'peak', label: t('usage.board.plans.dailyHistoryPeak'), color: peakColor, lineStyle: 'dotted',
      points: points.map((point, index) => ({ ...point, y: history.days[index]!.peak })) },
  ];
}

const styles = StyleSheet.create(theme => ({
  body: { gap: theme.space.s10 },
  title: { color: theme.colors.text.primary, flexShrink: 1 },
  quiet: { color: theme.colors.text.tertiary },
  picker: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: theme.space.s6,
    maxWidth: '100%', borderRadius: theme.borderRadius.sm },
}));
