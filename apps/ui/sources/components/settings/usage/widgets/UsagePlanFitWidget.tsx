import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { ChartDatum, formatHappierDataExactShare, formatHappierDataValue } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { projectProviderAccountSubscriptionMonetaryFacts } from '@happier-dev/protocol/connect/accountSubscription';
import type { UsagePlanInsights } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { usageDimensionLabel, type UsageBodyProps } from './usageBodyKit';
import { summarizeUsagePlanFit, type UsagePlanAccount } from './plans/usagePlansModel';
import { readUsagePersonalPaceTarget } from './plans/usagePacingTarget';
import { UsageBillingButton, UsageSubscriptionPriceEditor } from './plans/UsagePlanActions';
import {
  useUsagePlans,
  type UsagePlanAccountName,
} from './plans/useUsagePlans';
import {
  formatPlanMoment,
  formatPlanPercent,
  planPaceReasonText,
  UsagePlanIdentity,
  UsagePlanAccountStates,
  isUsagePlanAccountSettledUnread,
  UsagePlanSectionHead,
  UsagePlansNothingRead,
  usePlanText,
  UsagePlanDisclosure,
} from './plans/UsagePlanParts';

/**
 * What each plan costs and how it ends, from the connected-account producer's own facts: paid versus
 * dated list price, renewal or ending, what the current pace leaves unused, and how the plan's ended
 * windows actually finished. The shared query owner also supplies qualified weather, model-meter
 * headroom, recorded-reset prices and recorded weeks. Unsupported account value remains explicit.
 */
