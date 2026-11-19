import type {
    DatabaseStatsCounterComparisonV1,
    DatabaseStatsObservationV1,
    DatabaseStatsReadV1,
} from '@happier-dev/plugin-sdk/database';
import { WORKBENCH_DISPLAY_PAGE_ROWS } from '../mount.js';
import { projectDatabaseStatementMetrics } from '../../../insights/presentation.js';

export type StatementsObservation = Extract<
  DatabaseStatsObservationV1,
  { status: 'available'; group: 'statements' }
>;
export type StatementRow = StatementsObservation['data'][number];
export type StatementChange = Extract<
  DatabaseStatsCounterComparisonV1,
  { status: 'available' }
>['rows'][number];

/** The producer ranks by total time; this view shows one display window of it. */
export const STATEMENTS_BY_TOTAL_TIME: Extract<
  DatabaseStatsReadV1,
  { group: 'statements' }
> = {
  kind: 'stats.read',
  group: 'statements',
  selection: {
    page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 },
    order: 'totalTime',
  },
};

/** The details tab rereads one statement by its key through the same producer. */
export function statementByKey(
  statementKey: string,
): Extract<DatabaseStatsReadV1, { group: 'statements' }> {
  return {
    ...STATEMENTS_BY_TOTAL_TIME,
    selection: { ...STATEMENTS_BY_TOTAL_TIME.selection, statementKey },
  };
}

export type StatementView = Readonly<{
  row: StatementRow;
  /** Share of the time spent in the statements shown. */
  share: number;
  meanMs: number | null;
  rowsPerCall: number | null;
  /** What changed since your last look; absent when this statement is new or no comparison exists. */
  change?: StatementChange;
  /** In this look but not the last one. */
  isNew: boolean;
}>;

/** Pure projection: cumulative counters per row plus the R13 comparison the host computed for the same rows. */
export function projectStatements(
  observation: StatementsObservation,
  comparison: DatabaseStatsCounterComparisonV1 | null | undefined,
): readonly StatementView[] {
  const total = observation.data.reduce((sum, row) => sum + row.totalTimeMs, 0);
  const changes =
    comparison?.status === 'available'
      ? new Map(comparison.rows.map((row) => [row.key, row]))
      : null;
  return observation.data.map((row) => {
    const metrics = projectDatabaseStatementMetrics(row);
    const change = changes?.get(row.key);
    return {
      row,
      share: total > 0 ? row.totalTimeMs / total : 0,
      meanMs: metrics.meanTimeMs,
      rowsPerCall: metrics.rowsPerCall,
      ...(change ? { change } : {}),
      isNew: changes !== null && !change,
    };
  });
}

/** Totals over what changed since your last look, only from rows the comparison covers (P4 §9: no invented totals). */
export function summarizeChanges(
  views: readonly StatementView[],
): Readonly<{
  calls: bigint;
  timeMs: number;
  meanMs: number | null;
  compared: number;
}> | null {
  const compared = views.filter((view) => view.change);
  if (compared.length === 0) return null;
  let calls = 0n;
  let timeMs = 0;
  for (const view of compared) {
    calls += BigInt(view.change!.calls);
    timeMs += view.change!.totalTimeMs;
  }
  return {
    calls,
    timeMs,
    meanMs: calls > 0n ? timeMs / Number(calls) : null,
    compared: compared.length,
  };
}
