import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '@/components/settings/connectedServices/account/accountBlockFormatters';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  HAPPIER_PRESS_FEEDBACK_V1,
  HAPPIER_FRESHNESS_LINE_METRICS,
  HappierDisclosureChevron,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { formatResetCountdown, formatResetCountdownPhrase } from '@/sync/domains/connectedServices/formatResetCountdown';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  readUsageCoverageGaps,
  usageCoverageLineMode,
  usagePartialHistoryLabel,
  usageSourceTitle,
  UsageBodyReading,
} from '../usageBodyKit';
import { useUsageWidgetPageHasCoverageDetail } from '../usageWidgetBatch';
import { useUsageDisclosureCommand } from '../usageMountedControls';
import type { UsagePlanAccount, UsagePlanWindow } from './usagePlansModel';
import type { UsagePlanAccountName } from './useUsagePlans';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type PlanAccountReadKind = 'failed' | 'pending' | 'partial';

/** One account's read; a current, complete read says nothing. */
function planAccountReadKind(account: UsagePlanAccount): PlanAccountReadKind | null {
  const status = account.state.status;
  if (status === 'error') return 'failed';
  if (status === 'pending') return 'pending';
  if (account.read?.current && account.observedAtMs !== null && status !== 'stale') return null;
  return 'partial';
}

/** The same outstanding-account count for a plan headline and its read-state line. */
export function readPendingPlanAccountCount(accounts: readonly UsagePlanAccount[]): number {
  return accounts.filter(account => planAccountReadKind(account) === 'pending').length;
}

/**
 * A plan body's accounts usually share one read: four columns each saying "Partial … Retry" say one
 * thing four times. This folds every affected account into one statement: a failure leads, "Still
 * reading" while any is unanswered, and partial coverage only after all accounts answer.
 */
export function readPlanAccountsStatement(
  accounts: readonly UsagePlanAccount[],
  nameOf: (account: UsagePlanAccount) => UsagePlanAccountName,
): Readonly<{ kind: PlanAccountReadKind; reason: string; asOf: number | null; accounts: number }> | null {
  const affected = accounts.flatMap((account) => {
    const kind = planAccountReadKind(account);
    return kind ? [{ account, kind }] : [];
  });
  if (affected.length === 0) return null;
  const kind: PlanAccountReadKind = affected.some((entry) => entry.kind === 'failed') ? 'failed'
    : affected.some((entry) => entry.kind === 'pending') ? 'pending' : 'partial';
  const sources = kind === 'pending' ? t('connectedServices.purposeTargets.poolAccounts', { count: readPendingPlanAccountCount(accounts) })
    : affected.length === accounts.length && accounts.length > 1
    ? usageSourceTitle('quota')
    : affected.map((entry) => nameOf(entry.account).title).join(', ');
  const times = affected
    .map((entry) => entry.account.read?.current ? entry.account.state.asOfMs ?? entry.account.observedAtMs : null)
    .filter((time): time is number => typeof time === 'number');
  return {
    kind,
    reason: kind === 'partial' ? usagePartialHistoryLabel()
      : t(kind === 'failed' ? 'usage.board.page.coverageFailed' : 'usage.board.page.coveragePending', { sources }),
    asOf: times.length ? Math.min(...times) : null,
    accounts: affected.length,
  };
}

export type UsageReadingShape = React.ComponentProps<typeof UsageBodyReading>['shape'];

/**
 * The accounts a quota read already knows to expect: each has its own pending source before it
 * answers, so a list body can hold its rows' room from the first frame.
 */
export function readUsageKnownQuotaAccountCount(slice: Pick<UsageQueryResultSlice, 'sources'>): number {
  return slice.sources.filter(source => source.source.startsWith('quota:')).length;
}

/**
 * The Usage page names partial and pending reads once in its header and Sources, so a body keeps only
 * failures. A pending read of a body with nothing else to draw holds the body's room with the first-load
 * skeleton instead: the header never sits over a blank card.
 */
export function planAccountStatesMode(
  kind: PlanAccountReadKind,
  pageHasDetail: boolean,
  replacesContent: boolean,
): 'line' | 'reading' | 'hidden' {
  if (usageCoverageLineMode([{ status: kind === 'failed' ? 'error' : kind }], pageHasDetail) !== 'hidden') return 'line';
  return kind === 'pending' && replacesContent ? 'reading' : 'hidden';
}

/**
 * A plan body's read state, said once: one quiet line under the content with one Retry, for every
 * account whose read is not current, else the body's source coverage. Columns keep their data or a calm
 * placeholder; none repeats the state.
 */
/** An account never read and not being read now: one collapsed "not read yet" line, never a row or segment (R1). */
export function isUsagePlanAccountSettledUnread(account: UsagePlanAccount): boolean {
  return account.observedAtMs === null && account.state.status !== 'pending';
}

