import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { ChartDatum, formatHappierDataExactShare, HAPPIER_DATA_METRICS, HappierDataMetric, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { getPreferredLanguage, t } from '@/text';
import {
  UsageResetCelebration,
  type UsageResetCelebrationWindow,
} from './UsageResetCelebration';
import {
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import type { UsagePlanAccount, UsagePlanPool, UsagePlanWindow } from './plans/usagePlansModel';
import {
  useUsagePlans,
  useUsagePoolSelections,
  type UsagePlanAccountName,
  type UsagePoolSelectionState,
} from './plans/useUsagePlans';
import {
  formatPlanCountdown,
  formatPlanResetPhrase,
  formatPlanMoment,
  formatPlanPercent,
  planExclusionText,
  UsagePlanRank,
  UsagePlansNothingRead,
  UsagePlanIdentity,
  UsagePlanAccountStates,
  isUsagePlanAccountSettledUnread,
  readPendingPlanAccountCount,
  usePlanText,
} from './plans/UsagePlanParts';
import { UsagePoolQueue, UsagePoolSteps } from './plans/UsagePoolOrder';

/** Below this width the bar's cells wrap into a two-up grid instead of shrinking into slivers. */
const CELL_MIN_WIDTH_PX = 92;
/** Beside other widgets a segment of the one pooled bar keeps this much room for its label beneath it. */
const POOLED_SEGMENT_MIN_WIDTH_PX = 64;
/**
 * Under the pooled bar each account's label takes its segment's column. Below this much width per account (a
 * phone with four accounts) a column cannot hold a name, its figure and a note, so the bar stays one bar and
 * the accounts are listed one row each beneath it.
 */
const POOLED_COLUMN_LABEL_MIN_WIDTH_PX = 120;
/**
 * Beside other widgets (Overview, Settings › Overview, a Home tile) Capacity is one pooled bar with each
 * account's figure under its segment (lab `d2top-A`, `wgusage-CD`); at full width (Plans) each account
 * keeps its own cell in the per-account grid.
 */
const POOLED_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'tall']);



type Cell = Readonly<{
  account: UsagePlanAccount;
  rank: number | null;
  selected: boolean;
  excluded: string | null;
}>;
type Run = Readonly<{ pool: UsagePlanPool | null; cells: readonly Cell[] }>;

/** Only a run of two or more members is a group worth an outline; a pool of one reads as its account does. */
const isFramedRun = (run: Run) => run.pool !== null && run.cells.length > 1;

/**
 * The bar keeps the Account's own order. A pool's members sit together where its first member is, in
 * the selector's own preference order when that read answered; nothing is ranked across pools.
 */
function buildRuns(
  accounts: readonly UsagePlanAccount[],
  pools: readonly UsagePlanPool[],
  selections: ReadonlyMap<string, UsagePoolSelectionState>,
  nowMs: number,
): Run[] {
  const byKey = new Map(accounts.map((account) => [account.key, account]));
  const emitted = new Set<string>();
  const runs: Run[] = [];
  for (const account of accounts) {
    const memberships = pools.filter(pool => pool.accountKeys.includes(account.key));
    if (memberships.length === 0) {
      runs.push({
        pool: null,
        cells: [{ account, rank: null, selected: false, excluded: null }],
      });
      continue;
    }
    for (const pool of memberships) {
      if (emitted.has(pool.key)) continue;
      const selection = selections.get(pool.key);
      // A member that is not drawn (never read) is said once in the collapsed line, not as a segment.
      const members = pool.accountKeys.flatMap((key) => byKey.get(key) ?? []);
      if (members.length === 0) continue;
      let cells: Cell[] = members.map((member) => ({
        account: member,
        rank: null,
        selected: false,
        excluded: null,
      }));
      if (
        selection &&
        typeof selection === 'object' &&
        !('status' in selection)
      ) {
        const ordered =
          selection.selection.decisionTrace.orderedEligibleCandidates.map(
            (entry) => entry.profileId,
          );
        const selectedId = selection.selection.selected?.profileId ?? null;
        const excluded = new Map(
          selection.selection.excluded.map((entry) => [
            entry.profileId,
            planExclusionText(entry.reason, entry.retryAtMs ?? null, nowMs),
          ]),
        );
        const position = (accountId: string) => {
          const index = ordered.indexOf(accountId);
          return index < 0 ? Number.POSITIVE_INFINITY : index;
        };
        cells = [...members]
          .sort(
            (left, right) => position(left.accountId) - position(right.accountId),
          )
          .map((member) => ({
            account: member,
            rank: ordered.includes(member.accountId)
              ? ordered.indexOf(member.accountId) + 1
              : null,
            selected: member.accountId === selectedId,
            excluded: excluded.get(member.accountId) ?? null,
          }));
      }
      emitted.add(pool.key);
      runs.push({ pool, cells });
    }
  }
  return runs;
}

