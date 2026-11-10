import { DeploymentRestorePreparationV1Schema } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

import type { DeploymentUiRestoreInput } from './deploymentActions';
import type { DeploymentRetainedBackupSummary } from './useDeploymentReads';

/**
 * A backup this Environment can restore: the pre-migration dump a deploy retained on its receipt. The receipt
 * is the capture the restore Action admits; the snapshot names the exact backup inside it.
 */
export type DeploymentRetainedBackup = Readonly<{
  deploymentId: string;
  restoreBackupId: string;
  takenAtMs: number;
  service: string;
  database: string;
  /** The version whose migration it was taken before, when the receipt names one. */
  versionLabel: string | null;
}>;

/** The sheet's view of the retained-backup summary the receipt read owner projects. */
export function retainedBackupFromSummary(
  summary: DeploymentRetainedBackupSummary,
  versionLabel: string | null,
): DeploymentRetainedBackup | null {
  const { capture } = summary;
  if (capture.source.kind !== 'dump') return null;
  const takenAtMs = Date.parse(capture.source.snapshot.time);
  if (!Number.isFinite(takenAtMs)) return null;
  return {
    deploymentId: summary.deploymentId,
    restoreBackupId: summary.backupId,
    takenAtMs,
    service: capture.target.service,
    database: capture.target.database,
    versionLabel,
  };
}

/** The Machine that runs the restore: the runtime link's first member, where the database service runs. */
export type DeploymentRestoreOperands = Omit<
  Extract<DeploymentUiRestoreInput, { mode: 'prepare' }>,
  'mode'
>;

/** Stateful backup and restore operations use the same own-server member. */
export function deploymentDataTargetOperands(detail: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'runtimeTargetLink'>) {
  const link = detail.runtimeTargetLink;
  const member = link?.targetKind === 'ownServer' ? link.members[0] : undefined;
  if (!link || !member) return null;
  return {
    environmentId: detail.environment.id,
    expectedRevision: detail.environment.revision,
    machineId: member.machineId,
    installationId: member.installationId,
    targetLinkId: link.id,
  };
}

/** The exact operands both steps send. Null when the Environment has no own-server runtime to restore on. */
export function deploymentRestoreOperands(
  detail: Pick<
    DeploymentEnvironmentReadDetailV1,
    'environment' | 'runtimeTargetLink'
  >,
  backup: DeploymentRetainedBackup,
  copy?: Readonly<{
    detail: Pick<DeploymentEnvironmentReadDetailV1, 'environment' | 'runtimeTargetLink'>;
    service: string;
    database: string;
    backupOperationId: string;
  }>,
): DeploymentRestoreOperands | null {
  const target = deploymentDataTargetOperands(copy?.detail ?? detail);
  if (!target) return null;
  if (copy && !detail.runtimeTargetLink) return null;
  return {
    ...target,
    deploymentId: backup.deploymentId,
    restoreBackupId: backup.restoreBackupId,
    ...(copy && detail.runtimeTargetLink ? {
      backupOperationId: copy.backupOperationId,
      copy: { source: { environmentId: detail.environment.id, targetLinkId: detail.runtimeTargetLink.id },
        destination: { service: copy.service, database: copy.database } },
    } : {}),
  };
}

/** What the prepare step checked, read from the evidence its Action operation retained. */
export type DeploymentRestorePreparation = Readonly<{
  prepareOperationId: string;
  takenAtMs: number | null;
  service: string;
  database: string;
  /** When the destination held data, the verified safety backup taken first; null when there was nothing to save. */
  safetyBackup: Readonly<{ savedAtMs: number | null }> | null;
}>;

export function readDeploymentRestorePreparation(
  result: DeploymentBackupRestoreResultV1,
): DeploymentRestorePreparation | null {
  if (result.kind !== 'prepared') return null;
  const evidence = result.evidence;
  const native =
    evidence !== null &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    'native' in evidence
      ? evidence.native
      : undefined;
  const parsed = DeploymentRestorePreparationV1Schema.safeParse(native);
  if (!parsed.success) return null;
  const { prepared } = parsed.data;
  const time = (iso: string | undefined) => {
    const at = iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(at) ? at : null;
  };
  const safety = prepared.safetyBackup?.manifests[0];
  return {
    prepareOperationId: result.operationId,
    takenAtMs: time(prepared.source.snapshot.time),
    service: prepared.destination.service,
    database: prepared.destination.database,
    safetyBackup: prepared.safetyBackup
      ? { savedAtMs: time(safety?.snapshot.time) }
      : null,
  };
}

/** Refusals that mean the check is no longer current: the person checks again rather than retrying. */
export function isDeploymentRestoreCheckStale(code: string): boolean {
  return (
    code === 'restore_prepare_required' ||
    code === 'stale_input' ||
    code === 'deployment_conflict'
  );
}
