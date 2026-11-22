import * as React from 'react';
import { UsageExactHistoryDemandContext } from '../usageMountedControls';
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
import { t } from '@/text';
import { connectedServicePoolExclusionText } from '@/components/sessions/connectedServices/diagnostics/poolExclusionPresentation';
import type { UsageQueryResultSlice, UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  canRetryUsageCoverageFailure,
  isUsageCoverageFailure,
  isUsageQuotaOwnershipUnproven,
  readUsageCoverageGaps,
  usageCoverageLineMode,
  usagePartialHistoryLabel,
  usageSourceTitle,
  UsageBodyReading,
} from '../usageBodyKit';
import { useUsageWidgetPageHasCoverageDetail } from '../usageWidgetBatch';
import { useUsageDisclosureCommand, useUsageRetryCommand } from '../usageMountedControls';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { UsagePlanAccount, UsagePlanWindow } from './usagePlansModel';
import type { UsagePlanAccountName } from './useUsagePlans';
import { formatMoment } from '@/utils/datetime/formatMoment';

type PlanAccountReadKind = 'failed' | 'pending' | 'partial';

function isOwnershipUnproven(account: UsagePlanAccount): boolean {
  return isUsageQuotaOwnershipUnproven(account.state);
}

/** One account's read; a current, complete read says nothing. */
function planAccountReadKind(account: UsagePlanAccount): PlanAccountReadKind | null {
  const status = account.state.status;
  if (isUsageCoverageFailure(account.state)) return 'failed';
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
): Readonly<{ kind: PlanAccountReadKind; reason: string; asOf: number | null; accounts: number; canRetry: boolean }> | null {
  const ownershipNames: string[] = [];
  const affected: { account: UsagePlanAccount; kind: PlanAccountReadKind }[] = [];
  for (const account of accounts) {
    if (isOwnershipUnproven(account)) {
      ownershipNames.push(nameOf(account).title);
      continue;
    }
    const kind = planAccountReadKind(account);
    if (kind) affected.push({ account, kind });
  }
  if (affected.length === 0 && ownershipNames.length === 0) return null;

  const kind: PlanAccountReadKind = affected.some((entry) => entry.kind === 'failed') ? 'failed'
    : affected.some((entry) => entry.kind === 'pending') ? 'pending' : 'partial';
  const reasons: string[] = [];
  if (ownershipNames.length > 0) {
    reasons.push(t('connectedServices.errors.quotaOwnershipUnproven', { accounts: ownershipNames.join(', ') }));
  }
  if (affected.length > 0) {
    const sources = kind === 'pending' ? t('connectedServices.purposeTargets.poolAccounts', { count: readPendingPlanAccountCount(accounts) })
      : affected.length === accounts.length && accounts.length > 1
      ? usageSourceTitle('quota')
      : affected.map((entry) => nameOf(entry.account).title).join(', ');
    // An older reading is said by its time (the line's "As of"), not as partial history: only an account with no
    // current reading makes the history partial (acceptance 11-22 #24).
    const partialHistory = affected.some((entry) => !entry.account.read?.current);
    if (kind !== 'partial') reasons.push(t(kind === 'failed' ? 'usage.board.page.coverageFailed' : 'usage.board.page.coveragePending', { sources }));
    else if (partialHistory) reasons.push(usagePartialHistoryLabel());
  }
  const times = affected
    .map((entry) => entry.account.read?.current ? entry.account.state.asOfMs ?? entry.account.observedAtMs : null)
    .filter((time): time is number => typeof time === 'number');
  return {
    kind: ownershipNames.length > 0 ? 'failed' : kind,
    reason: reasons.join(' · '),
    asOf: times.length ? Math.min(...times) : null,
    accounts: affected.length + ownershipNames.length,
    canRetry: ownershipNames.length > 0 || kind === 'failed'
      ? affected.some(({ account }) => canRetryUsageCoverageFailure(account.state))
      : kind === 'partial',
  };
}

/**
 * The header states the page's shared read. A first read still in flight can use
 * a skeleton to hold the body's room while the header says what it is waiting for.
 */
export function planAccountStatesMode(
  kind: PlanAccountReadKind,
  pageHasDetail: boolean,
  replacesContent: boolean,
  sources: readonly UsageQuerySourceState[],
): 'line' | 'reading' | 'reason' | 'hidden' {
  if (!pageHasDetail || usageCoverageLineMode(sources, pageHasDetail) !== 'hidden') return 'line';
  if (!replacesContent) return 'hidden';
  // Nothing else in the body: a pending read holds its room, and a settled failure still says why in one line (the
  // header's reason, its Retry staying in the header), never a title over nothing (acceptance 11-22 #21).
  return kind === 'pending' ? 'reading' : kind === 'failed' ? 'reason' : 'hidden';
}