/** A run's identity as a list key: an account can belong to several pools, so the account's own key alone repeats across runs. */
function runKey(run: Run): string {
  return run.pool ? `pool:${run.pool.key}` : `account:${run.cells[0]!.account.key}`;
}

/**
 * The runs that sit alone in a two-up row: an account outside any framed pool, with no second account after
 * it before a framed pool (which takes the whole row) or the end.
 */
function readLoneHalfRuns(runs: readonly Run[]): ReadonlySet<Run> {
  const lone = new Set<Run>();
  let first: Run | null = null;
  const closeRow = () => { if (first) lone.add(first); first = null; };
  for (const run of runs) {
    if (isFramedRun(run)) { closeRow(); continue; }
    if (first) first = null;
    else first = run;
  }
  closeRow();
  return lone;
}

export function UsageCapacityWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const presentation = useWidgetPresentation();
  const width = presentation?.geometry?.width ?? null;
  // A tile says the order as Now → Next → Then (lab `p2pool` U2); the full body lists it with reasons (U1).
  const tile = presentation?.size === 'small';
  const text = usePlanText();
  const plans = useUsagePlans(props.slice, props.model.refresh);
  const { projection, nameOf, nowMs } = plans;
  const selections = useUsagePoolSelections(props.slice);
  useWidgetFrameBodyCaption(t('usage.board.plans.capacityCaption'));
  const pooled = POOLED_SIZES.has(presentation?.size ?? '');
  // Never-read accounts collapse into one quiet line; accounts in flight keep their segment's room.
  const drawn = React.useMemo(() => projection.accounts.filter((account) => !isUsagePlanAccountSettledUnread(account)), [projection.accounts]);
  const unreadCount = projection.accounts.length - drawn.length;
  const runs = React.useMemo(
    () => buildRuns(drawn, projection.pools, selections, nowMs),
    [drawn, projection.pools, selections, nowMs],
  );
  // Every window's latest reading, for the one witnessed-reset moment (lab `kitmotion` reset).
  const resetWindows = React.useMemo(
    (): readonly UsageResetCelebrationWindow[] =>
      projection.accounts.flatMap((account) =>
        account.windows.map((window) => ({
          key: window.key,
          resetAtMs: window.resetAtMs,
          remainingFraction: window.remainingFraction,
          name: nameOf(account).title,
          window: window.label,
        })),
      ),
    [projection.accounts, nameOf],
  );
  if (projection.accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
          ownsCause
          promise={t('usage.board.plans.capacityNoneConnectedPromise')}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  const tightest = projection.tightest;
  const tightestName = tightest ? nameOf(tightest.account) : null;
  const cellCount = drawn.length;
  // Under the pooled bar one cause is said once: when every drawn account's reading is old, "last read" joins
  // the headline's line (the oldest reading) instead of repeating under each segment.
  const everyStale = pooled && drawn.length > 1 && drawn.every((account) => account.stale && account.observedAtMs !== null);
  const oldestReadMs = everyStale ? Math.min(...drawn.map((account) => account.observedAtMs!)) : null;
  // Until the first allowance answers there is no tightest to name, but the headline's room is held: the
  // figure it will be and one quiet line ("Reading 5 accounts…"), so its arrival moves nothing below it.
  const pendingAccounts = readPendingPlanAccountCount(projection.accounts);
  const reading = tightest === null && pendingAccounts > 0;
  const provisionalReading = tightest?.provisional === true && pendingAccounts > 0;
  // One account: the headline says its figure and reset, and its cell under the bar names it (mark, name, plan),
  // so neither says the other's fact again. A state only the cell says (left out of a pool, an old reading)
  // keeps the ordinary cell.
  const lone = drawn.length === 1 && tightest !== null && tightest.account.key === drawn[0]!.key && !drawn[0]!.stale
    && runs.every((run) => run.cells.every((cell) => cell.excluded === null));
  const heroUnit = !tightestName ? ''
    : lone ? t('usage.board.plans.capacityLoneUnit')
    : t('usage.board.plans.capacityTightestUnit', { name: tightestName.title });
  // Equal cells while they fit; a narrow frame (a phone) wraps them two-up rather than shrinking them.
  const cellBasis =
    !pooled && width !== null && width / Math.max(1, cellCount) < CELL_MIN_WIDTH_PX ? ('46%' as const) : undefined;
  // In the two-up grid an odd account keeps its half: an empty half beside it, never a full-width track.
  const loneRuns = cellBasis ? readLoneHalfRuns(runs) : null;
  return (
    <View style={styles.body} testID={`${props.testID}.capacity`}>
      <UsageResetCelebration
        windows={resetWindows}
        burst={!tile}
        testID={`${props.testID}.resetBurst`}
      />
      {tightest && tightestName ? (
        <View style={styles.hero}>
          <View style={styles.heroLine}>
            <ChartDatum testID={`${props.testID}.tightest-datum`}
              datum={{ label: `${tightestName.title} · ${tightest.window.label}`,
                value: formatHappierDataExactShare(tightest.window.remainingFraction!, getPreferredLanguage()),
                subtitle: tightest.window.resetAtMs === null ? undefined : formatPlanResetPhrase(tightest.window.resetAtMs, nowMs) ?? undefined }}>
            <HappierDataMetric
              testID={`${props.testID}.tightest`}
              theme={chartTheme}
              size="hero"
              label={heroUnit}
              value={Math.round(tightest.window.remainingFraction! * 100)}
              valueFormatter={(value) => `${value}%`}
            /></ChartDatum>
            <Text style={[styles.heroUnit, text.title]} numberOfLines={2}>
              {heroUnit}
            </Text>
          </View>
          <Text style={[styles.subline, text.detail]} testID={provisionalReading ? `${props.testID}.reading` : undefined}>
            {[
              tightest.window.resetAtMs !== null
                ? t('usage.board.plans.capacityResets', {
                    time: formatPlanMoment(tightest.window.resetAtMs, nowMs),
                  })
                : null,
              provisionalReading
                ? t('usage.board.plans.capacityReading', { count: pendingAccounts })
                : tightest.provisional || lone ? null : t('usage.board.plans.capacityAccounts', { count: projection.readAccountCount }),
              oldestReadMs !== null ? t('usage.board.plans.cellStale', { time: formatPlanMoment(oldestReadMs, nowMs) }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ) : reading ? (
        <CapacityHeroReading count={pendingAccounts} testID={`${props.testID}.reading`} />
      ) : null}
      {pooled && runs.length > 0 ? (
        <CapacityPooledBar runs={runs} nameOf={nameOf} nowMs={nowMs} staleSaidOnce={everyStale} lone={lone} testID={props.testID}
          listed={width !== null && width / Math.max(1, cellCount) < POOLED_COLUMN_LABEL_MIN_WIDTH_PX} />
      ) : runs.length > 0 ? (
      <View style={styles.bar} accessibilityRole="list">
        {runs.map((run) => (
          <React.Fragment key={runKey(run)}>
            <View
              testID={isFramedRun(run) ? `${props.testID}.pool.${run.pool!.groupId}` : undefined}
              style={[
                styles.run,
                isFramedRun(run) ? styles.pool : null,
                cellBasis
                  ? { flexBasis: isFramedRun(run) ? '100%' : '47%', flexGrow: 1 }
                  : { flexGrow: run.cells.length, flexBasis: 0 },
              ]}
            >
              {run.cells.map((cell) => (
                <CapacityCell
                  key={cell.account.key}
                  cell={cell}
                  name={nameOf(cell.account)}
                  nowMs={nowMs}
                  lone={lone}
                  basis={isFramedRun(run) ? cellBasis : undefined}
                  testID={`${props.testID}.cell.${cell.account.accountId}`}
                />
              ))}
            </View>
            {loneRuns?.has(run) ? <View style={styles.halfSpacer} /> : null}
          </React.Fragment>
        ))}
      </View>
      ) : null}
      {unreadCount > 0 ? (
        <Text style={[styles.subline, text.detail]} testID={`${props.testID}.unread`}>
          {t('usage.board.plans.capacityNotRead', { count: unreadCount })}
        </Text>
      ) : null}
      {tile ? (
        <UsagePoolSteps
          serverId={props.serverId}
          query={props.query}
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.steps`}
        />
      ) : (
        <UsagePoolQueue
          serverId={props.serverId}
          query={props.query}
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.usedFirst`}
        />
      )}
      <UsagePlanAccountStates
        accounts={projection.accounts}
        nameOf={nameOf}
        slice={props.slice}
        onRetry={props.model.refresh}
        testID={`${props.testID}.state`}
        pendingInHeadline={reading || provisionalReading}
      />
    </View>
  );
}

/**
 * The one pooled bar (lab `d2top-A`): a segment per account side by side, a pool's members outlined together,
 * and under each segment its figure and plan. Only a state that changes what the viewer can do (excluded,
 * stale, used up) adds a line under the plan.
 */
function CapacityPooledBar(props: Readonly<{
  runs: readonly Run[]; nameOf: (account: UsagePlanAccount) => UsagePlanAccountName; nowMs: number;
  /** Every reading is old and the headline says so once; no segment repeats "last read". */
  staleSaidOnce: boolean; testID: string;
  /** The only account: the headline says its figure and reset (see {@link CapacityCell}). */
  lone: boolean;
  /** Too narrow for a label under each segment: the accounts are listed beneath the one bar, a row each. */
  listed: boolean;
}>) {
  const label = (run: Run, cell: Cell, listed: boolean) => (
    <CapacityCell key={`${runKey(run)}:${cell.account.key}`} cell={cell} name={props.nameOf(cell.account)} nowMs={props.nowMs}
      pooled staleSaidOnce={props.staleSaidOnce} lone={props.lone} {...(listed ? { listed } : {})} testID={`${props.testID}.cell.${cell.account.accountId}`} />
  );
  return (
    <>
      <View style={styles.pooledBar} accessibilityRole="list" testID={`${props.testID}.pooled`}>
        {props.runs.map((run) => (
          <View key={runKey(run)}
            testID={isFramedRun(run) ? `${props.testID}.pool.${run.pool!.groupId}` : undefined}
            style={[styles.pooledRun, { flexGrow: run.cells.length, minWidth: run.cells.length * POOLED_SEGMENT_MIN_WIDTH_PX }]}>
            <View style={[styles.pooledTrack, isFramedRun(run) ? styles.pooledTrackPool : null]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {run.cells.map((cell) => {
                const window = cell.account.headline;
                return (
                  <View key={cell.account.key} style={styles.pooledSegment}>
                    <MeterBar height={8} tone={window && window.tone !== 'success' ? window.tone : 'neutral'}
                      fillFraction={window?.remainingFraction ?? 0} {...(cell.account.stale ? { fillOpacity: 0.45 } : {})} />
                  </View>
                );
              })}
            </View>
            {props.listed ? null : <View style={styles.pooledLabels}>{run.cells.map((cell) => label(run, cell, false))}</View>}
          </View>
        ))}
      </View>
      {props.listed ? (
        <View style={styles.pooledList} accessibilityRole="list" testID={`${props.testID}.accounts`}>
          {props.runs.flatMap((run) => run.cells.map((cell) => label(run, cell, true)))}
        </View>
      ) : null}
    </>
  );
}

/** The headline's room while the first allowance is still being read: its figure's height and its line. */
function CapacityHeroReading(props: Readonly<{ count: number; testID: string }>) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const reducedMotion = useReducedMotionPreference();
  return (
    <View style={styles.hero} testID={props.testID}>
      <View style={[styles.heroReading, { height: HAPPIER_DATA_METRICS.heroValue.lineHeight }]}>
        <HappierSkeletonBlock color={theme.colors.surface.skeleton} width={84} height={HAPPIER_DATA_METRICS.heroValue.fontSize * 0.7}
          radius={8} reducedMotion={reducedMotion} />
      </View>
      <Text style={[styles.subline, text.detail]}>{t('usage.board.plans.capacityReading', { count: props.count })}</Text>
    </View>
  );
}

/** A secondary window in one quiet line: its name and what is left of it. */
function windowNote(window: UsagePlanWindow): string {
  return `${window.label} · ${
    window.remainingFraction === null
      ? t('usage.board.plans.cellUnknown')
      : t('usage.board.plans.cellLeft', { percent: formatPlanPercent(window.remainingFraction) })
  }`;
}

function CapacityCell(
  props: Readonly<{
    cell: Cell;
    name: UsagePlanAccountName;
    nowMs: number;
    basis?: `${number}%`;
    /** Under a segment of the pooled bar: the bar is drawn above it by the pooled track. */
    pooled?: boolean;
    /** One row of the list under a narrow pooled bar: the account and its note at the start, its figure at the end. */
    listed?: boolean;
    staleSaidOnce?: boolean;
    /** The only account: the headline above already says its figure and reset, so the cell keeps its bar and name. */
    lone?: boolean;
    testID: string;
  }>,
) {
  const { cell, nowMs } = props;
  const text = usePlanText();
  const window = cell.account.headline;
  // Every other window of the plan, each in its own words; none is folded into the headline.
  const otherWindows = cell.account.windows.filter((other) => other !== window);
  const remaining = window?.remainingFraction ?? null;
  const usedUp = remaining !== null && remaining <= 0;
  const countdown =
    window?.resetAtMs != null
      ? formatPlanCountdown(window.resetAtMs, nowMs)
      : null;
  // Only a state that changes what the viewer can do speaks under the segment (excluded, stale, used
  // up); the ordinary reset is the headline's job (lab ucap/wgusage-CD: one figure, one plan label).
  const staleDetail =
    cell.excluded === null && cell.account.stale && cell.account.observedAtMs !== null && !props.staleSaidOnce
      ? t('usage.board.plans.cellStale', {
          time: formatPlanMoment(cell.account.observedAtMs, nowMs),
        })
      : null;
  // Red belongs to "used up" alone: a stale read of a used-up plan stays the quiet "last read" note.
  const usedUpDetail = cell.excluded === null && staleDetail === null && usedUp && countdown
    ? `${t('usage.board.plans.cellUsedUp')} · ${countdown}`
    : null;
  // An account that answered with no comparable window (a mailbox, a service without an allowance) says
  // so; a read still in flight, not yet read or failed keeps the quiet dash.
  // A `not_loaded` placeholder is not an answer: only an observed empty result gets the negative caption.
  const current = cell.account.read?.current;
  const noAllowance = remaining === null && current != null && wasConnectedServiceQuotaObserved(current);
  // A record with no observation (never read, not in flight) says so in the cell; the page header owns
  // "still reading", and no date is invented for it.
  const unread = cell.account.observedAtMs === null && cell.account.state.status !== 'pending' && !noAllowance;
  const detail = cell.excluded ?? staleDetail ?? usedUpDetail
    ?? (noAllowance ? t('usage.board.plans.cellNoAllowance') : unread ? t('usage.board.plans.paceNotLoaded') : null);
  const value =
    remaining === null
      ? '—'
      : formatPlanPercent(remaining);
  const valueInk = (
    <Text
      style={[
        styles.cellValue,
        text.title,
        remaining === null ? styles.cellValueUnknown : null,
        window?.tone === 'warning'
          ? styles.warning
          : window?.tone === 'danger'
            ? styles.danger
            : null,
      ]}
      numberOfLines={1}
    >
      {value}
    </Text>
  );
  const valueText = remaining === null || !window ? valueInk : <ChartDatum testID={`${props.testID}.datum`}
    datum={{ label: `${props.name.title} · ${window.label}`, value: formatHappierDataExactShare(remaining, getPreferredLanguage()),
      subtitle: [window.resetAtMs === null ? null : formatPlanResetPhrase(window.resetAtMs, nowMs),
        ...otherWindows.map(other => windowNote(other))].filter(Boolean).join(' · ') }}>{valueInk}</ChartDatum>;
  const detailLine = detail === null && props.listed ? null : (
    <Text
      style={[
        styles.cellDetail,
        text.detail,
        props.pooled ? null : { minHeight: text.detail.lineHeight },
        usedUpDetail !== null ? styles.danger : null,
      ]}
      // A narrow segment wraps its note ("last read 07:31") rather than cutting the time off.
      numberOfLines={2}
    >
      {detail}
    </Text>
  );
  return (
    <View
      testID={props.testID}
      accessibilityRole="text"
      style={[
        styles.cell,
        // A listed row stacks in a column: it takes its content's height (a "used up" note under the name),
        // never an equal share of the list that lets the note run into the next row.
        props.listed ? styles.cellListed : null,
        props.basis ? { flexBasis: props.basis, flexGrow: 1 } : null,
      ]}
      accessibilityLabel={[
        props.name.title,
        props.name.qualifier,
        window?.label,
        remaining === null
          ? t('usage.board.plans.cellUnknown')
          : t('usage.board.plans.cellLeft', { percent: value }),
        window?.resetAtMs != null ? formatPlanResetPhrase(window.resetAtMs, nowMs) : null,
        detail,
        // Every other window stays readable here and in Projections; none is stacked into the bar.
        ...otherWindows.map((other) => windowNote(other)),
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {/* The bar leads (lab `ucap`): side by side the cells read as one all-accounts bar. An unknown window draws an empty track; no width is invented for it. */}
      {props.pooled ? null : <MeterBar
        height={8}
        tone={window && window.tone !== 'success' ? window.tone : 'neutral'}
        fillFraction={remaining ?? 0}
        {...(cell.account.stale ? { fillOpacity: 0.45 } : {})}
      />}
      {props.listed ? (
        <View style={styles.listedRow}>
          <View style={styles.listedIdentity}>
            <View style={styles.cellHead}>
              <View style={styles.cellIdentity}><UsagePlanIdentity name={props.name} compact /></View>
              {cell.rank !== null || cell.excluded !== null ? <UsagePlanRank rank={cell.rank} selected={cell.selected} /> : null}
            </View>
            {props.lone ? null : detailLine}
          </View>
          {props.lone ? null : valueText}
        </View>
      ) : (
        <>
          {props.lone ? null : <View style={styles.cellHead}>{valueText}</View>}
          <View style={styles.cellHead}>
            <View style={styles.cellIdentity}><UsagePlanIdentity name={props.name} compact /></View>
            {cell.rank !== null || cell.excluded !== null ? (
              <UsagePlanRank rank={cell.rank} selected={cell.selected} />
            ) : null}
          </View>
          {/* The caption's line is held for every account from the first frame, the one that never answers
              included: "last read" or "used up" arrives into it, and settling never resizes the bar. Under the
              pooled bar a label is its figure and plan (lab `d2top-A`); only a state that changes what the viewer
              can do takes a line there. */}
          {props.lone || props.pooled && detail === null ? null : detailLine}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 18 },
  hero: { gap: theme.space.s2 },
  heroLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s10,
  },
  heroReading: { justifyContent: 'center' },
  heroUnit: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  subline: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  // The gap keeps one cell's account name clear of the next cell's mark; the bars still read as one row.
  bar: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s12, rowGap: theme.space.s12 },
  run: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s12, rowGap: theme.space.s12, minWidth: 0 },
  // A pool is a nested surface: it keeps the gap its own cells keep from each other, so the bars and figures sit
  // inside its outline with air, never against it.
  pool: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    padding: theme.space.s12,
  },
  halfSpacer: { flexBasis: '47%', flexGrow: 1 },
  cell: { flex: 1, minWidth: 0, gap: theme.space.s6 },
  cellListed: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  cellIdentity: { flexShrink: 1, minWidth: 0 },
  // The phone's list under the pooled bar: a row per account, its figure at the end in a column of its own.
  pooledList: { gap: theme.space.s16 },
  listedRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: theme.space.s12 },
  listedIdentity: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  cellValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  cellValueUnknown: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  cellDetail: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  // The pooled bar: its runs sit side by side (wrapping only when segments would become slivers), each run's
  // segments touch at a hairline gap so they read as one bar, and its labels share the segments' columns.
  pooledBar: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s4, rowGap: theme.space.s12 },
  pooledRun: { flexBasis: 0, gap: theme.space.s8 },
  pooledTrack: { flexDirection: 'row', gap: theme.space.s4 },
  // A pool's members share one outline around their segments, as in the lab; the labels stay outside it.
  pooledTrackPool: {
    borderRadius: theme.borderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    padding: theme.space.s2,
    margin: -theme.space.s2 - StyleSheet.hairlineWidth,
  },
  pooledSegment: { flex: 1, minWidth: 0 },
  pooledLabels: { flexDirection: 'row', gap: theme.space.s4 },
  warning: { color: theme.colors.state.warning.foreground },
  danger: { color: theme.colors.state.danger.foreground },
}));
