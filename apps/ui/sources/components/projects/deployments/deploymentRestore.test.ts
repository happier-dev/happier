import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { deploymentRestoreOperands } from './deploymentRestore';

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
      ...deploymentRestoreOperands(destination, backup), backupOperationId: 'backup-run',
      copy: { source: { environmentId: source.environment.id, targetLinkId: source.runtimeTargetLink!.id },
        destination: { service: 'database', database: 'moved_shop' } },
    });
  });
});
