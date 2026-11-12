import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { ChartDatum, formatHappierDataExactShare, HAPPIER_DATA_METRICS, HappierDataMetric, HappierDataRows, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWidgetFrameBodyCaption, useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useUsageOpenView } from '../usageDrill';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { Typography } from '@/constants/Typography';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { getPreferredLanguage, t } from '@/text';
import {
  UsageResetCelebration,
  type UsageResetCelebrationWindow,
} from './UsageResetCelebration';
import {
  useUsagePluginTheme,
  usageUnreadAccountsLabel,
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
  isUsagePlanAccountDrawn,
  isUsagePlanAccountSettledUnread,
  readPendingPlanAccountCount,
  usePlanText,
  UsagePlanDisclosure,
} from './plans/UsagePlanParts';
import { UsagePoolQueue, UsagePoolSteps } from './plans/UsagePoolOrder';

/**
 * Below this width per account the per-account cells cannot hold a figure and a name side by side, so they become
 * one row each (bar, then name and figure), as the narrow pooled bar lists them (native N2: a seven-account phone).
 */
const CELL_MIN_WIDTH_PX = 92;
/** Beside other widgets a segment of the one pooled bar keeps this much room for its label beneath it. */
const POOLED_SEGMENT_MIN_WIDTH_PX = 64;
/**
 * Under the pooled bar each account's label takes its segment's column. Below this much width per account (a
 * phone with four accounts, seven accounts beside Daily) a column cannot hold a name, its figure and a note, so
 * Limits says the tightest account's figure and meter and the rest in one line, as it does for the next account.
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
type Run = Readonly<{ pool: UsagePlanPool | null; cells: readonly Cell[]; /** Accounts outside every pool, joined under one label. */ outside?: boolean }>;

/** Only a run of two or more members is a group worth an outline; a pool of one reads as its account does. */
const isFramedRun = (run: Run) => (run.pool !== null && run.cells.length > 1) || run.outside === true;

/** Beside an outlined pool the accounts outside it read as one labelled group, not loose unlabelled cells. */
function joinRunsOutsidePools(runs: readonly Run[]): Run[] {
  const outside = runs.filter(run => run.pool === null);
  if (outside.length < 2 || outside.length === runs.length) return [...runs];
  const joined: Run = { pool: null, outside: true, cells: outside.flatMap(run => run.cells) };
  return [...runs.filter(run => run.pool !== null), joined];
}

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

/**
 * The account the next session will use, as the selector has decided it: its current pick in the pools' order, else
 * the only drawn account, else the selector's first eligible member. `null` when the selector has not decided.
 */
function readNextLimitsAccount(
  selections: ReadonlyMap<string, UsagePoolSelectionState>,
  drawn: readonly UsagePlanAccount[],
): UsagePlanAccount | null {
  const decided = [...selections.entries()].flatMap(([poolKey, state]) =>
    typeof state === 'object' && !('status' in state) ? [{ poolKey, selection: state.selection }] : []);
  const member = (poolKey: string, profileId: string | undefined) => profileId === undefined ? null
    : drawn.find((account) => account.accountId === profileId
      && poolKey.startsWith(`${account.service.pluginId}/${account.service.localId}:`)) ?? null;
  for (const { poolKey, selection } of decided) {
    const picked = member(poolKey, selection.selected?.profileId);
    if (picked) return picked;
  }
  if (drawn.length === 1) return drawn[0]!;
  for (const { poolKey, selection } of decided) {
    const first = member(poolKey, selection.decisionTrace.orderedEligibleCandidates[0]?.profileId);
    if (first) return first;
  }
  return null;
}

