import type { WorkflowActionFieldBindingV1, WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import type { WorkflowCondition, WorkflowValueReference } from '../workflowReferenceV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { DeploymentBackupRunInputV1Schema, type DeploymentBackupRunInputV1 } from '../../deployments/deploymentBackupActionsV1.js';
import { DeploymentBackupRestorePrepareInputV1Schema, type DeploymentBackupRestorePrepareInputV1 } from '../../deployments/deploymentBackupRestoreV1.js';
import { DeploymentEnvironmentUpdateInputV1Schema, type DeploymentEnvironmentUpdateInputV1 } from '../../deployments/deploymentActionsV1.js';
import { DeploymentDeployIntentInputV1Schema, type DeploymentDeployActionInputV1 } from '../../deployments/deploymentDeployIntentV1.js';
import { DeploymentTeardownRequestInputV1Schema, type DeploymentTeardownRequestInputV1 } from '../../deployments/deploymentTeardownRequestV1.js';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
  DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { MACHINE_SERVICE_CONTROL_ACTION_ID } from '../../local/services/actionIdsV1.js';

export type DeploymentMoveHealthTargetV1 = Readonly<{ environmentId: string; machineId: string;
  installationId: string; targetLinkId: string; deploymentId: string; composeService: string }>;
export type StatefulDeploymentMoveWorkflowInputV1 = Readonly<{
  kind: 'stateful'; serverId: string; requestId: string;
  writers: readonly Readonly<{ machineId: string; serviceId: string; expectedGeneration: string }>[];
  backupTarget: DeploymentBackupRunInputV1; sourceId: string;
  origin: Readonly<{ environmentId: string; targetLinkId: string }>;
  restoreTarget: Omit<DeploymentBackupRestorePrepareInputV1, 'mode' | 'source'>;
  cutover: DeploymentEnvironmentUpdateInputV1; deploy: DeploymentDeployActionInputV1;
  health: DeploymentMoveHealthTargetV1;
  appHealth?: Omit<DeploymentMoveHealthTargetV1, 'deploymentId'>;
  /** Omission explicitly retains the source bytes. Extraction must not tear down its app Environment. */
  teardown?: DeploymentTeardownRequestInputV1;
}>;

type Bindings = Record<string, WorkflowActionFieldBindingV1>;
type References = (id: string, path?: (string | number)[]) => WorkflowValueReference;
type Phase = Readonly<{ id: string; name: string; actionId: string;
  fields(ref: References): Bindings; success(ref: References): WorkflowCondition; afterCutover?: boolean }>;
const equal = (left: WorkflowValueReference, value: string | boolean): WorkflowCondition =>
  ({ kind: 'compare', operator: 'eq', left, right: literal(value) });
const all = (...conditions: WorkflowCondition[]): WorkflowCondition => ({ kind: 'all', conditions });
const operand = (name: string, ...path: (string | number)[]) => input('dataMove', [name, ...path]);

/** Only authoring: all effects, holds and continuation stay in the existing Workflow engine.
 * Writer slots and child operand keys are materialized from the person's exact reviewed input,
 * never a runtime capacity limit. The portable starter illustrates one writer slot; authoring
 * can repeat those same leaf blocks for every reviewed writer before saving the definition. */
export function createDeploymentDataMoveWorkflowV1(reviewed?: StatefulDeploymentMoveWorkflowInputV1): WorkflowDefinitionV1 {
  const writerCount = reviewed?.writers.length || 1;
  const keys = (schema: { shape: Readonly<Record<string, { safeParse(value: undefined): { success: boolean } }>> }, value?: object) =>
    value ? Object.keys(value) : Object.entries(schema.shape).filter(([, field]) => !field.safeParse(undefined).success).map(([key]) => key);
  const fields = (name: string, names: readonly string[]): Bindings => Object.fromEntries(names.map(key => [key, operand(name, key)]));
  const backup = () => fields('backupTarget', keys(DeploymentBackupRunInputV1Schema, reviewed?.backupTarget));
  const writer = (index: number, operation: 'start' | 'stop'): Bindings => ({ serverId: input('dataMove', ['serverId']),
    machineId: operand('writers', index, 'machineId'), serviceId: operand('writers', index, 'serviceId'),
    expectedGeneration: operand('writers', index, 'expectedGeneration'), operation: literal(operation) });
  const resume = (id: string, index = 0): WorkflowBlock[] => {
    if (index === writerCount) return [];
    const { operation: _operation, ...target } = writer(index, 'start');
    const observedId = `${id}Resumed${index}`;
    const running = all(equal(result(observedId, ['kind']), 'service'),
      equal(result(observedId, ['service', 'native', 'phase']), 'running'),
      { kind: 'any', conditions: [equal(result(observedId, ['service', 'state']), 'running'),
        equal(result(observedId, ['service', 'state']), 'healthy')] });
    const next = resume(id, index + 1);
    const decision: WorkflowBlock[] = [{ kind: 'wait', id: `${observedId}Decision`, name: 'Needs decision',
      document: document('The source writer has not been observed running. Inspect its exact service and retained start operation before deciding how to recover. This Move has been abandoned before cutover.') }];
    return [{ kind: 'action', id: `${id}Resume${index}`, name: 'Resume this source writer',
      actionId: MACHINE_SERVICE_CONTROL_ACTION_ID, input: writer(index, 'start') },
    { kind: 'action', id: observedId, name: 'Observe source writer running', actionId: 'machines.services.detail', input: target },
    { kind: 'if', id: `${observedId}Observed`, when: next.length ? running : { kind: 'not', condition: running },
      then: next.length ? next : decision, otherwise: next.length ? decision : [] }];
  };
  const recovery = (id: string, afterCutover: boolean): WorkflowBlock[] => [{ kind: 'wait', id: `${id}Recovery`,
    name: afterCutover ? 'Needs decision' : 'Resume source', document: document(afterCutover
      ? 'Cutover may have changed the serving configuration. Inspect the retained child operations and both Environments. Do not resume an obsolete source writer or repeat an unknown restore. Source bytes are retained.'
      : 'The Move stopped before cutover. Review the retained backup and restore operations. Complete this review only to resume the exact source writers and abandon this Move; starting another Move requires a fresh review.') },
    ...(afterCutover ? [] : resume(id))];

  const quiescence: Phase[] = Array.from({ length: writerCount }, (_, index): Phase[] => [
    { id: `quiesce${index}`, name: 'Quiesce this source writer', actionId: MACHINE_SERVICE_CONTROL_ACTION_ID,
      fields: () => writer(index, 'stop'),
      // accepted is only admission; detail below must independently observe the native stop.
      success: ref => ({ kind: 'any', conditions: [equal(ref(`quiesce${index}`, ['kind']), 'observed'),
        equal(ref(`quiesce${index}`, ['kind']), 'accepted')] }) },
    { id: `stopped${index}`, name: 'Observe this source writer stopped', actionId: 'machines.services.detail',
      fields: () => { const { operation: _operation, ...target } = writer(index, 'stop'); return target; },
      success: ref => all(equal(ref(`stopped${index}`, ['kind']), 'service'),
        equal(ref(`stopped${index}`, ['service', 'state']), 'stopped'),
        equal(ref(`stopped${index}`, ['service', 'native', 'phase']), 'stopped')) },
  ]).flat();
  const restore = (ref: References): Bindings => ({
    ...fields('restoreTarget', keys(DeploymentBackupRestorePrepareInputV1Schema, reviewed?.restoreTarget)
      .filter(key => key !== 'mode' && key !== 'source')),
    source: { kind: 'object', fields: { kind: literal('repository'), origin: operand('origin'),
      snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] }, backupOperationId: ref('backup', ['operationId']) } },
  });
  const healthPhases = (target: 'health' | 'appHealth', id: 'destination' | 'app'): Phase[] => {
    const phases: Phase[] = [
    { id: `${id}Services`, name: 'Read the exact destination service', actionId: 'machines.services.list',
      fields: () => ({ serverId: input('dataMove', ['serverId']), environmentId: operand(target, 'environmentId'),
        machineId: operand(target, 'machineId'), composeService: operand(target, 'composeService') }),
      success: ref => ({ kind: 'compare', operator: 'neq', left: ref(`${id}Services`, ['services']), right: literal([]) }) },
    { id: `${id}Health`, name: 'Verify current serving health', actionId: 'deployments.health.read',
      fields: ref => ({ serverId: input('dataMove', ['serverId']), environmentId: operand(target, 'environmentId'),
        machineId: operand(target, 'machineId'), installationId: operand(target, 'installationId'), targetLinkId: operand(target, 'targetLinkId'),
        deploymentId: target === 'appHealth' ? ref('deploy', ['deploymentId']) : operand(target, 'deploymentId'),
        service: ref(`${id}Services`, ['services', 0, 'deployment', 'service']) }),
      success: ref => all(equal(ref(`${id}Health`, ['health']), 'healthy'), equal(ref(`${id}Health`, ['freshness']), 'current')) },
    ];
    return phases.map(phase => ({ ...phase, ...(id === 'app' ? { afterCutover: true } : {}) }));
  };
  const finish: Phase[] = [
    { id: 'verify', name: 'Verify the exact final snapshot', actionId: DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
      fields: ref => ({ ...backup(), backupOperationId: ref('backup', ['operationId']),
        snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] }, level: literal('manifestReadBack') }),
      success: ref => all(equal(ref('verify', ['kind']), 'verified'), equal(ref('verify', ['verified']), true)) },
    { id: 'prepareRestore', name: 'Prepare the destination restore', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
      fields: ref => ({ ...restore(ref), mode: literal('prepare') }), success: ref => equal(ref('prepareRestore', ['kind']), 'prepared') },
    { id: 'restore', name: 'Restore the verified final snapshot', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
      fields: ref => ({ ...restore(ref), mode: literal('confirm'), prepareOperationId: ref('prepareRestore', ['operationId']) }),
      success: ref => all(equal(ref('restore', ['kind']), 'restored'), equal(ref('restore', ['verified']), true)) },
    ...healthPhases('health', 'destination'),
    { id: 'cutover', name: 'Apply the reviewed Connect and definition change', actionId: DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
      fields: () => fields('cutover', keys(DeploymentEnvironmentUpdateInputV1Schema, reviewed?.cutover)),
      success: ref => equal(ref('cutover', ['ok']), true), afterCutover: true },
    { id: 'deploy', name: 'Deploy the app against the restored data', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
      fields: () => fields('deploy', keys(DeploymentDeployIntentInputV1Schema, reviewed?.deploy)),
      success: ref => equal(ref('deploy', ['state']), 'succeeded'), afterCutover: true },
    ...(reviewed && !reviewed.appHealth ? [] : healthPhases('appHealth', 'app')),
    ...(reviewed && !reviewed.teardown ? [] : [{ id: 'teardown', name: 'Retire only explicitly reviewed source resources',
      actionId: DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
      fields: () => fields('teardown', keys(DeploymentTeardownRequestInputV1Schema, reviewed?.teardown)),
      success: (ref: References) => equal(ref('teardown', ['state']), 'succeeded'), afterCutover: true }]),
  ];

  const sequence = (phases: readonly Phase[], depth: number, producers: Readonly<Record<string, number>>,
    tail?: (depth: number, producers: Readonly<Record<string, number>>) => WorkflowBlock[]): WorkflowBlock[] => {
    const phase = phases[0];
    if (!phase) return tail?.(depth, producers) ?? [];
    const current = { ...producers, [phase.id]: depth };
    const ref: References = (id, path = []) => result(id, path, depth === current[id]
      ? { kind: 'current' } : { kind: 'outer', levels: depth - current[id]! });
    const next = sequence(phases.slice(1), depth + 1, current, tail);
    const failed = recovery(phase.id, phase.afterCutover === true);
    return [{ kind: 'action', id: phase.id, name: phase.name, actionId: phase.actionId, input: phase.fields(ref) },
      { kind: 'if', id: `${phase.id}Succeeded`, when: next.length ? phase.success(ref) : { kind: 'not', condition: phase.success(ref) },
        then: next.length ? next : failed, otherwise: next.length ? failed : [] }];
  };
  const start: Phase[] = [...quiescence, { id: 'backup', name: 'Capture the final backup with source writes quiesced',
    actionId: DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, fields: backup, success: ref => equal(ref('backup', ['kind']), 'verified') }];
  return { version: 1, defaults: {}, inputs: [{ name: 'dataMove', valueType: 'json', required: true,
    description: 'Exact reviewed source writers, backup source, existing destination, Connect patch and resource disposition. Retains source bytes by default.' }],
    blocks: [{ kind: 'if', id: 'reviewedWriters', name: 'Use every reviewed writer slot', when: all(
      ...(writerCount > 0 ? [{ kind: 'exists' as const, value: operand('writers', writerCount - 1) }] : []),
      { kind: 'not', condition: { kind: 'exists', value: operand('writers', writerCount) } }),
      then: sequence(start, 1, {}, (depth, producers) => [{ kind: 'loop', id: 'snapshots',
      name: 'Restore only the reviewed final data source', repetition: { kind: 'items',
        items: result('backup', ['manifests'], { kind: 'outer', levels: depth - producers.backup! }),
        execution: 'sequential', failurePolicy: 'fail_stop' }, body: [{ kind: 'if', id: 'selectedSnapshot', when: {
          kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'value', path: ['sourceId'] }, right: operand('sourceId'),
        }, then: sequence(finish, depth + 2, producers), otherwise: [{ kind: 'wait', id: 'unselectedSnapshot',
          name: 'Ignore another backup source', onlyWhen: equal(literal(false), true),
          document: document('This manifest belongs to another source. It is not restored by this Move.') }] },
        // A nonselected manifest commits an empty result. If every manifest was
        // nonselected, the public starter must offer recovery rather than finish
        // successfully with the source writers still stopped.
        { kind: 'if', id: 'snapshotMissing', when: all(
          { kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'position' }, right: { kind: 'item', field: 'count' } },
          { kind: 'compare', operator: 'eq', left: { kind: 'loop_trailing_count', producer: result('selectedSnapshot').producer,
            path: [], equals: {} }, right: { kind: 'item', field: 'count' } }),
          then: recovery('snapshotMissing', false), otherwise: [] }] }]),
      otherwise: [{ kind: 'wait', id: 'writerReview', name: 'Review source writers',
        document: document('The reviewed writer slots do not match the supplied source writers. Review and save this Workflow with one quiesce/observe pair for every source writer before starting a new Run. No effects have been attempted.') }] },
      { kind: 'wait', id: 'operationRecovery', name: 'Needs decision', runWhen: 'failure',
        document: document('Inspect the exact retained child operations. Before cutover explicitly resume the reviewed source writers through machines.services.control. After acknowledged or unknown cutover, inspect the actual configuration before deciding; never blindly resume the old writer or replay an unknown restore. All source bytes remain retained.') }],
    finalOutput: result('reviewedWriters') };
}