/**
 * A plan body's read state, said once: one quiet line under the content with one Retry, for every
 * account whose read is not current, else the body's source coverage. Columns keep their data or a calm
 * placeholder; none repeats the state.
 */
/** An account never read and not being read now: one collapsed "not read yet" line, never a row or segment (R1). */
export function isUsagePlanAccountSettledUnread(account: UsagePlanAccount): boolean {
  return account.observedAtMs === null && account.state.status !== 'pending' && !isOwnershipUnproven(account);
}

/**
 * Whether a plan body draws the account as a row or segment: only once it has a reading. A first read still in flight
 * is said by the body's reading line instead; drawn as a placeholder row, every account of a cold load grew the body
 * past its settled size and it shrank as never-read accounts collapsed (Plans #5 Capacity 838 → 400, #7 Plan fit).
 */
export function isUsagePlanAccountDrawn(account: UsagePlanAccount): boolean {
  return account.observedAtMs !== null;
}

/**
 * An account with no reading yet whose first read is in flight: neither drawn nor settled unread. A re-read of an
 * account that has a reading is not one; its last reading stands while it refreshes.
 */
export function isUsagePlanAccountFirstReading(account: UsagePlanAccount): boolean {
  return account.observedAtMs === null && account.state.status === 'pending';
}

export function UsagePlanAccountStates(props: Readonly<{
  accounts: readonly UsagePlanAccount[];
  nameOf(account: UsagePlanAccount): UsagePlanAccountName;
  slice: UsageQueryResultSlice;
  testID: string;
  onRetry(callerContext?: ActionExecutorContext): void | Promise<unknown>;
  /** True when nothing else is drawn in the body: a pending read then holds the body's room. */
  replacesContent?: boolean;
  /** The headline already names this pending read; hold the footer's room quietly. */
  pendingInHeadline?: boolean;
}>) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const statement = readPlanAccountsStatement(props.accounts, props.nameOf);
  const mode = statement ? planAccountStatesMode(statement.kind, pageHasDetail, props.replacesContent === true,
    props.accounts.map(account => account.state)) : 'hidden';
  const retry = useUsageRetryCommand(props.onRetry, mode === 'line' && statement?.canRetry === true);
  if (statement?.kind === 'pending' && props.pendingInHeadline) {
    // Holds the room the settled coverage line takes. The Usage page names coverage once in its header and
    // draws no such line when settled, so it holds none (else the body would shrink by the line at settle).
    return pageHasDetail ? null : <View style={{ minHeight: HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx }} />;
  }
  if (!statement) {
    return <UsageCoverageLine slice={props.slice} sources={['quota']} onRetry={props.onRetry} testID={`${props.testID}.coverage`} />;
  }
  if (mode === 'reading') return <UsageBodyReading testID={`${props.testID}.loading`} />;
  if (mode === 'reason') return <UsageBodyInsufficient testID={`${props.testID}.reason`} title={statement.reason} />;
  if (mode === 'hidden') return null;
  const pending = statement.kind === 'pending';
  return <SurfaceFreshnessLine testID={props.testID} asOf={statement.asOf} reason={statement.reason} busy={pending}
    tone={statement.kind === 'failed' ? 'warning' : 'neutral'}
    {...(statement.canRetry ? { action: { label: t('common.retry'), onPress: retry } } : {})} />;
}