/** A run's identity as a list key: an account can belong to several pools, so the account's own key alone repeats across runs. */
function runKey(run: Run): string {
  return run.pool ? `pool:${run.pool.key}` : `account:${run.cells[0]!.account.key}`;
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
  const router = useRouter();
  const pooled = POOLED_SIZES.has(presentation?.size ?? '');
  // Beside other widgets the next move is Plans: the full view is one press from the figure (lab d2views-OV).
  const openPlans = useUsageOpenView('plans');
  const plansLink = React.useMemo(() => pooled && !tile
    ? <TextLinkButton label={t('usage.board.plans.plansAndResets')} tone="accent" size="meta" onPress={openPlans} testID={`${props.testID}.plansLink`} />
    : null, [pooled, tile, openPlans, props.testID]);
  useWidgetFrameBodyMeta(plansLink);
  // Only an account with a reading is a segment: never-read accounts collapse into one quiet line, and a first read
  // still in flight is said by the reading line.
  const drawn = React.useMemo(() => projection.accounts.filter(isUsagePlanAccountDrawn), [projection.accounts]);
  const unreadNames = projection.accounts.filter(isUsagePlanAccountSettledUnread).map(account => nameOf(account).title);
  const runs = React.useMemo(
    () => {
      const built = buildRuns(drawn, projection.pools, selections, nowMs);
      return pooled ? built : joinRunsOutsidePools(built);
    },
    [drawn, projection.pools, selections, nowMs, pooled],
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
  // The headline is the account the next session will use (owner 2026-11-11), at every size: the selector's current
  // pick, else the only account, else the selector's first eligible one. Without any of these the tightest account
  // stands in, said as the tightest. At full width every plan's cell still follows it for comparison.
  const next = readNextLimitsAccount(selections, drawn);
  // Beside other widgets the headline account is one figure and one meter and the rest one line: the next account
  // always, the tightest standing in when the pooled bar has no room for a label per segment. Listing them instead
  // grew the column ~240 px past the Daily chart beside it (R6 N12); their figures are Plans' to compare.
  const compact = pooled && (next !== null
    || width !== null && width / Math.max(1, drawn.length) < POOLED_COLUMN_LABEL_MIN_WIDTH_PX);
  // The caption says what the headline is: the next session's account, or the tightest of every plan standing in.
  useWidgetFrameBodyCaption(t(next !== null ? 'usage.board.plans.limitsCaption' : 'usage.board.plans.capacityCaption'));
  const nextWindow = next?.headline ?? null;
  const tightest = next === null ? projection.tightest
    : nextWindow !== null && nextWindow.remainingFraction !== null
      ? { account: next, window: nextWindow, provisional: projection.tightest?.provisional === true } : null;
  // The next account answered without a figure for its window: the headline says "not reported", never 0%.
  const nextUnreported = next !== null && tightest === null;
  // Every other account in one line ("6 more · 2 used up"); their figures are Plans' to compare.
  const lead = next ?? projection.tightest?.account ?? null;
  const othersLine = !compact || lead === null ? null : (() => {
    const others = projection.accounts.filter((account) => account.key !== lead.key);
    if (others.length === 0) return null;
    const usedUp = others.filter((account) => account.headline?.remainingFraction != null && account.headline.remainingFraction <= 0).length;
    return t('usage.board.plans.limitsOthers', { count: others.length, usedUp });
  })();
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
  // so neither says the other's fact again. An old reading is said once, by the read-state line under the body;
  // a state only the cell says (left out of a pool) keeps the ordinary cell.
  const lone = drawn.length === 1 && tightest !== null && tightest.account.key === drawn[0]!.key
    && runs.every((run) => run.cells.every((cell) => cell.excluded === null));
  // The only plan is used up: one next step, the sign-in Capacity offers when nothing is connected, so work has
  // another account to go to before the reset.
  const loneUsedUp = lone && tightest !== null && tightest.window.remainingFraction !== null && tightest.window.remainingFraction <= 0;
  const nextStep = useCurrentUiContextLocalCommands(loneUsedUp ? [{ key: 'addAccount',
    title: t('usage.board.plans.capacityAddAccount'),
    invoke: () => router.push(SETTINGS_ROUTES.connectedServicesAgentSignIn as Parameters<typeof router.push>[0]),
  }] : []);
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
  const heroUnit = !tightestName ? ''
    // The headline names the next account even when it is the only one: beside other widgets no cell repeats it.
    : next !== null && (pooled || !lone) ? t('usage.board.plans.limitsNextUnit', { name: tightestName.title })
    : lone ? t('usage.board.plans.capacityLoneUnit')
    : t('usage.board.plans.capacityTightestUnit', { name: tightestName.title });
  // Equal cells while they fit; a narrow frame (a phone) lists them a row each rather than shrinking them.
  const listed = !pooled && width !== null && width / Math.max(1, cellCount) < CELL_MIN_WIDTH_PX;
  const renderCells = (run: Run) => run.cells.map((cell) => (
    <CapacityCell
      key={cell.account.key}
      cell={cell}
      name={nameOf(cell.account)}
      nowMs={nowMs}
      lone={lone}
      {...(listed ? { listed } : {})}
      testID={`${props.testID}.cell.${cell.account.accountId}`}
    />
  ));
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
              datum={{ keyboard: false, label: `${tightestName.title} · ${tightest.window.label}`,
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
                : tightest.provisional || lone || compact ? null : t('usage.board.plans.capacityAccounts', { count: projection.readAccountCount }),
              oldestReadMs !== null ? t('usage.board.plans.cellStale', { time: formatPlanMoment(oldestReadMs, nowMs) }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {loneUsedUp ? (
            <View style={styles.nextStep}>
              <RoundButton testID={`${props.testID}.nextStep`} size="small" display="inverted"
                title={t('usage.board.plans.capacityAddAccount')}
                onPress={() => { void nextStep.invoke('addAccount'); }} />
            </View>
          ) : null}
        </View>
      ) : reading ? (
        <CapacityHeroReading count={pendingAccounts} testID={`${props.testID}.reading`} />
      ) : nextUnreported && next !== null ? (
        <View style={styles.hero} testID={`${props.testID}.nextUnreported`}>
          <Text style={[styles.heroUnit, text.title]} numberOfLines={2}>
            {`${nameOf(next).title} · ${t('usage.board.plans.cellUnknown')}`}
          </Text>
        </View>
      ) : null}
      {compact ? (
        tightest !== null ? <View style={styles.nextMeter} testID={`${props.testID}.nextMeter`}>
          <MeterBar height={8} tone={tightest.window.tone !== 'success' ? tightest.window.tone : 'neutral'}
            fillFraction={tightest.window.remainingFraction ?? 0} {...(tightest.account.stale ? { fillOpacity: 0.45 } : {})} />
        </View> : null
      ) : pooled && runs.length > 0 ? (
        <CapacityPooledBar runs={runs} nameOf={nameOf} nowMs={nowMs} staleSaidOnce={everyStale} lone={lone} testID={props.testID} />
      ) : runs.length > 0 ? (
      <View style={listed ? styles.list : styles.bar} accessibilityRole="list" testID={listed ? `${props.testID}.accounts` : undefined}>
        {runs.map((run) => (
          <View
            key={runKey(run)}
            testID={run.pool && isFramedRun(run) ? `${props.testID}.pool.${run.pool.groupId}` : undefined}
            style={[
              isFramedRun(run) ? styles.pool : listed ? styles.list : styles.run,
              listed ? null : { flexGrow: run.cells.length, flexBasis: 0 },
            ]}
          >
            {/* An outline says which pool it holds, so the cells beside it read as accounts outside it. */}
            {isFramedRun(run) && (run.outside || run.pool!.name) ? (
              <Text style={[styles.poolLabel, text.detail]} numberOfLines={1} testID={`${props.testID}.pool.${run.outside ? 'outside' : run.pool!.groupId}.label`}>
                {run.outside ? t('usage.board.plans.poolOutside') : run.pool!.name}
              </Text>
            ) : null}
            {isFramedRun(run) ? <View style={listed ? styles.list : styles.run}>{renderCells(run)}</View> : renderCells(run)}
          </View>
        ))}
      </View>
      ) : null}
      {othersLine !== null ? (
        <Text style={[styles.subline, text.detail]} testID={`${props.testID}.others`}>{othersLine}</Text>
      ) : null}
      {unreadNames.length > 0 && !compact ? (
        <Text style={[styles.subline, text.detail]} testID={`${props.testID}.unread`}>
          {usageUnreadAccountsLabel(unreadNames)}
        </Text>
      ) : null}
      {projection.accounts.some(account => account.windows.length > 0) ? (
        <UsagePlanDisclosure title={`${t('usage.widgets.usage_capacity')}: ${t('usage.board.charts.showValues')}`}
          testID={`${props.testID}.values`}>
          <CapacityExactValues accounts={projection.accounts} nameOf={nameOf} nowMs={nowMs} testID={`${props.testID}.values.rows`} />
        </UsagePlanDisclosure>
      ) : null}
      {/* Beside other widgets the meters are said once; the switching order lives with the full view (Plans). */}
      {pooled && (!tile || next !== null) ? null : tile ? (
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

/** The disclosure mounts its exact rows on demand, using the same admitted windows as the bars. */
function CapacityExactValues(props: Readonly<{
  accounts: readonly UsagePlanAccount[];
  nameOf: (account: UsagePlanAccount) => UsagePlanAccountName;
  nowMs: number;
  testID: string;
}>) {
  const theme = useUsagePluginTheme();
  return <HappierDataRows theme={theme} label={t('usage.board.charts.showValues')} testID={props.testID}
    columns={[{ label: t('usage.widgets.usage_capacity') }, { label: t('usage.board.charts.showValues') }]}
    rows={props.accounts.flatMap(account => account.windows.map(window => [
      `${props.nameOf(account).title} · ${window.label}`,
      [window.remainingFraction === null ? t('usage.board.plans.cellUnknown')
        : t('usage.board.plans.cellLeft', { percent: formatHappierDataExactShare(window.remainingFraction, getPreferredLanguage()) }),
        window.resetAtMs === null ? null : formatPlanResetPhrase(window.resetAtMs, props.nowMs)].filter(Boolean).join(' · '),
    ]))} />;
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
}>) {
  const label = (run: Run, cell: Cell) => (
    <CapacityCell key={`${runKey(run)}:${cell.account.key}`} cell={cell} name={props.nameOf(cell.account)} nowMs={props.nowMs}
      pooled staleSaidOnce={props.staleSaidOnce} lone={props.lone} testID={`${props.testID}.cell.${cell.account.accountId}`} />
  );
  return (
    <View style={styles.pooledBar} accessibilityRole="list" testID={`${props.testID}.pooled`}>
      {props.runs.map((run) => (
        <View key={runKey(run)}
          testID={run.pool && isFramedRun(run) ? `${props.testID}.pool.${run.pool.groupId}` : undefined}
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
          <View style={styles.pooledLabels}>{run.cells.map((cell) => label(run, cell))}</View>
        </View>
      ))}
    </View>
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
      ? t('usage.board.plans.cellUnknown')
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
    datum={{ keyboard: false, label: `${props.name.title} · ${window.label}`, value: formatHappierDataExactShare(remaining, getPreferredLanguage()),
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
      // Every cell sits in a meter list (the bar, the pooled bar, the listed accounts): it is that list's item.
      role="listitem"
      style={[
        styles.cell,
        // A listed row stacks in a column: it takes its content's height (a "used up" note under the name),
        // never an equal share of the list that lets the note run into the next row.
        props.listed ? styles.cellListed : null,
      ]}
      accessibilityLabel={[
        props.name.primaryLabel ?? props.name.title,
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
              <View style={styles.cellIdentity}><UsagePlanIdentity name={props.name} compact column /></View>
              {cell.rank !== null ? <UsagePlanRank rank={cell.rank} selected={cell.selected} /> : null}
            </View>
            {props.lone ? null : detailLine}
          </View>
          {props.lone ? null : valueText}
        </View>
      ) : (
        <>
          {props.lone ? null : <View style={styles.cellHead}>{valueText}</View>}
          <View style={styles.cellHead}>
            <View style={styles.cellIdentity}><UsagePlanIdentity name={props.name} compact column /></View>
            {/* A left-out account says why in words on its caption line; an unnumbered badge would only repeat it. */}
            {cell.rank !== null ? <UsagePlanRank rank={cell.rank} selected={cell.selected} /> : null}
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
  nextMeter: { alignSelf: 'stretch' },
  heroLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s10,
  },
  heroReading: { justifyContent: 'center' },
  nextStep: { alignItems: 'flex-start', paddingTop: theme.space.s4 },
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
    gap: theme.space.s8,
    minWidth: 0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    padding: theme.space.s12,
  },
  poolLabel: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
  cell: { flex: 1, minWidth: 0, gap: theme.space.s6 },
  cellListed: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  cellIdentity: { flexShrink: 1, minWidth: 0 },
  // A phone's list (under the pooled bar, or in place of the per-account grid): a row per account, its figure at the end.
  list: { gap: theme.space.s16 },
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
  warning: { color: theme.colors.state.warning.textForeground },
  danger: { color: theme.colors.state.danger.textForeground },
}));
