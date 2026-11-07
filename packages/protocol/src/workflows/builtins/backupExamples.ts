import { DeploymentBackupRunInputV1Schema } from '../../deployments/deploymentBackupActionsV1.js';
import { ProjectReadinessReadInputV1Schema } from '../../projects/readinessV1.js';
import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { input, literal, result } from './definitionParts.js';

// The public backup schema owns the configured target fields. Each saved
// Workflow supplies that exact target; no starter chooses a controller or host.
const backupTargetReferences = () => Object.fromEntries(Object.keys(DeploymentBackupRunInputV1Schema.shape)
  .map(name => [name, { kind: 'input' as const, name: 'backupTarget', path: [name] }]));
const targetInput = { name: 'backupTarget', valueType: 'json' as const, required: true };

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
