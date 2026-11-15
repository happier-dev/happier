import type { MachineSetupUpdatesRolloutInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { WorkflowFailurePolicy } from '@happier-dev/protocol/workflows/workflowV1';

import type { MachineUpdatesScope } from '../security/machineUpdatesActions';
import type { MachineUpdatesPageEntry } from '../security/useMachineUpdatesPage';

export type FleetMachine = Readonly<{
  machineId: string;
  name: string;
  online: boolean | null;
  installationId: string | null;
  /** The reported OS platform ("linux", "darwin"), for the row's mark and byline. */
  platform: string | null;
}>;

/** One Machine's pushed update facts as the fleet page shows them. Unknown stays null: never a zero. */
export type FleetUpdatesRow = FleetMachine &
  Readonly<{
    security: number | null;
    all: number | null;
    restartNeeded: boolean;
    /** When the Machine's last native update check completed (epoch ms); null when it never reported one. */
    checkedAt: number | null;
  }>;

export function readFleetUpdatesRow(
  machine: FleetMachine,
  entry: MachineUpdatesPageEntry | undefined,
): FleetUpdatesRow {
  // An offline Machine's last answer is not today's count (lab fUpd: "—", never zero); when it last checked stays
  // true, so the row keeps it ("As of 14:02").
  return {
    ...machine,
    ...readMachineUpdateFacts(machine.online === true ? (entry?.observation ?? null) : null),
    checkedAt: entry?.observation?.checkedAt ?? null,
  };
}

export type MachineUpdateFacts = Pick<FleetUpdatesRow, 'security' | 'all' | 'restartNeeded' | 'checkedAt'>;

/** One online Machine's pushed update observation as counts; unknown stays null. */
export function readMachineUpdateFacts(observation: MachineUpdatesPageEntry['observation']): MachineUpdateFacts {
  return {
    security: observation?.pendingSecurity ?? null,
    all: observation?.pendingAll ?? null,
    restartNeeded: observation?.rebootNeeded === true,
    checkedAt: observation?.checkedAt ?? null,
  };
}

/**
 * The one update fact a Machine's line says when it needs the person (lab mIdx Work cell): waiting security updates
 * first, then a needed restart. Other waiting updates stay on the Updates page. Offline or unknown says nothing.
 */
export type MachineUpdateWord =
  | Readonly<{ kind: 'security'; count: number }>
  | Readonly<{ kind: 'restart' }>;

export function readMachineUpdateWord(row: MachineUpdateFacts): MachineUpdateWord | null {
  if ((row.security ?? 0) > 0) return { kind: 'security', count: row.security! };
  return row.restartNeeded ? { kind: 'restart' } : null;
}

export type FleetUpdatesSummary = Readonly<{
  machines: number;
  withUpdates: number;
  security: number;
  restarts: number;
  offline: readonly string[];
}>;

export function summarizeFleetUpdates(
  rows: readonly FleetUpdatesRow[],
): FleetUpdatesSummary {
  return {
    machines: rows.length,
    withUpdates: rows.filter(
      (row) => (row.security ?? 0) > 0 || (row.all ?? 0) > 0,
    ).length,
    security: rows.reduce((sum, row) => sum + (row.security ?? 0), 0),
    restarts: rows.filter((row) => row.restartNeeded).length,
    offline: rows.filter((row) => row.online === false).map((row) => row.name),
  };
}

const rank = (row: FleetUpdatesRow) =>
  (row.security ?? 0) > 0 ? 0 : (row.all ?? 0) > 0 || row.restartNeeded ? 1 : row.online === true ? 2 : row.online === null ? 3 : 4;

/** What needs a look first: security updates, then other updates or a restart, then up to date, then offline. */
export function orderFleetUpdatesRows(rows: readonly FleetUpdatesRow[]): readonly FleetUpdatesRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** The Machines a rollout of this scope reaches: online, with updates of that kind waiting. */
export function fleetRolloutCandidates(
  rows: readonly FleetUpdatesRow[],
  scope: MachineUpdatesScope,
): readonly FleetUpdatesRow[] {
  return rows.filter(
    (row) =>
      row.online === true &&
      ((scope === 'security' ? row.security : row.all) ?? 0) > 0,
  );
}

export type FleetPlannedTarget = Readonly<{
  machine: FleetMachine;
  scope: MachineUpdatesScope;
  plan: MachineSetupEffectPlanV1;
}>;

/**
 * The reviewed rollout: one Machine at a time (one batch each), each installing exactly its own reviewed plan.
 * The Workflow runs on an online Machine outside the rollout when there is one; otherwise on a target that goes last,
 * so a restart never ends the run before the other Machines finish.
 */
export function buildFleetRolloutInput(
  input: Readonly<{
    homeId: string;
    targets: readonly FleetPlannedTarget[];
    others: readonly FleetMachine[];
    failurePolicy: WorkflowFailurePolicy;
    restartIfNeeded: boolean;
  }>,
): MachineSetupUpdatesRolloutInputV1 {
  const outside = input.others.find((machine) => machine.online === true);
  const host =
    outside?.machineId ??
    input.targets[input.targets.length - 1]!.machine.machineId;
  const ordered = [
    ...input.targets.filter((target) => target.machine.machineId !== host),
    ...input.targets.filter((target) => target.machine.machineId === host),
  ];
  return {
    homeId: input.homeId,
    machineId: host,
    failurePolicy: input.failurePolicy,
    batches: ordered.map((target) => [
      {
        homeId: input.homeId,
        machineId: target.machine.machineId,
        scope: target.scope,
        plan: target.plan,
        ...(input.restartIfNeeded && target.machine.installationId
          ? {
              reboot: { expectedInstallationId: target.machine.installationId },
            }
          : {}),
      },
    ]),
  };
}
