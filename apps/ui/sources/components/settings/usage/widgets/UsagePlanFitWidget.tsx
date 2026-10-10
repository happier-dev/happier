import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { projectProviderAccountSubscriptionMonetaryFacts } from '@happier-dev/protocol/connect/accountSubscription';
import { UsageCoverageLine, type UsageBodyProps } from './usageBodyKit';
import { summarizeUsagePlanFit, type UsagePlanAccount } from './plans/usagePlansModel';
import { readUsagePersonalPaceTarget } from './plans/usagePacingTarget';
import { UsageBillingButton } from './plans/UsagePlanActions';
import {
  useUsagePlans,
  type UsagePlanAccountName,
} from './plans/useUsagePlans';
import {
  formatPlanMoment,
  formatPlanPercent,
  planPaceReasonText,
  UsagePlanIdentity,
  UsagePlanSectionHead,
  UsagePlansNothingRead,
  usePlanText,
} from './plans/UsagePlanParts';

/**
 * What each plan costs and how it ends, from the connected-account producer's own facts: paid versus
 * dated list price, renewal or ending, what the current pace leaves unused, and how the plan's ended
 * windows actually finished (plain counts of the B owner's rows, with the count shown). Value multiples,
 * replays on another plan and multi-account strategies need facts no producer records; each says so.
 */
export function UsagePlanFitWidget(props: UsageBodyProps) {
  const { projection, nameOf, nowMs } = useUsagePlans(props.slice, props.model);
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
          slice={props.slice}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  return (
    <View style={styles.body} testID={`${props.testID}.planFit`}>
      <View style={styles.rows} accessibilityRole="list">
        {projection.accounts.map((account) => (
          <PlanRow
            key={account.key}
            account={account}
            name={nameOf(account)}
            nowMs={nowMs}
            target={target}
            compact={tile}
            serverId={props.serverId}
            testID={`${props.testID}.plan.${account.accountId}`}
          />
        ))}
      </View>
      <View style={styles.notRecorded} testID={`${props.testID}.notRecorded`}>
        {tile ? (
          <Text style={[styles.note, text.detail]} numberOfLines={2}>
            <Text style={styles.noteTitle}>{t('usage.board.plans.notRecordedTitle')}</Text>
            {` · ${[t('usage.board.plans.notRecordedValue'), t('usage.board.plans.notRecordedWhatIf'), t('usage.board.plans.notRecordedStrategy')].join(', ')}`}
          </Text>
        ) : null}
        {tile ? null : <UsagePlanSectionHead title={t('usage.board.plans.notRecordedTitle')} />}
        {tile ? null : (
          [
            ['usage.board.plans.notRecordedValue', 'usage.board.plans.planValueInsufficient'],
            ['usage.board.plans.notRecordedWhatIf', 'usage.board.plans.notRecordedWhatIfReason'],
            ['usage.board.plans.notRecordedStrategy', 'usage.board.plans.notRecordedStrategyReason'],
          ] as const
        ).map(([title, reason]) => (
          <Text key={title} style={[styles.note, text.detail]}>
            <Text style={styles.noteTitle}>{t(title)}</Text>
            {` · ${t(reason)}`}
          </Text>
        ))}
      </View>
      <UsageCoverageLine
        slice={props.slice}
        sources={['quota']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
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
  }>,
) {
  const { account, nowMs } = props;
  const text = usePlanText();
  const fit = summarizeUsagePlanFit(account, props.target);
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
  const priceText = price.paid
    ? t('usage.board.plans.planPaid', {
        amount: formatUsageCost(price.paid.amount, price.paid.currency),
      })
    : price.list
      ? t('usage.board.plans.planList', {
          amount: formatUsageCost(price.list.amount, price.list.currency),
          date: new Date(price.list.asOfMs).toLocaleDateString([], {
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
  return (
    <View
      testID={props.testID}
      style={styles.row}
      accessibilityLabel={[props.name.title, priceText, periodText, paceText].filter(Boolean).join(', ')}
    >
      <View style={styles.rowIdentity}>
        <UsagePlanIdentity name={props.name} />
      </View>
      <View style={styles.rowFacts}>
        <Text
          style={[
            styles.price,
            text.title,
            !price.paid && !price.list ? styles.quiet : null,
          ]}
          numberOfLines={1}
        >
          {priceText}
        </Text>
        <Text
          style={[styles.period, text.detail, ending ? styles.warning : null]}
          numberOfLines={2}
        >
          {periodText}
        </Text>
        {props.compact ? null : (
          <UsageBillingButton account={account} serverId={props.serverId} testID={`${props.testID}.billing`} />
        )}
      </View>
      <View style={styles.rowFit}>
        {paceText && !props.compact ? (
          <Text style={[styles.fit, text.detail]} numberOfLines={2}>
            {paceText}
          </Text>
        ) : null}
        <Text
          testID={fit.observed === 0 ? `${props.testID}.fit.insufficient` : `${props.testID}.fit`}
          accessibilityLabel={`${t('usage.board.plans.fitTitle')}: ${fitText}`}
          style={[fit.observed === 0 ? styles.period : styles.fit, text.detail]}
          numberOfLines={props.compact ? 2 : 3}
        >
          {`${t('usage.board.plans.fitTitle')} · ${fitText}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 14 },
  rows: { gap: 0 },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 16,
    rowGap: 4,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  rowIdentity: { flexGrow: 1, flexBasis: 180, minWidth: 0 },
  rowFacts: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 0,
    alignItems: 'flex-end',
  },
  rowFit: { flexBasis: '100%', gap: 2 },
  fit: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  notRecorded: { gap: 4 },
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
