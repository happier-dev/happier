import { DeploymentBackupRunInputV1Schema } from '../../deployments/deploymentBackupActionsV1.js';
import { DeploymentBackupRestorePrepareInputV1Schema } from '../../deployments/deploymentBackupRestoreV1.js';
import { DeploymentDataQueryInputV1Schema } from '../../deployments/deploymentReadsV1.js';
import { ProjectReadinessReadInputV1Schema } from '../../projects/readinessV1.js';
import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { input, literal, result } from './definitionParts.js';

// The public backup schema owns the configured target fields. Each saved
// Workflow supplies that exact target; no starter chooses a controller or host.
const backupTargetReferences = () => Object.fromEntries(Object.keys(DeploymentBackupRunInputV1Schema.shape)
  .map(name => [name, { kind: 'input' as const, name: 'backupTarget', path: [name] }]));
const targetInput = { name: 'backupTarget', valueType: 'json' as const, required: true };

/** Reuses a person-selected isolated Environment; its retained grants never become Workflow inputs. */
export function createRestoreDrillWorkflowV1(): WorkflowDefinitionV1 {
  const services = { serverId: input('drillTarget', ['serverId']), machineId: input('drillTarget', ['machineId']),
    environmentId: input('drillTarget', ['environmentId']) };
  const control = (operation: 'start' | 'stop') => ({ serverId: services.serverId, machineId: services.machineId,
    serviceId: { kind: 'item' as const, field: 'value' as const, path: ['serviceId'] },
    expectedGeneration: { kind: 'item' as const, field: 'value' as const, path: ['generation'] }, operation: literal(operation) });
  const restore = Object.fromEntries(Object.keys(DeploymentBackupRestorePrepareInputV1Schema.shape)
    .filter(name => name !== 'mode').map(name => [name,
      name === 'source' ? input('restoreSource') : name === 'destination' ? input('restoreDestination')
        : input(name === 'deploymentId' ? 'backupTarget' : 'drillTarget', [name])]));
  const query = Object.fromEntries(Object.keys(DeploymentDataQueryInputV1Schema.shape).map(name => [name,
    name in DeploymentBackupRestorePrepareInputV1Schema.shape ? input('drillTarget', [name]) : input('dataCheck', [name])]));
  return {
    version: 1, defaults: {}, inputs: [targetInput,
      { name: 'restoreSource', valueType: 'json', required: true,
        description: 'The selected repository snapshot, backup operation and original source Environment.' },
      { name: 'drillTarget', valueType: 'json', required: true,
        description: 'The existing isolated destination and its current serving deployment. Keep this Environment and its sealed grants between runs.' },
      { name: 'restoreDestination', valueType: 'json', required: true,
        description: 'The database or volume inside the isolated drill Environment.' },
      { name: 'verificationLevel', valueType: 'string', required: true },
      { name: 'dataCheck', valueType: 'json', required: true,
        description: 'A service, read-only SQL statement and named parameters that prove the restored data is usable.' },
    ],
    blocks: [
      { kind: 'parallel', id: 'drill', name: 'Restore and check the retained drill Environment', failurePolicy: 'collect_outcomes', branches: [
        { id: 'restoreAndCheck', name: 'Check this recovery point', blocks: [
          { kind: 'action', id: 'drillServices', name: 'Read the isolated Environment services', actionId: 'machines.services.list', input: services },
          { kind: 'loop', id: 'startDrill', name: 'Start the retained drill services', repetition: {
            kind: 'items', items: result('drillServices', ['services']), execution: 'sequential', failurePolicy: 'fail_stop',
          }, body: [{ kind: 'action', id: 'startService', name: 'Start this drill service', actionId: 'machines.services.control', input: control('start') }] },
          { kind: 'action', id: 'verify', name: 'Verify the exact source snapshot', actionId: 'deployments.backups.verify', input: {
            ...backupTargetReferences(), backupOperationId: input('restoreSource', ['backupOperationId']),
            snapshotId: input('restoreSource', ['snapshotId']), level: input('verificationLevel'),
          } },
          { kind: 'action', id: 'prepareRestore', name: 'Prepare restore into the isolated Environment', actionId: 'deployments.backups.restore',
            input: { ...restore, mode: literal('prepare') } },
          { kind: 'action', id: 'confirmRestore', name: 'Restore this recovery point', actionId: 'deployments.backups.restore',
            input: { ...restore, mode: literal('confirm'), prepareOperationId: result('prepareRestore', ['operationId']) } },
          { kind: 'action', id: 'checkData', name: 'Check restored data with the read-only database role', actionId: 'deployments.data.query', input: query },
        ] },
      ] },
      // Resolve current service generations after restore. A volume activation may
      // replace them; cleanup must consume the same inventory owner as Start.
      { kind: 'action', id: 'cleanupServices', name: 'Read the retained drill services after the check', runWhen: 'always',
        actionId: 'machines.services.list', input: services },
      { kind: 'loop', id: 'stopDrill', name: 'Stop the isolated Environment and retain its data', runWhen: 'always', repetition: {
        kind: 'items', items: result('cleanupServices', ['services']), execution: 'sequential', failurePolicy: 'collect_outcomes',
      }, body: [{ kind: 'action', id: 'stopService', name: 'Stop this drill service', actionId: 'machines.services.control', input: control('stop') }] },
    ], finalOutput: result('drill'),
  };
}

