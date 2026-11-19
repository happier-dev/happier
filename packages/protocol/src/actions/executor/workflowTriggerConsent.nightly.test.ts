import { describe, expect, it } from 'vitest';
import { createBackupVerifyWorkflowV1, createNightlyBackupsWorkflowV1 } from '../../workflows/builtins/backupExamples.js';
import { readWorkflowTriggerActionConsent } from './workflowTriggerConsent.js';

describe('Nightly saved trigger consent', () => {
  it('preserves fixed snapshot verification consent outside the per-snapshot Nightly loop', async () => {
    const backupTarget = { serverId: 'home', environmentId: 'environment', expectedRevision: 4, configRevision: 1,
      machineId: 'machine', installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment' };
    const { steps } = await readWorkflowTriggerActionConsent({ definition: createBackupVerifyWorkflowV1(),
      context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        inputs: { backupTarget, backupOperationId: 'backup-operation', snapshotId: 'a'.repeat(64), verificationLevel: 'manifestReadBack' } },
      project: { machineId: 'controller', directory: '/repo' }, triggerId: 'verify',
      resolveWorkflow: async () => { throw new Error('Verification contains no child Workflow'); } });
    expect(steps).toEqual([{ actionId: 'deployments.backups.verify', input: { ...backupTarget,
      backupOperationId: 'backup-operation', snapshotId: 'a'.repeat(64), level: 'manifestReadBack' } }]);
  });
  it('binds the standing Environment and destination policy while deferring only the current capture', async () => {
    const backupEnvironment = { serverId: 'home', environmentId: 'environment' };
    const backupPolicy = { destinationRef: { pluginId: 'example.backups', localId: 'repository' }, occurrenceId: 'installed',
      config: { path: '/backups/app' }, credentialBindings: [],
      sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
      ownership: { environmentId: 'environment', prefix: 'app' }, retention: { kind: 'keepEverything' } };
    const { steps } = await readWorkflowTriggerActionConsent({ definition: createNightlyBackupsWorkflowV1(),
      context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        inputs: { backupEnvironment, backupPolicy, verificationLevel: 'manifestReadBack' } },
      project: { machineId: 'controller', directory: '/repo' }, triggerId: 'nightly',
      resolveWorkflow: async () => { throw new Error('Nightly contains no child Workflow'); } });
    expect(steps).toContainEqual({ actionId: 'deployments.environments.get', input: { ...backupEnvironment, backupPolicy } });
    expect(steps.find(step => step.actionId === 'deployments.backups.run')).toMatchObject({
      input: {}, binding: { kind: 'producer_result', references: {
        expectedRevision: { kind: 'result', path: ['backupTarget', 'expectedRevision'] },
        deploymentId: { kind: 'result', path: ['backupTarget', 'deploymentId'] },
      } },
    });
    expect(steps.find(step => step.actionId === 'deployments.backups.prune')).toMatchObject({
      input: { retention: backupPolicy.retention }, binding: { kind: 'producer_result' },
    });
  });
});
