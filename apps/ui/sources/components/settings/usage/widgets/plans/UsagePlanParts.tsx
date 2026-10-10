import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '@/components/settings/connectedServices/account/accountBlockFormatters';
import { Text } from '@/components/ui/text/Text';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierDisclosureChevron,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { formatResetCountdown } from '@/sync/domains/connectedServices/formatResetCountdown';
import { t } from '@/text';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  readUsageCoverageGaps,
} from '../usageBodyKit';
import type { UsagePlanWindow } from './usagePlansModel';
import type { UsagePlanAccountName } from './useUsagePlans';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function formatPlanPercent(fraction: number): string {
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
}

/** A reset or ending moment: a clock time today, a weekday and time this week, else a date. */
export function formatPlanMoment(atMs: number, nowMs: number): string {
  const when = new Date(atMs);
  const time = when.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (atMs - nowMs < DAY_MS && when.getDate() === new Date(nowMs).getDate())
    return time;
  if (atMs - nowMs < 6 * DAY_MS)
    return `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return when.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "in 2h 15m" through the one countdown owner. */
export function formatPlanCountdown(
  atMs: number | null,
  nowMs: number,
): string | null {
  return formatResetCountdown(nowMs, atMs, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
}

const PACE_REASON_KEYS = {
  not_derived: 'usage.board.plans.paceNotDerived',
  not_loaded: 'usage.board.plans.paceNotLoaded',
  stale: 'usage.board.plans.paceStale',
  unknown_window: 'usage.board.plans.paceUnknownWindow',
  zero_elapsed: 'usage.board.plans.paceJustStarted',
  outside_window: 'usage.board.plans.paceOutsideWindow',
  unknown_utilization: 'usage.board.plans.paceUnknownUsage',
  inconsistent_counters: 'usage.board.plans.paceCountersDisagree',
  counter_reset: 'usage.board.plans.paceCounterReset',
  reset_changed: 'usage.board.plans.paceResetMoved',
  denominator_changed: 'usage.board.plans.paceLimitChanged',
  entitlement_changed: 'usage.board.plans.pacePlanChanged',
  non_renewing_end: 'usage.board.plans.pacePlanEnds',
} as const;

/** A pace or ended-window reason in words; the owners' vocabularies share these keys. */
export function planPaceReasonText(reason: string): string {
  if (reason === 'unknown_denominator') return t('usage.board.plans.paceLimitUnknown');
  const key = (PACE_REASON_KEYS as Readonly<Record<string, (typeof PACE_REASON_KEYS)[keyof typeof PACE_REASON_KEYS]>>)[reason];
  return key ? t(key) : t('usage.board.plans.endedUnusedInsufficient');
}

/** The one statement right of a window's meter: where this pace lands, or why there is no pace. */
export function planWindowStatement(
  window: UsagePlanWindow,
  nowMs: number,
): Readonly<{ text: string; tone: 'quiet' | 'warning' }> {
  if (window.pace) {
    if (window.pace.depletesAtMs !== null) {
      return {
        text: t('usage.board.plans.projectionRunsOut', {
          time: formatPlanMoment(window.pace.depletesAtMs, nowMs),
        }),
        tone: 'warning',
      };
    }
    return {
      text: t('usage.board.plans.projectionAtReset', {
        percent: formatPlanPercent(window.pace.projectedRemainingFraction),
      }),
      tone: 'quiet',
    };
  }
  return {
    text: t(PACE_REASON_KEYS[window.paceUnavailable ?? 'not_derived']),
    tone: 'quiet',
  };
}

const EXCLUSION_KEYS: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  quota_exhausted: 'usage.board.plans.excludedUsedUp',
  cooldown: 'usage.board.plans.excludedCooldown',
  auth_invalid: 'usage.board.plans.excludedSignIn',
  credential_unavailable: 'usage.board.plans.excludedUnavailable',
  disabled: 'usage.board.plans.excludedOff',
  capacity_limited: 'usage.board.plans.excludedCapacity',
  plan_unavailable: 'usage.board.plans.excludedUnavailable',
  validation_blocked: 'usage.board.plans.excludedUnavailable',
  policy_wait_until_reset: 'usage.board.plans.excludedWaitReset',
  current_active: 'usage.board.plans.usedFirstInUse',
};

export function planExclusionText(
  reason: string,
  retryAtMs: number | null,
  nowMs: number,
): string {
  const base = t(
    EXCLUSION_KEYS[reason] ?? 'usage.board.plans.excludedUnavailable',
  );
  return retryAtMs !== null && retryAtMs > nowMs
    ? `${base} · ${t('usage.board.plans.excludedBack', { time: formatPlanMoment(retryAtMs, nowMs) })}`
    : base;
}

/** An account as people know it: the service's bare mark, its plan or name, and the identity beside it. */
export function UsagePlanIdentity(
  props: Readonly<{
    name: UsagePlanAccountName;
    detail?: string | null;
    testID?: string;
    compact?: boolean;
  }>,
) {
  const text = usePlanText();
  const qualifier = [props.name.qualifier, props.detail]
    .filter(Boolean)
    .join(' · ');
  return (
    <View testID={props.testID} style={styles.identity}>
      <ConnectedServiceMark
        legacyServiceId={props.name.legacyServiceId}
        size="inline"
      />
      <View style={styles.identityText}>
        <ConnectedAccountIdentityText
          value={props.name.title}
          style={[styles.identityTitle, text.title]}
          numberOfLines={1}
        />
        {qualifier && !props.compact ? (
          <ConnectedAccountIdentityText
            value={qualifier}
            style={[styles.identityQualifier, text.detail]}
            numberOfLines={1}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * No allowance to show. While the allowance read is still outstanding that is all this says, on one
 * held line: an unanswered read is not "none". Only an answered read with nothing in it invites the
 * viewer to connect an account.
 */
export function UsagePlansNothingRead(
  props: Readonly<{
    testID: string;
    slice: UsageQueryResultSlice;
    onRetry?: () => void | Promise<unknown>;
  }>,
) {
  const router = useRouter();
  const gaps = readUsageCoverageGaps(props.slice, ['quota']);
  const outstanding =
    gaps.length > 0 &&
    gaps.every((gap) => gap.status === 'pending' || gap.status === 'not_loaded');
  const coverage = (
    <UsageCoverageLine
      slice={props.slice}
      sources={['quota']}
      {...(props.onRetry ? { onRetry: props.onRetry } : {})}
      testID={`${props.testID}.coverage`}
    />
  );
  if (outstanding) return coverage;
  return (
    <View style={styles.nothingRead}>
      <UsageBodyInsufficient
        testID={props.testID}
        title={t('usage.board.plans.capacityNoReads')}
        reason={t('usage.board.plans.capacityNoReadsReason')}
        action={{
          label: t('usage.board.plans.openConnectedServices'),
          onPress: () =>
            router.push(
              SETTINGS_ROUTES.connectedServices as Parameters<
                typeof router.push
              >[0],
            ),
        }}
      />
      {coverage}
    </View>
  );
}

/** One quiet legend line, said once under the meters it explains. */
export function UsagePlanLegend(
  props: Readonly<{ parts: readonly string[]; testID?: string }>,
) {
  const text = usePlanText();
  return (
    <Text testID={props.testID} style={[styles.legend, text.detail]}>
      {props.parts.join(' · ')}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  nothingRead: { gap: 12 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  identityText: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: 6,
  },
  identityTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  identityQualifier: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  legend: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  sectionHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 8,
    rowGap: 2,
  },
  sectionTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  sectionMeta: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  sectionAction: { marginLeft: 'auto' },
  disclosureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderRadius: theme.borderRadius.sm,
  },
  disclosureBody: { paddingTop: 8 },
  rank: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  rankSelected: {
    backgroundColor: theme.colors.text.primary,
    borderColor: theme.colors.text.primary,
  },
  rankText: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  rankTextSelected: { color: theme.colors.surface.base },
}));

/**
 * The Plans bodies' two text steps, from the shared page-row owner at the viewer's density: a row's
 * title and its quiet second line. No body carries its own point sizes.
 */
export function usePlanText(): Readonly<{
  title: Readonly<{ fontSize: number; lineHeight: number }>;
  detail: Readonly<{ fontSize: number; lineHeight: number }>;
}> {
  const metrics = usePageRowMetrics('list');
  return React.useMemo(
    () => ({
      title: { fontSize: metrics.title.fontSize, lineHeight: metrics.title.lineHeight },
      detail: { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight },
    }),
    [metrics],
  );
}

/** A section inside one body: its name, one quiet qualifier, and at most one action at the far end. */
export function UsagePlanSectionHead(
  props: Readonly<{ title: string; meta?: string | null; action?: React.ReactNode; testID?: string }>,
) {
  const text = usePlanText();
  return (
    <View testID={props.testID} style={styles.sectionHead}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, text.title]}>
        {props.title}
      </Text>
      {props.meta ? (
        <Text style={[styles.sectionMeta, text.detail]} numberOfLines={2}>
          {props.meta}
        </Text>
      ) : null}
      {props.action ? <View style={styles.sectionAction}>{props.action}</View> : null}
    </View>
  );
}

/**
 * Detail behind one quiet line, on the shared disclosure contract. The body mounts only while open, so
 * a closed disclosure builds none of its rows.
 */
export function UsagePlanDisclosure(
  props: Readonly<{ title: string; meta?: string | null; testID: string; children: React.ReactNode }>,
) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const reducedMotion = useReducedMotionPreference();
  const [expanded, setExpanded] = React.useState(false);
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={false}
      bodyStyle={styles.disclosureBody}
      header={({ headerProps }) => (
        <HappierPressable
          testID={`${props.testID}-header`}
          onPress={headerProps.onPress}
          accessibilityRole="button"
          accessibilityLabel={[props.title, props.meta].filter(Boolean).join(', ')}
          expanded={expanded}
          hitSlop={10}
          style={(state) => [
            styles.disclosureHeader,
            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
          ]}
        >
          <HappierDisclosureChevron
            expanded={expanded}
            color={theme.colors.text.secondary}
            size={12}
            reducedMotion={reducedMotion}
          />
          <Text style={[styles.sectionTitle, text.title]}>{props.title}</Text>
          {props.meta ? <Text style={[styles.sectionMeta, text.detail]}>{props.meta}</Text> : null}
        </HappierPressable>
      )}
    >
      {props.children}
    </ExpandableItem>
  );
}

/** A member's place in its pool's own order; filled for the member in use, a dash for a skipped one. */
export function UsagePlanRank(props: Readonly<{ rank: number | null; selected?: boolean }>) {
  const text = usePlanText();
  return (
    <View style={[styles.rank, props.selected ? styles.rankSelected : null]} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={[styles.rankText, { fontSize: text.detail.fontSize - 1, lineHeight: text.detail.lineHeight - 2 }, props.selected ? styles.rankTextSelected : null]}>
        {props.rank ?? '–'}
      </Text>
    </View>
  );
}