export function UsagePlanAccountStates(props: Readonly<{
  accounts: readonly UsagePlanAccount[];
  nameOf(account: UsagePlanAccount): UsagePlanAccountName;
  slice: UsageQueryResultSlice;
  testID: string;
  onRetry(): void | Promise<unknown>;
  /** True when nothing else is drawn in the body: a pending read then holds the body's room. */
  replacesContent?: boolean;
  /** The shape the body's skeleton holds while it reads (a list of meters), when it is known. */
  readingShape?: UsageReadingShape;
  /** The headline already names this pending read; hold the footer's room quietly. */
  pendingInHeadline?: boolean;
}>) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const statement = readPlanAccountsStatement(props.accounts, props.nameOf);
  if (statement?.kind === 'pending' && props.pendingInHeadline) {
    // Holds the room the settled coverage line takes. The Usage page names coverage once in its header and
    // draws no such line when settled, so it holds none (else the body would shrink by the line at settle).
    return pageHasDetail ? null : <View style={{ minHeight: HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx }} />;
  }
  if (!statement) {
    return <UsageCoverageLine slice={props.slice} sources={['quota']} onRetry={props.onRetry} testID={`${props.testID}.coverage`} />;
  }
  const mode = planAccountStatesMode(statement.kind, pageHasDetail, props.replacesContent === true);
  if (mode === 'reading') return <UsageBodyReading testID={`${props.testID}.loading`} {...(props.readingShape ? { shape: props.readingShape } : {})} />;
  if (mode === 'hidden') return null;
  const pending = statement.kind === 'pending';
  return <SurfaceFreshnessLine testID={props.testID} asOf={statement.asOf} reason={statement.reason} busy={pending}
    tone={statement.kind === 'failed' ? 'warning' : 'neutral'}
    {...(!pending ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})} />;
}

export function formatPlanPercent(fraction: number): string {
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
}

/** A plan moment: today's clock time, a nearby weekday and time, else its calendar date. */
export function formatPlanMoment(atMs: number, nowMs: number): string {
  const when = new Date(atMs);
  const now = new Date(nowMs);
  const locale = getPreferredLanguage();
  const time = formatWithCachedDateTimeFormatter(when, locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate())
    return time;
  if (Math.abs(atMs - nowMs) < 6 * DAY_MS)
    return `${formatWithCachedDateTimeFormatter(when, locale, { weekday: 'short' })} ${time}`;
  return formatWithCachedDateTimeFormatter(when, locale, {
    day: 'numeric',
    month: 'short',
    ...(when.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "in 2h 15m" through the one countdown owner. */
export function formatPlanCountdown(
  atMs: number | null,
  nowMs: number,
): string | null {
  return formatResetCountdown(nowMs, atMs, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
}

/** "resets in 2h 15m" while the reset is ahead; a passed one reads as the bare word. */
export function formatPlanResetPhrase(atMs: number | null, nowMs: number): string | null {
  return formatResetCountdownPhrase(nowMs, atMs, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER,
    (time) => t('connectedServicesCollection.meterResetsIn', { time }));
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
          // Two lines either way: in a narrow column (capacity segments, reset rows) a name wraps at a
          // space instead of being cut, so "ChatGPT account 2" never reads as "ChatGPT account".
          numberOfLines={2}
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
    slice?: UsageQueryResultSlice;
    /** False when other witnessed facts remain beside this allowance notice. */
    replacesContent?: boolean;
    /** The shape the body's skeleton holds while it reads, when it is known. */
    readingShape?: UsageReadingShape;
    /** Unsupported secondary insights share one quiet statement, without another empty card. */
    missing?: readonly string[];
    /**
     * With nothing connected: the one line on what this widget will show (owner 10-31 first-run rules). Capacity
     * owns the cause ("No subscription connected") and says this line under it; a widget derived from the same
     * allowances says only this line, so a view of several never repeats the cause (Plans ×4).
     */
    promise: string;
    ownsCause?: boolean;
    onRetry?: () => void | Promise<unknown>;
  }>,
) {
  const router = useRouter();
  const text = usePlanText();
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  if (props.missing) return props.missing.length ? (
    <Text testID={props.testID} style={[styles.legend, text.detail]}>
      {t('usage.board.plans.insufficientSummary', { items: [...new Set(props.missing)].join(', ') })}
    </Text>
  ) : null;
  if (!props.slice) return null;
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
  // The body holds its room with the first-load skeleton (lab kitstates "Loading · first time"), never a
  // blank card under a header. Once the Usage page's own detail has arrived its header says what is still
  // being read; before that (and on Home, a Board) the quiet line under the skeleton says it.
  const reading = <UsageBodyReading testID={`${props.testID}.loading`} {...(props.readingShape ? { shape: props.readingShape } : {})} />;
  if (outstanding && pageHasDetail) return reading;
  if (outstanding) return <>{reading}{coverage}</>;
  // Settled with no account and nothing failed: nothing is connected. The body is the widget empty state every
  // frame uses (sized by the frame: the connect scene with room, one line when compact). Capacity owns the cause
  // and carries the one sign-in (58d AF1); Home's Get set up drops its own item while Capacity is placed. The
  // widgets derived from it say only what they will show. A history qualifier means nothing when nothing was read.
  if (props.replacesContent !== false && !gaps.some((gap) => gap.status === 'error')) {
    return (
      <SurfaceStateCard
        testID={props.testID}
        kind="empty"
        replacesContent
        scene="connectAccount"
        title={props.ownsCause ? t('usage.board.plans.capacitySignInTitle') : props.promise}
        {...(props.ownsCause ? {
          reason: props.promise,
          action: {
            label: t('usage.board.plans.capacitySignIn'),
            testID: `${props.testID}.signIn`,
            onPress: () => router.push(SETTINGS_ROUTES.connectedServicesAgentSignIn as Parameters<typeof router.push>[0]),
          },
        } : {})}
      />
    );
  }
  return (
    <View style={styles.nothingRead}>
      <UsageBodyInsufficient
        testID={props.testID}
        replacesContent={props.replacesContent}
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
  nothingRead: { gap: theme.space.s12 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  identityText: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s6,
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
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
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
    gap: theme.space.s6,
    alignSelf: 'flex-start',
    borderRadius: theme.borderRadius.sm,
  },
  disclosureBody: { paddingTop: theme.space.s8 },
  rank: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: theme.space.s4,
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
  const toggle = () => setExpanded(value => !value);
  useUsageDisclosureCommand(props.title, expanded, toggle);
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
