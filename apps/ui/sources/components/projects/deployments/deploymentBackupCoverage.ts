import type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import type { ProjectReadinessReadInputV1, ProjectReadinessReadResultV1 } from '@happier-dev/protocol/projects/readinessV1';

type Environment = Pick<DeploymentEnvironmentHeaderV1, 'id' | 'serverId' | 'projectSourceId' | 'controllerMachineId' | 'revision'>;
export type BackupReadinessObservation = Readonly<{ input: ProjectReadinessReadInputV1;
  result: ProjectReadinessReadResultV1 | null; pending: boolean; failureCode: string | null }>;
export type EnvironmentBackupCoverage = Readonly<{ environment: Environment;
  status: 'covered' | 'uncovered' | 'notNeeded' | 'loading' | 'unavailable'; reason: string | null; refreshing: boolean }>;

/** Pass only the index's visible Environment headers. Closed surfaces select zero reads.
 * One existing projects.readiness.read per (Home, Project Source, Machine), never per app. */
export function planVisibleBackupReadiness(visible: readonly Environment[], active: boolean): readonly ProjectReadinessReadInputV1[] {
  if (!active) return [];
  const groups = new Map<string, ProjectReadinessReadInputV1>();
  for (const environment of visible) {
    const key = JSON.stringify([environment.serverId, environment.projectSourceId, environment.controllerMachineId]);
    let group = groups.get(key);
    if (!group) {
      group = { serverId: environment.serverId, projectId: environment.projectSourceId,
        machineId: environment.controllerMachineId, environments: [] };
      groups.set(key, group);
    }
    group.environments.push({ environmentId: environment.id, expectedRevision: environment.revision });
  }
  return [...groups.values()];
}

function selectionKey(environment: Environment) {
  return JSON.stringify([environment.serverId, environment.projectSourceId, environment.controllerMachineId, environment.id, environment.revision]);
}

/** Presentation of the canonical backup facts, independent of CI/health aggregate status.
 * The readiness owner omits backups exactly when it has admitted an Environment with no durable data. */
export function projectBackupCoverage(visible: readonly Environment[], observations: readonly BackupReadinessObservation[]) {
  const outcomes = new Map<string, Omit<EnvironmentBackupCoverage, 'environment'>>();
  let degraded = false;
  const visibleKeys = new Set(visible.map(selectionKey));
  for (const observation of observations) {
    const { input, result, pending, failureCode } = observation;
    const facts = new Map(result?.facts.filter(fact => fact.kind === 'backups').map(fact => [fact.environmentId, fact]));
    const admitted = new Set(result?.facts.filter(fact => fact.kind === 'health').map(fact => fact.environmentId));
    for (const selection of input.environments) {
      const key = selectionKey({ serverId: input.serverId, projectSourceId: input.projectId, controllerMachineId: input.machineId,
        id: selection.environmentId, revision: selection.expectedRevision });
      if (!visibleKeys.has(key)) continue;
      degraded ||= pending || failureCode !== null;
      const fact = facts.get(selection.environmentId);
      const status = fact ? fact.status === 'ready' ? fact.reason === 'notNeeded' ? 'notNeeded' : 'covered'
        : fact.status === 'actionNeeded' ? 'uncovered' : 'unavailable'
        : admitted.has(selection.environmentId) ? 'notNeeded' : failureCode ? 'unavailable' : 'loading';
      outcomes.set(key,
      { status, reason: fact?.reason ?? failureCode, refreshing: pending });
    }
  }
  const rows: readonly EnvironmentBackupCoverage[] = visible.map(environment => ({ environment,
    ...(outcomes.get(selectionKey(environment)) ?? { status: 'loading', reason: null, refreshing: false }) }));
  const count = (status: EnvironmentBackupCoverage['status']) => rows.filter(row => row.status === status).length;
  const covered = count('covered'); const uncovered = count('uncovered'); const notNeeded = count('notNeeded');
  const unresolved = count('loading') + count('unavailable');
  const status = rows.length === 0 ? 'empty' : rows.every(row => row.status === 'loading') ? 'loading'
    : rows.every(row => row.status === 'unavailable') ? 'unavailable' : unresolved > 0 || degraded ? 'partial' : 'ready';
  return { status, rows, covered, uncovered, notNeeded, unresolved, total: rows.length - notNeeded } as const;
}
