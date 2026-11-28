import type { WorkflowActionFieldBindingV1, WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import type { WorkflowCondition, WorkflowValueReference } from '../workflowReferenceV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { DeploymentBackupRunInputV1Schema, type DeploymentBackupRunInputV1 } from '../../deployments/deploymentBackupActionsV1.js';
import { DeploymentBackupRestorePrepareInputV1Schema, type DeploymentBackupRestorePrepareInputV1,
  type DeploymentRestoreIntegrityUnavailableV1 } from '../../deployments/deploymentBackupRestoreV1.js';
import { DeploymentEnvironmentUpdateInputV1Schema, type DeploymentEnvironmentUpdateInputV1 } from '../../deployments/deploymentActionsV1.js';
import { DeploymentDeployIntentInputV1Schema, type DeploymentDeployActionInputV1 } from '../../deployments/deploymentDeployIntentV1.js';
import { DeploymentTeardownRequestInputV1Schema, type DeploymentTeardownRequestInputV1 } from '../../deployments/deploymentTeardownRequestV1.js';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
  DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
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

/** A data Move that restores on the source's own data installation reads the source backup repository with the
 * source's existing seal. Any other destination first seals that credential for its own data installation
 * (`copyRestoreSeal`), before any writer is stopped. The Move's first check consumes this one decision. */
export function isDeploymentDataMoveOnSourceMachineV1(
  input: Readonly<{ backupTarget: Pick<DeploymentBackupRunInputV1, 'machineId' | 'installationId'>;
    restoreTarget: Readonly<{ machineId: string; installationId: string }> }>,
): boolean {
  return input.restoreTarget.machineId === input.backupTarget.machineId
    && input.restoreTarget.installationId === input.backupTarget.installationId;
}

type Bindings = Record<string, WorkflowActionFieldBindingV1>;
type References = (id: string, path?: (string | number)[]) => WorkflowValueReference;
type Phase = Readonly<{ id: string; name: string; actionId: string;
  fields(ref: References): Bindings; success(ref: References): WorkflowCondition; afterCutover?: boolean;
  /** Replaces the writer recovery for a phase that runs before any writer is stopped. */
  failed?: WorkflowBlock[]; onlyWhen?: WorkflowCondition;
  /** Collect a definitive Action refusal before cutover so the source can be resumed. */
  recoverRefusal?: boolean }>;
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
    { kind: 'if', id: `${observedId}Observed`, name: 'Check source recovery', when: next.length ? running : { kind: 'not', condition: running },
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
    // The Run's admitted backup result travels with the copy: a destination on another Machine never ran it.
    source: { kind: 'object', fields: { kind: literal('repository'), origin: operand('origin'),
      snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] }, backupOperationId: ref('backup', ['operationId']),
      backup: ref('backup') } },
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
    return phases.map(phase => ({ ...phase, ...(id === 'app' ? { afterCutover: true } : { recoverRefusal: true }) }));
  };
  const prepareCutover: Phase[] = [
    { id: 'verify', recoverRefusal: true, name: 'Verify the exact final snapshot', actionId: DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
      fields: ref => ({ ...backup(), backupOperationId: ref('backup', ['operationId']),
        snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] }, level: literal('manifestReadBack') }),
      success: ref => all(equal(ref('verify', ['kind']), 'verified'), equal(ref('verify', ['verified']), true)) },
    { id: 'prepareRestore', recoverRefusal: true, name: 'Prepare the destination restore', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
      fields: ref => ({ ...restore(ref), mode: literal('prepare') }), success: ref => equal(ref('prepareRestore', ['kind']), 'prepared') },
    { id: 'restore', recoverRefusal: true, name: 'Restore the verified final snapshot', actionId: DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
      fields: ref => ({ ...restore(ref), mode: literal('confirm'), prepareOperationId: ref('prepareRestore', ['operationId']) }),
      success: ref => all(equal(ref('restore', ['kind']), 'restored'), { kind: 'any', conditions: [
        equal(ref('restore', ['verified']), true),
        equal(ref('restore', ['integrity', 'reason']), 'amcheck_extension_missing' satisfies DeploymentRestoreIntegrityUnavailableV1['reason']),
      ] }) },
    ...healthPhases('health', 'destination'),
  ];
  const cutover: Phase[] = [
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
    const failed = phase.failed ?? recovery(phase.id, phase.afterCutover === true);
    const hasResult: WorkflowCondition = { kind: 'exists', value: ref(phase.id) };
    const successful = phase.recoverRefusal ? all(hasResult, phase.success(ref)) : phase.success(ref);
    return [{ kind: 'action', id: phase.id, name: phase.name, actionId: phase.actionId, input: phase.fields(ref),
      ...(phase.onlyWhen ? { onlyWhen: phase.onlyWhen } : {}) },
      ...(phase.recoverRefusal ? [{ kind: 'if' as const, id: `${phase.id}Refused`, name: 'Recover the source after a refused Action',
        runWhen: 'failure' as const, when: { kind: 'not' as const, condition: hasResult },
        then: recovery(`${phase.id}Refused`, false), otherwise: [] }] : []),
      { kind: 'if', id: `${phase.id}Succeeded`, name: `Check the result: ${phase.name}`,
        when: next.length ? successful : { kind: 'not', condition: successful },
        then: next.length ? next : failed, otherwise: next.length ? (phase.recoverRefusal
          ? [{ kind: 'if', id: `${phase.id}ReturnedResult`, name: 'Check whether the Action returned a result',
            when: { kind: 'exists', value: result(phase.id, [], { kind: 'outer', levels: 1 }) }, then: failed, otherwise: [] }]
          : failed) : [] }];
  };
  const reviewCutover = (depth: number, producers: Readonly<Record<string, number>>): WorkflowBlock[] => [
    // The integrity decision for an unverified restore; the cutover's own approval follows as a separate step.
    { kind: 'wait', id: 'reviewCutover', name: 'Accept the restore without its integrity check',
      onlyWhen: equal(result('restore', ['verified'], { kind: 'outer', levels: depth - producers.restore! }), false),
      document: document('The backup is restored and the destination is healthy. Its integrity check was skipped because the amcheck extension isn’t installed there. Choose Continue to go ahead without that check; switching the app to the new database is a separate approval that comes next.') },
    ...sequence(cutover, depth, producers),
  ];
  const start: Phase[] = [...quiescence, { id: 'backup', name: 'Capture the final backup with source writes quiesced',
    actionId: DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, fields: backup, success: ref => equal(ref('backup', ['kind']), 'verified') }];
  // The same decision as isDeploymentDataMoveOnSourceMachineV1. Another destination Machine first needs its own
  // seal of the source backup credential, written before any writer is stopped.
  const sourceMachine = all(...(['machineId', 'installationId'] as const).map((field): WorkflowCondition => ({ kind: 'compare',
    operator: 'eq', left: operand('restoreTarget', field), right: operand('backupTarget', field) })));
  const seal: Phase = { id: 'copyRestoreSeal', onlyWhen: { kind: 'not', condition: sourceMachine }, name: 'Seal the source backup credential for the destination Machine',
    actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, fields: () => ({ serverId: input('dataMove', ['serverId']),
      environmentId: operand('origin', 'environmentId'), expectedRevision: operand('backupTarget', 'expectedRevision'),
      copyRestoreSeal: { kind: 'object', fields: { machineId: operand('restoreTarget', 'machineId'),
        installationId: operand('restoreTarget', 'installationId') } } }),
    success: ref => ({ kind: 'any', conditions: [sourceMachine, equal(ref('copyRestoreSeal', ['ok']), true)] }),
    failed: [{ kind: 'wait', id: 'copyRestoreSealRefused', name: 'Needs decision',
      document: document('The destination Machine could not receive the source backup credential, so nothing has been stopped. Inspect this step’s refusal, fix it, and start a new Move.') }] };
  const restoreAndCutover = (depth: number, producers: Readonly<Record<string, number>>): WorkflowBlock[] => [{ kind: 'loop', id: 'snapshots',
      name: 'Restore only the reviewed final data source', repetition: { kind: 'items',
        items: result('backup', ['manifests'], { kind: 'outer', levels: depth - producers.backup! }),
        execution: 'sequential', failurePolicy: 'fail_stop' }, body: [{ kind: 'if', id: 'selectedSnapshot', name: 'Select the reviewed backup source', when: {
          kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'value', path: ['sourceId'] }, right: operand('sourceId'),
        }, then: sequence(prepareCutover, depth + 2, producers, reviewCutover), otherwise: [{ kind: 'wait', id: 'unselectedSnapshot',
          name: 'Ignore another backup source', onlyWhen: equal(literal(false), true),
          document: document('This manifest belongs to another source. It is not restored by this Move.') }] },
        // A nonselected manifest commits an empty result. If every manifest was
        // nonselected, the public starter must offer recovery rather than finish
        // successfully with the source writers still stopped.
        { kind: 'if', id: 'snapshotMissing', name: 'Recover a missing final source snapshot', when: all(
          { kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'position' }, right: { kind: 'item', field: 'count' } },
          { kind: 'compare', operator: 'eq', left: { kind: 'loop_trailing_count', producer: result('selectedSnapshot').producer,
            path: [], equals: {} }, right: { kind: 'item', field: 'count' } }),
          then: recovery('snapshotMissing', false), otherwise: [] }] }];
  return { version: 1, defaults: {}, inputs: [{ name: 'dataMove', valueType: 'json', required: true,
    description: 'Exact reviewed source writers, backup source, existing destination, Connect patch and resource disposition. Retains source bytes by default.' }],
    blocks: [{ kind: 'if', id: 'reviewedWriters', name: 'Use every reviewed writer slot', when: all(
      ...(writerCount > 0 ? [{ kind: 'exists' as const, value: operand('writers', writerCount - 1) }] : []),
      { kind: 'not', condition: { kind: 'exists', value: operand('writers', writerCount) } }),
      then: sequence([seal, ...start], 1, {}, restoreAndCutover),
      otherwise: [{ kind: 'wait', id: 'writerReview', name: 'Review source writers',
        document: document('The reviewed writer slots do not match the supplied source writers. Review and save this Workflow with one quiesce/observe pair for every source writer before starting a new Run. No effects have been attempted.') }] },
      { kind: 'wait', id: 'operationRecovery', name: 'Needs decision', runWhen: 'failure',
        document: document('Inspect the exact retained child operations. Before cutover explicitly resume the reviewed source writers through machines.services.control. After acknowledged or unknown cutover, inspect the actual configuration before deciding; never blindly resume the old writer or replay an unknown restore. All source bytes remain retained.') }],
    finalOutput: result('reviewedWriters') };
}