export function formatPlanPercent(fraction: number): string {
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
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

/** Observed exhaustion takes priority over a forecast, for every window presentation. */
export function planWindowStatement(
  window: UsagePlanWindow,
  nowMs: number,
): Readonly<{ kind: 'used_up' | 'depletes' | 'at_reset' | 'unavailable'; text: string; tone: 'quiet' | 'warning' }> {
  if (window.remainingFraction !== null && window.remainingFraction <= 0) {
    return {
      kind: 'used_up',
      text: [t('usage.board.plans.cellUsedUp'), window.resetAtMs === null ? null
        : t('usage.board.plans.excludedBack', { time: formatMoment(window.resetAtMs, nowMs) })].filter(Boolean).join(' · '),
      tone: 'warning',
    };
  }
  if (window.pace) {
    if (window.pace.depletesAtMs !== null) {
      return {
        kind: 'depletes',
        text: t('usage.board.plans.projectionRunsOut', {
          time: formatMoment(window.pace.depletesAtMs, nowMs),
        }),
        tone: 'warning',
      };
    }
    return {
      kind: 'at_reset',
      text: t('usage.board.plans.projectionAtReset', {
        percent: formatPlanPercent(window.pace.projectedRemainingFraction),
      }),
      tone: 'quiet',
    };
  }
  return {
    kind: 'unavailable',
    text: t(PACE_REASON_KEYS[window.paceUnavailable ?? 'not_derived']),
    tone: 'quiet',
  };
}


export function planExclusionText(
  reason: string,
  retryAtMs: number | null,
  nowMs: number,
): string {
  const base = connectedServicePoolExclusionText(reason);
  return retryAtMs !== null && retryAtMs > nowMs
    ? `${base} · ${t('usage.board.plans.excludedBack', { time: formatMoment(retryAtMs, nowMs) })}`
    : base;
}

/** An account as people know it: the service's bare mark, its plan or name, and the identity beside it. */
export function UsagePlanIdentity(
  props: Readonly<{
    name: UsagePlanAccountName;
    detail?: string | null;
    testID?: string;
    compact?: boolean;
    /**
     * A narrow column (a Capacity cell): the name and the identity that tells same-name accounts apart take a
     * line each, so "Leeroy · codex3@happier.dev" never breaks across three lines mid-address.
     */
    column?: boolean;
  }>,
) {
  const text = usePlanText();
  // The name and the identity that tells same-name accounts apart ("Leeroy Brun", "leeroy@batiplus.ch") each keep one
  // line: in a narrow column the identity goes under the name, elsewhere it follows it on the same line and gives way
  // first. Cut at its end, an address keeps its local part whole and gives up its domain (acceptance 11-21 #4: a middle
  // cut left "c…ier.dev", a wrap broke every address at "@").
  const split = (props.column || props.compact) && props.name.primaryLabel && props.name.identity
    ? { primary: props.name.primaryLabel, identity: props.name.identity } : null;
  const qualifier = [props.name.qualifier, props.detail]
    .filter(Boolean)
    .join(' · ');
  // A title with an address in it ("we-are@happier.dev", "leeroy@gmail.com's Account") keeps one line for the same
  // reason; a name of words wraps at a space instead of being cut, so "ChatGPT account 2" never reads as "ChatGPT account".
  const addressTitle = !split && props.name.title.includes('@');
  const title = (
    <ConnectedAccountIdentityText
      value={split ? split.primary : props.compact ? props.name.title : props.name.primaryLabel ?? props.name.title}
      style={[styles.identityTitle, text.title, split && !props.column ? styles.identityLead : null]}
      numberOfLines={split || addressTitle ? 1 : props.compact ? 3 : 2}
    />
  );
  const mark = (
    <View style={styles.identityMark}>
      <ConnectedServiceMark
        service={props.name.service}
        legacyServiceId={props.name.legacyServiceId}
        size="inline"
      />
    </View>
  );
  if (split && props.column) {
    // A narrow cell: the mark and the name, then the address on its own line from the cell's edge, so the whole cell
    // width goes to the part that tells same-name accounts apart.
    return (
      <View testID={props.testID} style={styles.identityStack}>
        <View style={styles.identity}>{mark}<View style={[styles.identityText, styles.identityColumn]}>{title}</View></View>
        <ConnectedAccountIdentityText value={split.identity} style={[styles.identityQualifier, text.detail]} numberOfLines={1} />
      </View>
    );
  }
  return (
    <View testID={props.testID} style={styles.identity}>
      {mark}
      <View style={[styles.identityText, split || addressTitle && (props.column || props.compact) ? styles.identityColumn : null]}>
        {split ? (
          <View style={styles.identityLine}>
            {title}
            <Text style={[styles.identityTitle, text.title, styles.identitySeparator]}>·</Text>
            <ConnectedAccountIdentityText value={split.identity} style={[styles.identityTitle, text.title, styles.identityTrail]}
              numberOfLines={1} />
          </View>
        ) : title}
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
    /** Unsupported secondary insights share one quiet statement, without another empty card. */
    missing?: readonly string[];
    /**
     * With nothing connected: the one line on what this widget will show (owner 10-31 first-run rules). Capacity
     * owns the cause ("No subscription connected") and says this line under it; a widget derived from the same
     * allowances says only this line, so a view of several never repeats the cause (Plans ×4).
     */
    promise: string;
    ownsCause?: boolean;
    onRetry?: (callerContext?: ActionExecutorContext) => void | Promise<unknown>;
  }>,
) {
  const router = useRouter();
  const text = usePlanText();
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const signInVisible = !props.missing && !!props.slice && props.replacesContent !== false && !!props.ownsCause
    && readUsageCoverageGaps(props.slice, ['quota']).every(gap => gap.status !== 'error' && gap.status !== 'pending' && gap.status !== 'not_loaded');
  const commands = useCurrentUiContextLocalCommands(signInVisible ? [{ key: 'signIn', title: t('usage.board.plans.capacitySignIn'),
    invoke: () => router.push(SETTINGS_ROUTES.connectedServicesAgentSignIn as Parameters<typeof router.push>[0]) }] : []);
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
  const reading = <UsageBodyReading testID={`${props.testID}.loading`} />;
  if (outstanding && pageHasDetail) return reading;
  if (outstanding) return <>{reading}{coverage}</>;
  // Settled with no account and nothing failed: nothing is connected. The body is the widget empty state every
  // frame uses (sized by the frame: the connect scene with room, one line when compact). Capacity owns the cause
  // and carries the one sign-in (58d AF1); Home's Get set up drops its own item while Capacity is placed. The
  // widgets derived from it say only what they will show, in one quiet line: the scene belongs to the cause, so a
  // page with Limits never draws a second empty scene beside it. A history qualifier means nothing when nothing was read.
  if (props.replacesContent !== false && !gaps.some((gap) => gap.status === 'error')) {
    return (
      <SurfaceStateCard
        testID={props.testID}
        kind="empty"
        replacesContent
        {...(props.ownsCause ? { scene: 'connectAccount' as const } : { layout: 'inline' as const, size: 'line' as const })}
        title={props.ownsCause ? t('usage.board.plans.capacitySignInTitle') : props.promise}
        {...(props.ownsCause ? {
          reason: props.promise,
          action: {
            label: t('usage.board.plans.capacitySignIn'),
            testID: `${props.testID}.signIn`,
            onPress: () => { void commands.invoke('signIn'); },
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
    // In a wrapping row (a Used-first title) the name and its detail wrap inside the row instead of running under the value.
    maxWidth: '100%',
  },
  identityMark: { flexShrink: 0 },
  identityStack: { minWidth: 0, gap: theme.space.s2 },
  identityText: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s6,
  },
  // One stretched, unwrapped column: a wrapping column sizes its line to the widest child, so a one-line address
  // overflowed the cell instead of giving up its middle.
  identityColumn: { flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' },
  // The name, then its address on the same line: both one line, the address giving way first.
  identityLine: { flexDirection: 'row', alignItems: 'baseline', minWidth: 0, columnGap: theme.space.s4 },
  identityLead: { flexShrink: 1, minWidth: 0 },
  identitySeparator: { flexShrink: 0 },
  identityTrail: { flexShrink: 100, minWidth: 0 },
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
  disclosureLabel: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space.s6, flexShrink: 1, minWidth: 0 },
  disclosureTitle: { flexShrink: 0 },
  disclosureRow: { alignSelf: 'stretch', flex: 1, minWidth: 0, alignItems: 'flex-start' },
  disclosureRowLabel: { flex: 1, minWidth: 0, gap: theme.space.s4 },
  disclosureRowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s16 },
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
  props: Readonly<{
    title: string;
    /** What assistive tech and commands call it when the drawn title leans on its widget ("Exact values"). */
    name?: string;
    meta?: string | null;
    /**
     * The row this disclosure opens from (a plan's identity and its quiet line), drawn in place of the title, which
     * then names it for assistive tech. A row's figure stays beside it in `trailing`, outside the press target.
     */
    label?: React.ReactNode;
    trailing?: React.ReactNode;
    testID: string;
    children: React.ReactNode;
    loadExactHistory?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const reducedMotion = useReducedMotionPreference();
  const [expanded, setExpanded] = React.useState(false);
  const acquireExactHistory = React.useContext(UsageExactHistoryDemandContext);
  React.useEffect(() => expanded && props.loadExactHistory ? acquireExactHistory?.() : undefined,
    [expanded, props.loadExactHistory, acquireExactHistory]);
  const name = props.name ?? props.title;
  const toggle = useUsageDisclosureCommand(name, expanded, () => setExpanded(value => !value));
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={toggle}
      showDivider={false}
      bodyStyle={styles.disclosureBody}
      header={({ headerProps }) => {
        const pressable = (
        <HappierPressable
          testID={`${props.testID}-header`}
          onPress={headerProps.onPress}
          accessibilityRole="button"
          accessibilityLabel={[name, props.meta].filter(Boolean).join(', ')}
          expanded={expanded}
          style={(state) => [
            styles.disclosureHeader,
            props.label ? styles.disclosureRow : null,
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
          {/* The title never wraps beside its meta: where both do not fit (a phone) the meta moves beneath it. */}
          {props.label ? <View style={styles.disclosureRowLabel}>{props.label}</View> : <View style={styles.disclosureLabel}>
            <Text style={[styles.sectionTitle, styles.disclosureTitle, text.title]} numberOfLines={1}>{props.title}</Text>
            {props.meta ? <Text style={[styles.sectionMeta, text.detail]}>{props.meta}</Text> : null}
          </View>}
        </HappierPressable>
        );
        return props.trailing ? <View style={styles.disclosureRowHead}>{pressable}{props.trailing}</View> : pressable;
      }}
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
