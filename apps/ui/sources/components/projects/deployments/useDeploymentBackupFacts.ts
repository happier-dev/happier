import * as React from 'react';
import type { DeploymentBackupHistoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupHistoryV1';
import type { createDeploymentActions } from './deploymentActions';

type MissedSchedule = Readonly<{ triggerId: string; dueAt: number; lastRunAt: number | null }>;
export type DeploymentBackupRestorePointCount =
  | Readonly<{ status: 'ready'; count: number }>
  | Readonly<{ status: 'unavailable' }>;
/** History counts attempts; only native inventory can report snapshots still kept in the repository. */
export type DeploymentBackupFacts =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; history: DeploymentBackupHistoryResultV1 | null; missed: readonly MissedSchedule[];
      restorePoints: DeploymentBackupRestorePointCount | null }>
  | Readonly<{ status: 'unavailable' }>;
const LOADING_FACTS: DeploymentBackupFacts = Object.freeze({ status: 'loading' });
const NO_MISSED: readonly MissedSchedule[] = Object.freeze([]);

/** Read the existing Action owners on presentation and explicit reload, without timers or polling.
 * Pass source IDs only where a kept restore-point count is presented; Settings needs receipts alone. */
export function useDeploymentBackupFacts(
  actions: ReturnType<typeof createDeploymentActions> | null,
  input: Parameters<ReturnType<typeof createDeploymentActions>['backupHistory']>[0] | null,
  presented: boolean,
  restorePointSourceIds: readonly string[] | null = null,
) {
  const key = input ? JSON.stringify([input, restorePointSourceIds]) : null;
  const [settled, setSettled] = React.useState<{ key: string | null; actions: typeof actions; facts: DeploymentBackupFacts }>({
    key: null, actions: null, facts: LOADING_FACTS,
  });
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (!actions || !input || !presented) return;
    let live = true;
    void Promise.allSettled([actions.backupHistory(input), actions.missedBackupSchedules({ environmentId: input.environmentId }),
      restorePointSourceIds === null ? Promise.resolve(null) : actions.backupInventory(input),
    ]).then(([history, missed, inventory]) => {
      if (!live) return;
      if (history.status === 'rejected' && missed.status === 'rejected'
        && (inventory.status === 'rejected' || inventory.value === null)) {
        setSettled({ key, actions, facts: { status: 'unavailable' } });
        return;
      }
      let restorePoints: DeploymentBackupRestorePointCount | null = null;
      if (restorePointSourceIds !== null) {
        const sources = new Set(restorePointSourceIds);
        restorePoints = inventory.status === 'fulfilled' && inventory.value !== null
          ? { status: 'ready', count: inventory.value.snapshots.reduce((count, row) =>
            count + (row.source && sources.has(row.source.sourceId) ? 1 : 0), 0) }
          : { status: 'unavailable' };
      }
      setSettled({ key, actions, facts: { status: 'ready', history: history.status === 'fulfilled' ? history.value : null,
        missed: missed.status === 'fulfilled' ? missed.value : NO_MISSED, restorePoints } });
    });
    return () => { live = false; };
    // Parsed operands and source IDs may be rebuilt by callers; their serialized values own this read's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, key, presented, generation]);
  const reload = React.useCallback(() => setGeneration(value => value + 1), []);
  return { facts: input ? settled.key === key && settled.actions === actions ? settled.facts : LOADING_FACTS : null, reload };
}

/** What the facts say needs the person: an overdue unstarted run first, then a latest backup that failed. */
export function deploymentBackupAttention(facts: DeploymentBackupFacts | null) {
  const ready = facts?.status === 'ready' ? facts : null;
  const missed = ready?.missed[0] ?? null;
  const latestBackup = ready?.history?.history.entries.find(entry => entry.action === 'backup') ?? null;
  return {
    missed,
    failed: latestBackup?.state === 'failed' ? latestBackup : null,
    lastGood: ready?.history?.lastSuccessfulBackup ?? null,
    entries: ready?.history?.history.entries ?? [],
  };
}
