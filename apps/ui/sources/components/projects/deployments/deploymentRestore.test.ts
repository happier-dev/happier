import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { deploymentBackupCaptureChoices, deploymentDatabaseMoveDestination, deploymentRestoreOperands, readDeploymentRestorePreparation } from './deploymentRestore';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentRestorePreparationV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentBackupInventoryResultV1Schema, type DeploymentBackupInventoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { deploymentDataTargetOperands } from '@happier-dev/deployments';

it('retains the canonical SQLite destination and its service-owned path from restore preparation', () => {
  const native = DeploymentRestorePreparationV1Schema.parse({ prepared: {
    kind: 'prepared', operationId: 'sqlite-prepare', sourceFormat: 'sqlite',
    source: { kind: 'upload', transferId: 'sqlite-upload', sizeBytes: 42, sha256: 'a'.repeat(64) },
    destination: { adapter: 'sqlite-v1', service: 'app', path: '/data/shop.sqlite',
      environmentId: 'shop-environment', revision: 2, stagingVolume: 'shop_restore',
      hasMeaningfulData: true, writerServices: ['app'] },
  } });
  expect(readDeploymentRestorePreparation({ kind: 'prepared', operationId: 'sqlite-prepare',
    evidence: { native } })?.destination).toEqual(native.prepared.destination);
});

describe('database copy restore operands', () => {
  it.each(['neon', 'supabase'])('returns typed unavailable for a %s move without a supported import', provider => {
    const base = createDeploymentEnvironmentDetailV1();
    const targetLink = createDeploymentTargetLinkHeaderV1({ role: 'data', targetKind: provider,
      machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId: `happier.deploy.${provider}`, localId: 'database' } } });
    const destination = { ...base, runtimeTargetLink: null,
      targetLinks: [{ targetLink, content: { providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project',
        providerEnvironment: 'main' }, providerEnvironment: { kind: 'native' as const, selection: { branchId: 'main' } } } }] };
    expect(deploymentDatabaseMoveDestination(destination))
      .toEqual({ kind: 'unavailable', reason: 'unsupported' });
    // A verified source capture cannot turn an undeclared provider import into native restore operands.
    expect(deploymentRestoreOperands({ ...base, runtimeTargetLink: base.targetLinks[0]!.targetLink },
      { deploymentId: 'source-deploy', restoreBackupId: 'snapshot', takenAtMs: 1,
        service: 'postgres', database: 'shop', versionLabel: null },
      { detail: destination, service: 'database', database: 'shop', backupOperationId: 'verified-source-backup' })).toBeNull();
  });

  it('requires a shared backup transport only for a cross-Machine Move', () => {
    const source = { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: createDeploymentTargetLinkHeaderV1() };
    const member = source.runtimeTargetLink.members[0]!;
    const detail = createDeploymentEnvironmentDetailV1();
    const base = { ...detail, databaseMoveCandidate: true, content: { ...detail.content, backup: {
      configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'remote' },
      occurrenceId: 'repository', config: {}, credentialBindings: [],
      ownership: { environmentId: detail.environment.id, prefix: 'database/' },
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      retention: { kind: 'keepEverything' as const },
    },
      bindings: [
        { purpose: 'variable' as const, phase: 'runtime' as const, name: 'POSTGRES_USER', source: { kind: 'value' as const, value: 'shop' } },
        { purpose: 'variable' as const, phase: 'runtime' as const, name: 'POSTGRES_DB', source: { kind: 'value' as const, value: 'shop' } },
        createDeploymentSecretVariableBindingV1({ name: 'POSTGRES_PASSWORD', phase: 'runtime', resourceId: 'database-password', resourceRevision: 1 }),
      ],
      ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true, serviceExports: [
        { key: 'database', service: 'postgres', containerPort: 5432, scheme: 'postgres',
          exposure: 'privateNetwork' as const, privateNetwork: 'operations' },
      ] },
      template: { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17',
        ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } },
        definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
        services: ['postgres'], data: [{ engine: 'postgres' as const, service: 'postgres',
          variables: { username: 'POSTGRES_USER', database: 'POSTGRES_DB', password: 'POSTGRES_PASSWORD' } }] },
    } };
    const on = (machineId: string, installationId: string) => ({ ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1({
      id: 'destination-link', machines: [machineId], members: [{ ...member, machineId, installationId }] }) });
    const sameMachine = { ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1({ id: 'destination-link' }) };
    const crossMachine = on('other-machine', 'other-installation');
    const backup = (resticTransport: 'local' | 'sftp') => ({ machineId: member.machineId, resticTransport });
    expect(deploymentDatabaseMoveDestination(crossMachine, backup('local')))
      .toEqual({ kind: 'unavailable', reason: 'local_backup_cross_machine' });
    expect(deploymentDatabaseMoveDestination(sameMachine, backup('local'))?.kind).toBe('ready');
    expect(deploymentDatabaseMoveDestination(crossMachine, { machineId: member.machineId }))
      .toEqual({ kind: 'unavailable', reason: 'backup_destination_unavailable' });
    expect(deploymentDatabaseMoveDestination(crossMachine, backup('sftp'))?.kind).toBe('ready');
  });

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
    const dump = { kind: 'dump', sourceId: 'shop', service: 'postgres', consistency: 'logical' } as const;
    const volume = { kind: 'volume', sourceId: 'files', service: 'postgres', volume: 'postgres-data', consistency: 'stopDuringCopy' } as const;
    const choices = deploymentBackupCaptureChoices({ inventory, target, deploymentId: 'current-deploy',
      sourceId: 'shop', service: 'postgres', database: 'shop', backupSources: [dump, volume], retainedChoice });
    expect(choices.map(choice => choice.snapshotId)).toEqual(['c'.repeat(64), 'b'.repeat(64), 'a'.repeat(64), 'e'.repeat(64), 'd'.repeat(64)]);
    expect(choices.find(choice => choice.snapshotId === 'c'.repeat(64))).toMatchObject({ backupSource: volume });
    expect(choices.find(choice => choice.snapshotId === 'a'.repeat(64))).toMatchObject({ backupSource: dump });
    expect(choices.find(choice => choice.snapshotId === 'e'.repeat(64))).not.toHaveProperty('backupSource');
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
