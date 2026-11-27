import { isWorkStatusNeedsYou } from '@/components/work/status/resolveWorkStatusTone';

import type { WorkflowRunCollectionRow } from './useWorkflowRunCollection';

/** One Machine's share of the automation fleet right now: runs holding a slot, and asks that released theirs. */
export type WorkflowRunsNowMachine = Readonly<{
  machineId: string;
  working: number;
  parked: number;
}>;

/**
 * Which runs the counts cover. No Machine publishes its slot occupancy, so the counts are read from the Run collection's
 * loaded rows; while older runs remain unloaded the reader is told the counts cover only the loaded ones.
 */
export type WorkflowRunsNowCounted =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'loaded'; loadedCount: number }>;

export type WorkflowRunsNow = Readonly<{
  /** Runs waiting on the person, in the collection's order (the Runs "Needs you" hero). */
  needsYou: readonly WorkflowRunCollectionRow[];
  /** Machines with a working or parked run, busiest first. */
  machines: readonly WorkflowRunsNowMachine[];
  workingCount: number;
  counted: WorkflowRunsNowCounted;
}>;

/**
 * The Runs "Now" projection over the one Run collection's rows: who needs the person, and how the fleet's working runs
 * sit on their Machines. It reads only the Work status each row already carries (`isWorkStatusNeedsYou`, the `working`
 * bucket); it never classifies a Run itself. A run waiting on the person released its Machine's automation slot (the
 * daemon's parked-slot release), so it is counted apart from working runs. `previous` is returned when nothing it shows
 * changed, so the strip and hero do not re-render for a settled row arriving. `paging.complete` is the collection's
 * own paging fact (no further page to load).
 */
export function projectWorkflowRunsNow(
  rows: readonly WorkflowRunCollectionRow[],
  paging: Readonly<{ complete: boolean }>,
  previous?: WorkflowRunsNow,
): WorkflowRunsNow {
  const needsYou: WorkflowRunCollectionRow[] = [];
  const byMachine = new Map<string, { working: number; parked: number }>();
  let workingCount = 0;
  for (const row of rows) {
    const { status } = row;
    if (status === null) continue;
    const machineId = row.run.summary?.machineId;
    if (isWorkStatusNeedsYou(status)) {
      needsYou.push(row);
      if (machineId) {
        const slot = byMachine.get(machineId) ?? { working: 0, parked: 0 };
        slot.parked += 1;
        byMachine.set(machineId, slot);
      }
      continue;
    }
    if (status.bucket !== 'working') continue;
    workingCount += 1;
    if (!machineId) continue;
    const slot = byMachine.get(machineId) ?? { working: 0, parked: 0 };
    slot.working += 1;
    byMachine.set(machineId, slot);
  }
  const machines = [...byMachine]
    .map(([machineId, slot]) => ({ machineId, ...slot }))
    .sort(
      (a, b) =>
        b.working - a.working ||
        b.parked - a.parked ||
        a.machineId.localeCompare(b.machineId),
    );
  const counted: WorkflowRunsNowCounted = paging.complete
    ? { kind: 'all' }
    : { kind: 'loaded', loadedCount: rows.length };
  if (
    previous &&
    sameCounted(previous.counted, counted) &&
    previous.workingCount === workingCount &&
    sameRows(previous.needsYou, needsYou) &&
    sameMachines(previous.machines, machines)
  )
    return previous;
  return { needsYou, machines, workingCount, counted };
}

function sameCounted(a: WorkflowRunsNowCounted, b: WorkflowRunsNowCounted): boolean {
  return a.kind === 'all'
    ? b.kind === 'all'
    : b.kind === 'loaded' && a.loadedCount === b.loadedCount;
}

function sameRows(
  a: readonly WorkflowRunCollectionRow[],
  b: readonly WorkflowRunCollectionRow[],
): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

function sameMachines(
  a: readonly WorkflowRunsNowMachine[],
  b: readonly WorkflowRunsNowMachine[],
): boolean {
  return (
    a.length === b.length &&
    a.every((slot, index) => {
      const other = b[index]!;
      return (
        slot.machineId === other.machineId &&
        slot.working === other.working &&
        slot.parked === other.parked
      );
    })
  );
}