export function UsagePlanFitWidget(props: UsageBodyProps) {
  const { projection, nameOf, nowMs } = useUsagePlans(props.slice, props.model.refresh);
  const text = usePlanText();
  // A tile keeps every plan's facts on two lines and says the unrecorded comparisons once.
  const tile = useWidgetPresentation()?.size === 'small';
  // The viewer's own advice target, as echoed by the same allowance read; never a default.
  const target = readUsagePersonalPaceTarget(props.slice.quota?.[0]?.targets ?? []);
  useWidgetFrameBodyCaption(t('usage.board.plans.planFitCaption'));
  if (projection.accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          replacesContent={props.slice.planInsights?.recordedWeek.status !== 'available'}
          slice={props.slice}
          promise={t('usage.board.plans.planFitNoneConnected')}
          onRetry={props.model.refresh}
        />
        {props.slice.planInsights?.recordedWeek.status === 'available'
          ? <RecordedWeek value={props.slice.planInsights.recordedWeek} compact={tile} testID={`${props.testID}.recordedWeek`} /> : null}
      </View>
    );
  }
  const insightsOf = (account: UsagePlanAccount) => props.slice.planInsights?.accounts.find(entry => entry.source.ref.accountId === account.accountId
    && entry.source.ref.service.pluginId === account.service.pluginId && entry.source.ref.service.localId === account.service.localId);
  // Never-read accounts are one quiet line, not rows (R1); a missing price shared by every row is said once (R9).
  const drawn = projection.accounts.filter((account) => !isUsagePlanAccountSettledUnread(account));
  const unreadCount = projection.accounts.length - drawn.length;
  const noPriceOnce = drawn.length > 1 && drawn.every((account) => readPlanKeyFact(account, insightsOf(account), nowMs) === null);
  return (
    <View style={styles.body} testID={`${props.testID}.planFit`}>
      <View style={styles.rows} accessibilityRole="list">
        {drawn.map((account) => (
          <PlanRow
            key={account.key}
            account={account}
            name={nameOf(account)}
            nowMs={nowMs}
            target={target}
            compact={tile}
            serverId={props.serverId}
            onSettled={props.model.refresh}
            insights={insightsOf(account)}
            noPriceSaidOnce={noPriceOnce}
            testID={`${props.testID}.plan.${account.accountId}`}
          />
        ))}
      </View>
      {noPriceOnce || unreadCount > 0 ? (
        <Text testID={`${props.testID}.once`} style={[styles.quiet, text.detail]}>
          {[noPriceOnce ? t('usage.board.plans.planNoPriceAll') : null,
            unreadCount > 0 ? t('usage.board.plans.capacityNotRead', { count: unreadCount }) : null].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {props.slice.planInsights?.recordedWeek.status === 'available'
        ? <RecordedWeek value={props.slice.planInsights.recordedWeek} compact={tile} testID={`${props.testID}.recordedWeek`} /> : null}
      {/* What has no basis yet is not a list of feature names: one quiet promise, said once. */}
      {(props.slice.planInsights?.accounts ?? []).some(entry => readPlanInsightMissing(entry).length > 0)
        || props.slice.planInsights?.recordedWeek.status !== 'available' ? (
        <Text testID={`${props.testID}.notRecorded`} style={[styles.quiet, text.detail]}>
          {t('usage.board.plans.moreDetailLater')}
        </Text>
      ) : null}
      <UsagePlanAccountStates accounts={projection.accounts} nameOf={nameOf} slice={props.slice}
        onRetry={props.model.refresh} testID={`${props.testID}.state`} />
    </View>
  );
}

/** The row's one figure: value as a multiple of the price, else the known price; null when neither is known. */
function readPlanKeyFact(account: UsagePlanAccount, insights: UsagePlanInsights['accounts'][number] | undefined, nowMs: number): string | null {
  const value = insights?.value;
  if (value?.status === 'available' && value.priceMultiple.status === 'available') return 'multiple';
  const price = projectProviderAccountSubscriptionMonetaryFacts({ subscription: account.subscription, nowMs, tier: account.planLabel });
  return account.subscription?.enteredMonthlyPrice || price.paid || price.list ? 'price' : null;
}

function PlanRow(
  props: Readonly<{
    account: UsagePlanAccount;
    name: UsagePlanAccountName;
    nowMs: number;
    target: number | null;
    compact: boolean;
    testID: string;
    serverId: string;
    onSettled(): void;
    insights?: UsagePlanInsights['accounts'][number];
    /** Every row lacks a price and the list says so once; the row stays quiet about it. */
    noPriceSaidOnce?: boolean;
  }>,
) {
  const { account, nowMs } = props;
  const text = usePlanText();
  const fit = summarizeUsagePlanFit(account, props.target);
  if (!account.read?.current) {
    return <View testID={props.testID} style={styles.row}>
      <UsagePlanIdentity name={props.name} compact />
      {/* The read's state is said once under the list; the row stays calm. */}
      <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.cellUnknown')}</Text>
    </View>;
  }
  const fitWindow = fit.window?.label ?? null;
  const fitText = fit.observed === 0
    ? [fitWindow, t(
        fit.reason === 'not_loaded' ? 'usage.board.plans.pastCyclesNotLoaded'
          : fit.reason === 'unavailable' ? 'usage.board.plans.pastCyclesUnavailable'
            : 'usage.board.plans.fitNoneEnded')].filter(Boolean).join(' · ')
    : [
        fitWindow,
        t('usage.board.plans.fitUsedUp', { count: fit.usedUp, total: fit.observed }),
        t('usage.board.plans.fitLeftUnused', { count: fit.leftUnused, total: fit.observed }),
        fit.aboveTarget !== null && props.target !== null
          ? t('usage.board.plans.fitAboveTarget', { count: fit.aboveTarget, total: fit.observed, percent: Math.round(props.target * 100) })
          : null,
        fit.partial ? t('usage.board.plans.endedUnusedPartial') : null,
      ].filter(Boolean).join(' · ');
  // Today's pace in the meter's own words (lab `p2budget`): what is left beside what an even pace leaves.
  const headline = account.headline;
  const paceText = headline?.remainingFraction != null
    ? headline.pace
      ? t('usage.board.plans.fitPace', {
          window: headline.label,
          left: formatPlanPercent(headline.remainingFraction),
          even: formatPlanPercent(headline.pace.evenPaceRemainingFraction),
        })
      : `${headline.label} · ${planPaceReasonText(headline.paceUnavailable ?? 'not_derived')}`
    : null;
  const price = projectProviderAccountSubscriptionMonetaryFacts({ subscription: account.subscription, nowMs, tier: account.planLabel });
  // The person's monthly amount is displayable without provider period evidence;
  // period-qualified value/fit still comes from the monetary-facts owner above.
  const entered = account.subscription?.enteredMonthlyPrice;
  const priceText = entered
    ? t('usage.board.plans.planEntered', { amount: formatUsageCost(entered.amount, entered.currency) })
    : price.paid
    ? t('usage.board.plans.planPaid', {
        amount: formatUsageCost(price.paid.amount, price.paid.currency),
      })
    : price.list
      ? t('usage.board.plans.planList', {
          amount: formatUsageCost(price.list.amount, price.list.currency),
          date: formatWithCachedDateTimeFormatter(price.list.asOfMs, getPreferredLanguage(), {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
        })
      : t('usage.board.plans.planNoPrice');
  const subscription = account.subscription;
  const end = subscription?.currentPeriodEndAtMs;
  const headlinePace = account.headline?.pace ?? null;
  const unused =
    headlinePace &&
    account.headline?.resetAtMs != null &&
    end !== undefined &&
    account.headline.resetAtMs === end
      ? headlinePace.projectedRemainingFraction
      : null;
  const periodText =
    !subscription || subscription.status !== 'subscribed' || end === undefined
      ? t('usage.board.plans.planRenewalUnknown')
      : subscription.renewal === 'off'
        ? unused !== null && unused > 0
          ? t('usage.board.plans.planEndsUnused', {
              time: formatPlanMoment(end, nowMs),
              percent: formatPlanPercent(unused),
            })
          : t('usage.board.plans.planEnds', {
              time: formatPlanMoment(end, nowMs),
            })
        : subscription.renewal === 'on'
          ? t('usage.board.plans.planRenews', {
              time: formatPlanMoment(end, nowMs),
            })
          : t('usage.board.plans.planRenewalUnknown');
  const ending = subscription?.renewal === 'off';
  // One row per plan (lab p2sheet-D "Plan value"): who, the one figure, a verdict, and one quiet line;
  // the rest (pace, value basis, weather, headroom, billing, your price) waits behind Details.
  const value = props.insights?.value;
  const multiple = value?.status === 'available' && value.priceMultiple.status === 'available' ? value.priceMultiple.multiple : null;
  const known = Boolean(entered || price.paid || price.list);
  const keyFact = multiple !== null
    ? `${multiple.toLocaleString(getPreferredLanguage(), { maximumFractionDigits: 1 })}×`
    : known ? priceText : null;
  const selectedPrice = entered ?? price.paid ?? price.list;
  const exactFigure = multiple !== null ? `${formatHappierDataValue(multiple, getPreferredLanguage())}×`
    : selectedPrice ? `${selectedPrice.currency} ${formatHappierDataValue(selectedPrice.amount, getPreferredLanguage())}` : null;
  const hiddenFigure = multiple !== null || selectedPrice !== null && selectedPrice !== undefined
    && !priceText.includes(formatHappierDataValue(selectedPrice.amount, getPreferredLanguage()));
  const figure = keyFact === null ? null : <Text style={[styles.price, text.title]} numberOfLines={1}>{keyFact}</Text>;
  // The verdict is the outcome ("never ran out in 242"); the counted windows stay in Details.
  const verdict = fit.observed === 0 ? null : fit.usedUp === 0
    ? t('usage.board.plans.fitNeverRanOut', { total: fit.observed })
    : t('usage.board.plans.fitRanOut', { count: fit.usedUp, total: fit.observed });
  const renewalKnown = subscription?.status === 'subscribed' && end !== undefined && subscription.renewal !== 'unknown';
  // An unknown value is a quiet reason right under the plan's name, never a lone dash at the far edge.
  const secondary = [
    keyFact === null && !props.noPriceSaidOnce ? t('usage.board.plans.planNoPriceShort') : null,
    renewalKnown ? periodText : null,
    fitWindow, verdict ?? (fit.observed === 0 ? t('usage.board.plans.fitNoneEnded') : null),
  ].filter(Boolean).join(' · ');
  return (
    <View
      testID={props.testID}
      style={styles.row}
      accessibilityLabel={[props.name.title, priceText, periodText, paceText].filter(Boolean).join(', ')}
    >
      <View style={styles.rowHead}>
        <View style={styles.rowIdentity}>
          <UsagePlanIdentity name={props.name} compact />
        </View>
        {hiddenFigure && exactFigure ? <ChartDatum testID={`${props.testID}.figure`}
          datum={{ label: props.name.title, value: exactFigure, subtitle: [priceText, periodText, fitText].join(' · ') }}>{figure}</ChartDatum> : figure}
      </View>
      <Text
        testID={fit.observed === 0 ? `${props.testID}.fit.insufficient` : `${props.testID}.fit`}
        accessibilityLabel={`${t('usage.board.plans.fitTitle')}: ${fitText}`}
        style={[styles.secondary, text.detail, ending ? styles.warning : null]}
        // Two lines on a phone, so the verdict is never cut after the price reason.
        numberOfLines={2}
      >
        {secondary}
      </Text>
      {props.compact ? null : (
        <UsagePlanDisclosure title={t('usage.board.plans.planDetails')} testID={`${props.testID}.details`}>
          <View style={styles.details}>
            {/* Terms first (what it costs, when it ends), then how it is being used, then what you can do. */}
            <View style={styles.terms}>
              <Text style={[known ? styles.fit : styles.quiet, text.detail]}>{priceText}</Text>
              <Text style={[renewalKnown ? styles.fit : styles.quiet, text.detail]}>{periodText}</Text>
            </View>
            <View style={styles.usage}>
              {paceText ? <Text style={[styles.fit, text.detail]}>{paceText}</Text> : null}
              <Text style={[styles.fit, text.detail]}>
                <Text style={styles.factLabel}>{t('usage.board.plans.fitTitle')}</Text>{` · ${fitText}`}
              </Text>
              {props.insights ? <PlanExtras value={props.insights} compact={false} testID={props.testID} /> : null}
            </View>
            <View style={styles.actions}>
              <UsageBillingButton account={account} serverId={props.serverId} testID={`${props.testID}.billing`} />
              <UsageSubscriptionPriceEditor account={account} serverId={props.serverId}
                testID={`${props.testID}.priceEditor`} onSettled={props.onSettled} />
            </View>
          </View>
        </UsagePlanDisclosure>
      )}
    </View>
  );
}

function PlanExtras(props: Readonly<{ value: UsagePlanInsights['accounts'][number]; compact: boolean; testID: string }>) {
  const text = usePlanText();
  const unavailable = t('usage.board.plans.insightUnavailable');
  const value = props.value.value;
  const multiple = value.status === 'available' ? value.priceMultiple : null;
  const valueText = value.status === 'available' ? [
    t('usage.board.plans.planValueApiEquivalent', { amount: formatUsageCost(value.amountUsd, value.currency) }),
    value.coverage === 'partial' ? t('usage.board.plans.planValuePartial') : null,
    multiple?.status === 'available' ? t('usage.board.plans.planValueMultiple', {
      multiple: multiple.multiple.toLocaleString(getPreferredLanguage(), { maximumFractionDigits: 2 }),
    }) : unavailable,
    multiple?.status === 'available' ? multiple.priceKind === 'entered'
      ? t('usage.board.plans.planEntered', { amount: formatUsageCost(multiple.priceAmount, multiple.currency) })
      : multiple.priceKind === 'paid' ? t('usage.board.plans.planPaid', { amount: formatUsageCost(multiple.priceAmount, multiple.currency) })
        : t('usage.board.plans.planList', { amount: formatUsageCost(multiple.priceAmount, multiple.currency),
          date: formatWithCachedDateTimeFormatter(multiple.priceAsOfMs, getPreferredLanguage(), { day: 'numeric', month: 'short', year: 'numeric' }) }) : null,
  ].filter(Boolean).join(' · ') : t('usage.board.plans.planValueInsufficient');
  const percent = (fraction: number) => formatHappierDataExactShare(fraction, getPreferredLanguage());
  const money = (amount: number, currency: string) => `${currency} ${formatHappierDataValue(amount, getPreferredLanguage())}`;
  const numericFacts = [
    ...(value.status === 'available' ? [{ label: t('usage.board.plans.planValueTitle'), exact: money(value.amountUsd, value.currency),
      hidden: !formatUsageCost(value.amountUsd, value.currency).includes(formatHappierDataValue(value.amountUsd, getPreferredLanguage())) }] : []),
    ...(multiple?.status === 'available' ? [{ label: t('usage.board.plans.planValueTitle'),
      exact: `${formatHappierDataValue(multiple.multiple, getPreferredLanguage())}× · ${money(multiple.priceAmount, multiple.currency)}`,
      hidden: !valueText.includes(formatHappierDataValue(multiple.multiple, getPreferredLanguage()))
        || !formatUsageCost(multiple.priceAmount, multiple.currency).includes(formatHappierDataValue(multiple.priceAmount, getPreferredLanguage())) }] : []),
    ...props.value.weather.filter(row => row.status === 'available').map(row => ({ label: `${t('usage.board.plans.weatherTitle')} · ${row.label}`,
      exact: `${percent(row.projectedUsedFraction)} · ${t('usage.board.plans.estimatedFrom', { count: row.sampleCount })}`,
      hidden: formatPlanPercent(row.projectedUsedFraction) !== percent(row.projectedUsedFraction) })),
    ...props.value.modelHeadroom.filter(row => row.status === 'available').map(row => ({ label: `${t('usage.board.plans.modelHeadroomTitle')} · ${usageDimensionLabel('model', row.modelId)}`,
      exact: percent(row.remainingFraction), hidden: formatPlanPercent(row.remainingFraction) !== percent(row.remainingFraction) })),
    ...props.value.pricePerReset.filter(row => row.status === 'available').map(row => ({ label: `${t('usage.board.plans.pricePerResetTitle')} · ${row.label}`,
      exact: `${money(row.amount, row.currency)} · ${row.recordedResetCount} · ${money(row.priceAmount, row.currency)}`,
      hidden: !formatUsageCost(row.amount, row.currency).includes(formatHappierDataValue(row.amount, getPreferredLanguage()))
        || !formatUsageCost(row.priceAmount, row.currency).includes(formatHappierDataValue(row.priceAmount, getPreferredLanguage())) })),
  ];
  const visual = <View style={styles.rowFit}>
    {value.status === 'available' ? <Text testID={`${props.testID}.value`} accessibilityLabel={valueText}
      style={[styles.note, text.detail]} numberOfLines={props.compact ? 2 : undefined}>{valueText}</Text> : null}
    {props.value.weather.filter(row => row.status === 'available').map(row => <Text key={`weather:${row.meterId}`} testID={`${props.testID}.weather.${row.meterId}`}
      style={[styles.note, text.detail]} numberOfLines={props.compact ? 2 : undefined}>
      {`${t('usage.board.plans.weatherTitle')} · ${row.label} · ${[t(row.outlook === 'within_even_pace' ? 'usage.board.plans.paceWithin' : 'usage.board.plans.paceFaster'),
          t('usage.board.plans.weatherResult', { percent: formatPlanPercent(row.projectedUsedFraction) }),
          t('usage.board.plans.estimatedFrom', { count: row.sampleCount })].join(' · ')}`}
    </Text>)}
    {props.value.modelHeadroom.filter(row => row.status === 'available').map(row => <Text key={`model:${row.meterId}`} testID={`${props.testID}.modelHeadroom.${row.meterId}`}
      style={[styles.note, text.detail]} numberOfLines={props.compact ? 2 : undefined}>
      {`${t('usage.board.plans.modelHeadroomTitle')} · ${t('usage.board.plans.modelHeadroomResult', { model: usageDimensionLabel('model', row.modelId), percent: formatPlanPercent(row.remainingFraction) })}`}
    </Text>)}
    {props.value.pricePerReset.filter(row => row.status === 'available').map(row => <Text key={`price:${row.meterId}`} testID={`${props.testID}.pricePerReset.${row.meterId}`}
      style={[styles.note, text.detail]} numberOfLines={props.compact ? 2 : undefined}>
      {`${t('usage.board.plans.pricePerResetTitle')} · ${row.label} · ${[t('usage.board.plans.pricePerResetResult', { amount: formatUsageCost(row.amount, row.currency), count: row.recordedResetCount }),
          row.priceKind === 'entered' ? t('usage.board.plans.planEntered', { amount: formatUsageCost(row.priceAmount, row.currency) })
            : row.priceKind === 'paid' ? t('usage.board.plans.planPaid', { amount: formatUsageCost(row.priceAmount, row.currency) })
              : t('usage.board.plans.planList', { amount: formatUsageCost(row.priceAmount, row.currency), date: formatWithCachedDateTimeFormatter(row.priceAsOfMs, getPreferredLanguage(), { day: 'numeric', month: 'short', year: 'numeric' }) })].join(' · ')}`}
    </Text>)}
  </View>;
  return numericFacts.some(fact => fact.hidden)
    ? <ChartDatum testID={`${props.testID}.values.detail`} datum={{ label: t('usage.board.plans.planDetails'),
      value: numericFacts.map(fact => `${fact.label}: ${fact.exact}`).join(' · '), subtitle: valueText }}>{visual}</ChartDatum> : visual;
}

/** What one account has no basis for yet; the widget says the union once, under every plan. */
function readPlanInsightMissing(value: UsagePlanInsights['accounts'][number]): string[] {
  return [
    ...(value.value.status !== 'available' ? [t('usage.board.plans.planValueTitle')] : []),
    ...(value.weather.some(row => row.status !== 'available') ? [t('usage.board.plans.weatherTitle')] : []),
    ...(value.modelHeadroom.some(row => row.status !== 'available') ? [t('usage.board.plans.modelHeadroomTitle')] : []),
    ...(value.pricePerReset.some(row => row.status !== 'available') ? [t('usage.board.plans.pricePerResetTitle')] : []),
  ];
}

function RecordedWeek(props: Readonly<{ value: UsagePlanInsights['recordedWeek']; compact: boolean; testID: string }>) {
  const text = usePlanText();
  const value = props.value;
  return <View style={styles.notRecorded}>
    <UsagePlanSectionHead title={t('usage.board.plans.recordedWeekTitle')} />
    <Text style={[styles.note, text.detail]} numberOfLines={props.compact ? 2 : undefined}
      testID={`${props.testID}${value.status === 'available' ? '' : '.insufficient'}`}>
      {value.status === 'available'
        ? [t('usage.board.plans.recordedWeekResult', { days: value.recordedActiveDays, events: value.recordedEvents }),
          value.coverage === 'partial' ? t('usage.board.plans.insightPartial') : null].filter(Boolean).join(' · ')
        : t('usage.board.plans.recordedWeekRequires')}
    </Text>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 14 },
  rows: { gap: 0 },
  row: {
    gap: theme.space.s4,
    paddingVertical: theme.space.s10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
  secondary: { ...Typography.default(), color: theme.colors.text.tertiary },
  details: { gap: theme.space.s12 },
  terms: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s2 },
  usage: { gap: theme.space.s4 },
  actions: {
    gap: theme.space.s8,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  factLabel: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
  rowIdentity: { flex: 1, minWidth: 0 },
  rowFacts: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  rowFit: { gap: theme.space.s2 },
  fit: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  notRecorded: { gap: theme.space.s4 },
  noteTitle: { ...Typography.default('medium'), color: theme.colors.text.secondary },
  price: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  period: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    textAlign: 'right',
  },
  quiet: { ...Typography.default(), color: theme.colors.text.tertiary },
  warning: { color: theme.colors.state.warning.foreground },
  note: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
}));
