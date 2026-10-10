import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
  UsageCoverageLine,
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
  formatPlanMoment,
  formatPlanPercent,
  planExclusionText,
  UsagePlanIdentity,
  UsagePlanRank,
  UsagePlansNothingRead,
  usePlanText,
} from './plans/UsagePlanParts';
import { UsagePoolQueue, UsagePoolSteps } from './plans/UsagePoolOrder';

/** Below this width the bar's cells wrap into a two-up grid instead of shrinking into slivers. */
const CELL_MIN_WIDTH_PX = 92;

type Cell = Readonly<{
  account: UsagePlanAccount;
  rank: number | null;
  selected: boolean;
  excluded: string | null;
}>;
type Run = Readonly<{ pool: UsagePlanPool | null; cells: readonly Cell[] }>;

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
      const members = pool.accountKeys.map((key) => byKey.get(key)!);
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

export function UsageCapacityWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const presentation = useWidgetPresentation();
  const width = presentation?.geometry?.width ?? null;
  // A tile says the order as Now → Next → Then (lab `p2pool` U2); the full body lists it with reasons (U1).
  const tile = presentation?.size === 'small';
  const text = usePlanText();
  const plans = useUsagePlans(props.slice, props.model);
  const { projection, nameOf, nowMs } = plans;
  const selections = useUsagePoolSelections(props.slice);
  useWidgetFrameBodyCaption(t('usage.board.plans.capacityCaption'));
  const runs = React.useMemo(
    () => buildRuns(projection.accounts, projection.pools, selections, nowMs),
    [projection.accounts, projection.pools, selections, nowMs],
  );
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
  const tightest = projection.tightest;
  const tightestName = tightest ? nameOf(tightest.account) : null;
  const cellCount = projection.accounts.length;
  // Equal cells while they fit; a narrow frame (a phone) wraps them two-up rather than shrinking them.
  const cellBasis =
    width !== null && width / cellCount < CELL_MIN_WIDTH_PX ? ('46%' as const) : undefined;
  return (
    <View style={styles.body} testID={`${props.testID}.capacity`}>
      {tightest && tightestName ? (
        <View style={styles.hero}>
          <View style={styles.heroLine}>
            <HappierDataMetric
              testID={`${props.testID}.tightest`}
              theme={chartTheme}
              size="hero"
              label={t('usage.board.plans.capacityTightestUnit', {
                name: tightestName.title,
              })}
              value={Math.round(tightest.window.remainingFraction! * 100)}
              valueFormatter={(value) => `${value}%`}
            />
            <Text style={[styles.heroUnit, text.title]} numberOfLines={2}>
              {t('usage.board.plans.capacityTightestUnit', {
                name: tightestName.title,
              })}
            </Text>
          </View>
          <Text style={[styles.subline, text.detail]}>
            {[
              tightest.window.resetAtMs !== null
                ? t('usage.board.plans.capacityResets', {
                    time: formatPlanMoment(tightest.window.resetAtMs, nowMs),
                  })
                : null,
              t('usage.board.plans.capacityAccounts', { count: cellCount }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ) : null}
      <View style={styles.bar} accessibilityRole="list">
        {runs.map((run) => (
          <View
            key={run.pool?.key ?? run.cells[0]!.account.key}
            style={[
              styles.run,
              run.pool ? styles.pool : null,
              cellBasis
                ? { flexBasis: run.pool ? '100%' : '47%', flexGrow: 1 }
                : { flexGrow: run.cells.length, flexBasis: 0 },
            ]}
          >
            {run.cells.map((cell) => (
              <CapacityCell
                key={cell.account.key}
                cell={cell}
                name={nameOf(cell.account)}
                nowMs={nowMs}
                basis={run.pool ? cellBasis : undefined}
                notes={!tile}
                testID={`${props.testID}.cell.${cell.account.accountId}`}
              />
            ))}
          </View>
        ))}
      </View>
      {tile ? (
        <UsagePoolSteps
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.steps`}
        />
      ) : (
        <UsagePoolQueue
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.usedFirst`}
        />
      )}
      <UsageCoverageLine
        slice={props.slice}
        sources={['quota']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
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
    /** Secondary windows are listed under the cell; a tile keeps to the headline. */
    notes: boolean;
    testID: string;
  }>,
) {
  const { cell, nowMs } = props;
  const text = usePlanText();
  const window = cell.account.headline;
  // Every other window of the plan, each in its own words; none is folded into the headline.
  const others = props.notes ? cell.account.windows.filter((other) => other !== window) : [];
  const remaining = window?.remainingFraction ?? null;
  const usedUp = remaining !== null && remaining <= 0;
  const countdown =
    window?.resetAtMs != null
      ? formatPlanCountdown(window.resetAtMs, nowMs)
      : null;
  const detail =
    cell.excluded ??
    (cell.account.stale && cell.account.observedAtMs !== null
      ? t('usage.board.plans.cellStale', {
          time: formatPlanMoment(cell.account.observedAtMs, nowMs),
        })
      : usedUp && countdown
        ? `${t('usage.board.plans.cellUsedUp')} · ${countdown}`
        : countdown
          ? t('connectedServicesCollection.meterResetsIn', { time: countdown })
          : null);
  const value =
    remaining === null
      ? t('usage.board.plans.cellUnknown')
      : formatPlanPercent(remaining);
  return (
    <View
      testID={props.testID}
      accessibilityRole="text"
      style={[
        styles.cell,
        props.basis ? { flexBasis: props.basis, flexGrow: 1 } : null,
      ]}
      accessibilityLabel={[
        props.name.title,
        window?.label,
        remaining === null
          ? value
          : t('usage.board.plans.cellLeft', { percent: value }),
        detail,
        ...others.map((other) => windowNote(other)),
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {/* The bar leads (lab `ucap`): side by side the cells read as one all-accounts bar. An unknown window draws an empty track; no width is invented for it. */}
      <MeterBar
        height={8}
        tone={window && window.tone !== 'success' ? window.tone : 'neutral'}
        fillFraction={remaining ?? 0}
        {...(cell.account.stale ? { fillOpacity: 0.45 } : {})}
      />
      <View style={styles.cellHead}>
        <Text
          style={[
            styles.cellValue,
            text.title,
            remaining === null ? [styles.cellValueUnknown, text.detail] : null,
            window?.tone === 'warning'
              ? styles.warning
              : window?.tone === 'danger'
                ? styles.danger
                : null,
          ]}
        >
          {value}
        </Text>
        {cell.rank !== null || cell.excluded !== null ? (
          <UsagePlanRank rank={cell.rank} selected={cell.selected} />
        ) : null}
      </View>
      <UsagePlanIdentity name={props.name} compact />
      {detail ? (
        <Text
          style={[styles.cellDetail, text.detail, usedUp ? styles.danger : null]}
          numberOfLines={1}
        >
          {detail}
        </Text>
      ) : null}
      {others.map((other) => (
        <Text key={other.key} style={[styles.cellDetail, text.detail]} numberOfLines={1}>
          {windowNote(other)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 18 },
  hero: { gap: 2 },
  heroLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: 10,
  },
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
  bar: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, rowGap: 12 },
  run: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, rowGap: 12, minWidth: 0 },
  pool: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    padding: 5,
  },
  cell: { flex: 1, minWidth: 0, gap: 6 },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
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
  warning: { color: theme.colors.state.warning.foreground },
  danger: { color: theme.colors.state.danger.foreground },
}));
