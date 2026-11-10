import { DeploymentRestorePreparationV1Schema } from '@happier-dev/deployment-protocol';
import { DeploymentNativeSnapshotOfferV1Schema, DeploymentNativeSnapshotUnavailableV1Schema, type DeploymentNativeSnapshotOfferV1, type DeploymentNativeSnapshotUnavailableV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol';
import type { DeploymentBackupInventoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { deploymentDataTargetOperands } from '@happier-dev/deployments';

import type { DeploymentUiRestoreInput } from './deploymentActions';
import type { DeploymentRetainedBackupSummary } from './useDeploymentReads';
import type { DeploymentRestoreChoice } from './DeploymentRestoreSheet';

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
    source: {
      kind: 'repository', snapshotId: backup.restoreBackupId,
      ...(copy && detail.runtimeTargetLink ? {
        backupOperationId: copy.backupOperationId,
        origin: { environmentId: detail.environment.id, targetLinkId: detail.runtimeTargetLink.id },
      } : {}),
    },
    ...(copy ? { destination: { kind: 'database', service: copy.service, database: copy.database } } : {}),
  };
}

/** One inventory projection for recovery and read-only preview intent. */
export type DeploymentBackupCaptureChoice = DeploymentRestoreChoice & Readonly<{
  copyFrom: NonNullable<Extract<DeploymentPreviewDataSelectionV1, { kind: 'template' }>['copyFrom']> | null;
}>;

export function deploymentBackupCaptureChoices(input: Readonly<{
  inventory: DeploymentBackupInventoryResultV1;
  target: NonNullable<ReturnType<typeof deploymentDataTargetOperands>>;
  deploymentId: string;
  sourceId: string | null;
  service: string;
  database: string;
  retainedChoice?: DeploymentRestoreChoice | null;
}>): readonly DeploymentBackupCaptureChoice[] {
  const listed = input.inventory.snapshots.map((entry): DeploymentBackupCaptureChoice => {
    const snapshotId = entry.snapshot.snapshotId;
    const takenAtMs = Date.parse(entry.snapshot.time);
    const run = entry.verification.kind === 'verified' ? entry.verification.backupOperationId : null;
    const copyFrom = run && entry.source?.kind === 'dump' && entry.source.sourceId === input.sourceId ? {
      environmentId: input.target.environmentId, targetLinkId: input.target.targetLinkId,
      deploymentId: input.deploymentId, snapshotId, backupOperationId: run,
    } : null;
    if (snapshotId === input.retainedChoice?.snapshotId) return { ...input.retainedChoice, copyFrom };
    return { snapshotId, takenAtMs, kind: 'scheduled', copyFrom, restore: run ? {
      backup: { deploymentId: input.deploymentId, restoreBackupId: snapshotId, takenAtMs,
        service: input.service, database: input.database, versionLabel: null },
      operands: { ...input.target, deploymentId: input.deploymentId,
        source: { kind: 'repository', snapshotId, backupOperationId: run } },
    } : null };
  });
  // A receipt-only capture remains recoverable, but cannot seed a portable copy
  // without the inventory producer's verified run identity.
  const all = input.retainedChoice && !listed.some(choice => choice.snapshotId === input.retainedChoice?.snapshotId)
    ? [{ ...input.retainedChoice, copyFrom: null }, ...listed] : listed;
  return all.sort((left, right) => right.takenAtMs - left.takenAtMs);
}

/** What the prepare step checked, read from the evidence its Action operation retained. */
export type DeploymentRestorePreparation = Readonly<{
  prepareOperationId: string;
  takenAtMs: number | null;
  destination: Readonly<{ adapter: 'postgres-v1'; service: string; database: string }> | Readonly<{ adapter: 'volume-v1'; service: string; volume: string }>;
  snapshot: DeploymentNativeSnapshotOfferV1 | null;
  snapshotUnavailable: DeploymentNativeSnapshotUnavailableV1 | null;
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
  const snapshot = evidence && typeof evidence === 'object' && !Array.isArray(evidence) && 'snapshot' in evidence
    ? DeploymentNativeSnapshotOfferV1Schema.safeParse(evidence.snapshot) : null;
  if (snapshot && !snapshot.success) return null;
  const unavailable = evidence && typeof evidence === 'object' && !Array.isArray(evidence) && 'snapshotUnavailable' in evidence
    ? DeploymentNativeSnapshotUnavailableV1Schema.safeParse(evidence.snapshotUnavailable) : null;
  return {
    prepareOperationId: result.operationId,
    takenAtMs: time('snapshot' in prepared.source ? prepared.source.snapshot.time : undefined),
    destination: prepared.destination.adapter === 'volume-v1'
      ? { adapter: 'volume-v1', service: prepared.destination.service, volume: prepared.destination.volume }
      : { adapter: 'postgres-v1', service: prepared.destination.service, database: prepared.destination.database },
    snapshot: snapshot?.success ? snapshot.data : null,
    snapshotUnavailable: unavailable?.success ? unavailable.data : null,
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
