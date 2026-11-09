import type { FoundMachineFailure } from '@/sync/domains/capabilities/found/useFoundMachineScans';

/** What a Found machine section needs to know about its scan, whatever kind of thing it lists. */
export type FoundMachineScanState<T> = Readonly<{
  failure: FoundMachineFailure | null;
  /** The last known rows, or null when nothing is known about this machine yet. */
  items: readonly T[] | null;
}>;

/**
 * One machine's section state (P6 §4.5, P7 §T6): what the section says before its rows.
 * - `rows`: there is a result to show (last known included).
 * - `looking` / `failed`: nothing is known yet and the machine is being read, or could not be.
 */
export type FoundMachineBody<T> =
  | Readonly<{ kind: 'looking' }>
  | Readonly<{ kind: 'older_machine' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'rows'; items: readonly T[] }>;

/** The causes that mean the machine did not answer (transport down, machine unreachable, timed out), not that it answered badly. */
export function isUnreachableCause(cause: string | null | undefined): boolean {
  return cause !== null && cause !== undefined && /TRANSPORT_UNAVAILABLE|UNREACHABLE|TIMEOUT|TIMED_OUT/i.test(cause);
}

export function resolveFoundMachineBody<T>(scan: FoundMachineScanState<T>): FoundMachineBody<T> {
  if (scan.failure === 'older_machine') return { kind: 'older_machine' };
  if (scan.items === null) {
    return scan.failure === 'failed' ? { kind: 'failed' } : { kind: 'looking' };
  }
  if (scan.items.length === 0) return { kind: 'empty' };
  return { kind: 'rows', items: scan.items };
}

/**
 * A machine that cannot be read now (offline, or not yet seen online) and that nothing is known about has no
 * section of its own: they are named once, as a count, after the machines there is something to say about
 * (one cause, one line). A section saying "Looking…" is only for a machine that is being read.
 */
export function partitionFoundMachines<T extends Readonly<{ online: boolean | null }>>(
  machines: readonly T[],
  isKnown: (machine: T) => boolean,
): Readonly<{ sections: readonly T[]; unseenOffline: number }> {
  const sections: T[] = [];
  let unseenOffline = 0;
  for (const machine of machines) {
    if (machine.online !== true && !isKnown(machine)) unseenOffline += 1;
    else sections.push(machine);
  }
  return { sections, unseenOffline };
}

/**
 * A machine with nothing to show yet (being read) or nothing to show at all (read, no skills) has no section of
 * its own: with dozens of machines, three that matter would sit in a wall of cards that each say "nothing here".
 * They are named once each, as a count. A machine with a note of its own (a folder that could not be read) stays.
 */
export function foldQuietFoundMachines<T>(
  machines: readonly T[],
  quietKind: (machine: T) => 'empty' | 'looking' | null,
): Readonly<{ sections: readonly T[]; empty: number; looking: number }> {
  const sections: T[] = [];
  let empty = 0;
  let looking = 0;
  for (const machine of machines) {
    const kind = quietKind(machine);
    if (kind === 'empty') empty += 1;
    else if (kind === 'looking') looking += 1;
    else sections.push(machine);
  }
  return { sections, empty, looking };
}

/** A long machine list folds to this many rows plus "N more" (lab sf notes); a presentation fold, not a cap. */
export const FOUND_FOLD_ROWS = 8;

export function foldFoundRows<T>(
  rows: readonly T[],
  expanded: boolean,
): Readonly<{ shown: readonly T[]; hidden: number }> {
  if (expanded || rows.length <= FOUND_FOLD_ROWS + 1) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, FOUND_FOLD_ROWS), hidden: rows.length - FOUND_FOLD_ROWS };
}