export function createDailyHealthDigestWorkflowV1(): WorkflowDefinitionV1 {
  return {
  version: 1, defaults: {}, inputs: [{ name: 'readinessScope', valueType: 'json', required: true },
    { name: 'backupAutomationIds', valueType: 'json', required: true }],
  blocks: [{ kind: 'parallel', id: 'digest', name: 'Read current health and backup facts', failurePolicy: 'collect_outcomes', branches: [
    { id: 'readinessBranch', name: 'Project readiness', blocks: [{ kind: 'action', id: 'readiness', name: 'Read Project readiness',
      actionId: 'projects.readiness.read', input: Object.fromEntries(Object.keys(ProjectReadinessReadInputV1Schema.shape)
        .map(name => [name, { kind: 'input' as const, name: 'readinessScope', path: [name] }])) }] },
    { id: 'schedules', name: 'Enabled schedules and next due', blocks: [{ kind: 'loop', id: 'automationSchedules',
      name: 'Read each selected backup Automation', repetition: { kind: 'items', items: input('backupAutomationIds'),
        execution: 'sequential', failurePolicy: 'fail_stop' }, body: [{ kind: 'action', id: 'schedule',
        name: 'Read the saved schedule and its next due time', actionId: 'workflow.trigger.list',
        input: { automationId: { kind: 'item', field: 'value' }, review: literal(true) } }] }] },
    { id: 'runs', name: 'Last started backup runs', blocks: [{ kind: 'action', id: 'startedRuns',
      name: 'Read actual backup run summaries', actionId: 'workflow.run.summaries',
      input: { automationIds: input('backupAutomationIds') } }] },
  ] }],
  finalOutput: result('digest'),
  };
}

export function createBackupVerifyWorkflowV1(): WorkflowDefinitionV1 {
  const target = backupTargetReferences();
  return {
  version: 1, defaults: {}, inputs: [targetInput,
    { name: 'backupOperationId', valueType: 'string', required: true },
    { name: 'snapshotId', valueType: 'string', required: true },
    { name: 'verificationLevel', valueType: 'string', required: true },
  ],
  blocks: [{ kind: 'action', id: 'verify', name: 'Verify the exact backup snapshot', actionId: 'deployments.backups.verify',
    input: { ...target, backupOperationId: input('backupOperationId'), snapshotId: input('snapshotId'),
      level: input('verificationLevel') } }],
  finalOutput: result('verify'),
  };
}

export function createNightlyBackupsWorkflowV1(): WorkflowDefinitionV1 {
  const target = backupTargetReferences();
  return {
  version: 1, defaults: {}, inputs: [targetInput,
    { name: 'verificationLevel', valueType: 'string', required: true },
    { name: 'retention', valueType: 'json', required: true },
  ],
  blocks: [
    { kind: 'action', id: 'backup', name: 'Back up the configured data', actionId: 'deployments.backups.run', input: target },
    { kind: 'loop', id: 'snapshots', name: 'Verify every returned snapshot',
      repetition: { kind: 'items', items: result('backup', ['manifests']), execution: 'sequential', failurePolicy: 'fail_stop' },
      body: [{ kind: 'action', id: 'verify', name: 'Verify this backup snapshot', actionId: 'deployments.backups.verify',
        input: { ...target, backupOperationId: result('backup', ['operationId'], { kind: 'outer', levels: 1 }),
          snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] }, level: input('verificationLevel') } }],
    },
    // The prune owner checks existing verified receipts and the configured
    // retention policy. Failure of any verification stops before this Action.
    { kind: 'action', id: 'prune', name: 'Apply the chosen retention policy', actionId: 'deployments.backups.prune',
      input: { ...target, retention: input('retention') } },
  ],
  finalOutput: result('prune'),
  };
}
