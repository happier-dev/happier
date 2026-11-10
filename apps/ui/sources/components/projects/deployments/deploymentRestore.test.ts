import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { deploymentBackupCaptureChoices, deploymentRestoreOperands } from './deploymentRestore';
import { DeploymentBackupInventoryResultV1Schema, type DeploymentBackupInventoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { deploymentDataTargetOperands } from '@happier-dev/deployments';

describe('database copy restore operands', () => {
  it('addresses the destination while retaining the source capture identity', () => {
    const source = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: createDeploymentTargetLinkHeaderV1() };
    const destination = { ...source, environment: { ...source.environment, id: 'dedicated-database', revision: 8 },
      runtimeTargetLink: createDeploymentTargetLinkHeaderV1({ id: 'destination-link' }) };
    const backup = { deploymentId: 'source-deploy', restoreBackupId: 'snapshot', takenAtMs: 1,
      service: 'postgres', database: 'shop', versionLabel: null };
    expect(deploymentRestoreOperands(source, backup, {
      detail: destination, service: 'database', database: 'moved_shop', backupOperationId: 'backup-run',
    })).toEqual({
      ...deploymentRestoreOperands(destination, backup),
      source: { kind: 'repository', snapshotId: backup.restoreBackupId, backupOperationId: 'backup-run',
        origin: { environmentId: source.environment.id, targetLinkId: source.runtimeTargetLink!.id } },
      destination: { kind: 'database', service: 'database', database: 'moved_shop' },
    });
  });
});

describe('database backup capture choices', () => {
  it('shares exact verified dump captures with preview intent while retaining ordinary recovery choices', () => {
    const detail = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: createDeploymentTargetLinkHeaderV1() };
    const target = deploymentDataTargetOperands(detail);
    if (!target) throw new Error('Fixture requires an own-server data target');
    const snapshot = (id: string, time: string) => ({ snapshotId: id, treeId: 'f'.repeat(64), hostname: 'source', time, paths: ['dump'], tags: [] });
    const inventory: DeploymentBackupInventoryResultV1 = DeploymentBackupInventoryResultV1Schema.parse({ kind: 'inventory', environmentId: target.environmentId,
      configRevision: 2, repositoryId: 'e'.repeat(64), snapshots: [
        { snapshot: snapshot('a'.repeat(64), '2026-11-10T10:00:00Z'), source: { kind: 'dump', sourceId: 'shop' },
          verification: { kind: 'verified', backupOperationId: 'exact-source-run', configRevision: 1 } },
        { snapshot: snapshot('b'.repeat(64), '2026-11-10T11:00:00Z'), source: { kind: 'dump', sourceId: 'shop' },
          verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' } },
        { snapshot: snapshot('c'.repeat(64), '2026-11-10T12:00:00Z'), source: { kind: 'volume', sourceId: 'files' },
          verification: { kind: 'verified', backupOperationId: 'volume-run', configRevision: 2 } },
        { snapshot: snapshot('e'.repeat(64), '2026-11-10T09:00:00Z'), source: { kind: 'dump', sourceId: 'another-database' },
          verification: { kind: 'verified', backupOperationId: 'foreign-source-run', configRevision: 2 } },
      ] });
    const backup = { deploymentId: 'retained-deploy', restoreBackupId: 'd'.repeat(64), takenAtMs: 1,
      service: 'postgres', database: 'shop', versionLabel: null };
    const retainedChoice = { snapshotId: backup.restoreBackupId, takenAtMs: backup.takenAtMs,
      kind: 'beforeMigration' as const, restore: { backup, operands: { ...target,
        deploymentId: backup.deploymentId, source: { kind: 'repository' as const, snapshotId: backup.restoreBackupId } } } };
    const choices = deploymentBackupCaptureChoices({ inventory, target, deploymentId: 'current-deploy',
      sourceId: 'shop', service: 'postgres', database: 'shop', retainedChoice });
    expect(choices.map(choice => choice.snapshotId)).toEqual(['c'.repeat(64), 'b'.repeat(64), 'a'.repeat(64), 'e'.repeat(64), 'd'.repeat(64)]);
    expect(choices.find(choice => choice.snapshotId === 'a'.repeat(64))?.copyFrom).toEqual({
      environmentId: target.environmentId, targetLinkId: target.targetLinkId, deploymentId: 'current-deploy',
      snapshotId: 'a'.repeat(64), backupOperationId: 'exact-source-run',
    });
    expect(choices.filter(choice => choice.copyFrom).map(choice => choice.snapshotId)).toEqual(['a'.repeat(64)]);
    expect(choices.find(choice => choice.snapshotId === 'b'.repeat(64))?.restore).toBeNull();
    expect(choices.find(choice => choice.snapshotId === 'd'.repeat(64))?.restore).toEqual(retainedChoice.restore);

    const listedRetained = { ...retainedChoice, snapshotId: 'a'.repeat(64),
      restore: { ...retainedChoice.restore, backup: { ...backup, restoreBackupId: 'a'.repeat(64) } } };
    const matching = deploymentBackupCaptureChoices({ inventory, target, deploymentId: 'current-deploy',
      sourceId: 'shop', service: 'postgres', database: 'shop', retainedChoice: listedRetained });
    const selected = matching.find(choice => choice.snapshotId === 'a'.repeat(64));
    expect(matching.filter(choice => choice.snapshotId === 'a'.repeat(64))).toHaveLength(1);
    expect(selected?.restore).toEqual(listedRetained.restore);
    expect(selected?.copyFrom?.backupOperationId).toBe('exact-source-run');
    expect(selected?.copyFrom?.deploymentId).toBe('current-deploy');
  });
});
