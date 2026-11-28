import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { InteractiveSystemTaskContext } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import type { MachineSetupScriptV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineSetupReviewedStepV1 } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';

type SetupReference = Extract<ActionOperationDomainRefV1, { kind: 'machineSetup' }>;

export function machineSetupScriptStepId(index: number): string { return `script:${index}`; }

type SetupStep = MachineSetupEffectPlanV1['steps'][number];

/**
 * What a step without a reviewed title changes, in words: the run's checklist names steps the person can recognise
 * ("Install ripgrep"), never a recipe's internal step id ("package-apt").
 */
function describeUntitledSetupStep(step: SetupStep): string {
  switch (step.kind) {
    case 'package': return `${step.state === 'absent' ? 'Remove' : 'Install'} ${step.packages.map(pkg => pkg.name).join(', ')}`;
    case 'packageHold': return step.operation === 'hold' ? `Hold updates to ${step.name}` : `Release the hold on ${step.name}`;
    case 'packageSource': return `Add the ${step.manager} package source`;
    case 'serviceUnit': return `${step.running ? 'Start' : 'Stop'} ${step.unit}`;
    case 'firewall': return 'Firewall rules';
    case 'reboot': return 'Restart the machine';
    case 'user': return `User ${step.username}`;
    case 'group': return `Group ${step.name}`;
    case 'directory': return `Folder ${step.path}`;
    case 'file': return `File ${step.path}`;
    case 'workspaceAccess': case 'pathTraversal': return `Access to ${step.path}`;
    case 'command': return `Run ${step.executable}`;
    case 'script': return 'Run a script';
  }
}

export function projectMachineSetupReviewedSteps(plans: readonly MachineSetupEffectPlanV1[],
  scripts: readonly MachineSetupScriptV1[]): MachineSetupReviewedStepV1[] {
  return [
    ...plans.flatMap((plan, planIndex) => plan.steps.map(step => ({ planIndex, stepId: step.id,
      label: step.review?.title ?? { key: step.id, fallback: describeUntitledSetupStep(step) } }))),
    ...scripts.flatMap((script, index) => script.body ? [{ planIndex: plans.length, stepId: machineSetupScriptStepId(index),
      label: { key: 'machinePresets.setup.scriptNumbered', fallback: 'Script {index}', params: { index: index + 1 } } }] : []),
  ];
}

/** One projection for local and elevated setup, shared by apply, remove and updates. */
export function createSetupOperationSnapshot(reference: SetupReference, plans: readonly MachineSetupEffectPlanV1[],
  publish: (update: ActionOperationOwnerUpdate) => void, scripts: readonly MachineSetupScriptV1[] = []) {
  const initialSteps: NonNullable<SetupReference['steps']> = projectMachineSetupReviewedSteps(plans, scripts)
    .map(step => ({ ...step, state: 'pending' }));
  let attachment: SetupReference = { ...reference, ...(initialSteps.length ? {
    steps: initialSteps,
  } : {}) };
  const update = (value: ActionOperationOwnerUpdate) => {
    if (value.domainRef?.kind !== 'machineSetup') { publish(value); return; }
    const terminalId = value.domainRef.terminalId;
    const steps = terminalId ? attachment.steps?.map(step => step.planIndex === plans.length && step.state === 'running'
      ? { ...step, terminalId } : step) : attachment.steps;
    attachment = { ...attachment, ...value.domainRef, ...(steps ? { steps } : {}) };
    publish({ ...value, domainRef: attachment });
  };
  update({ domainRef: attachment });
  const emit: InteractiveSystemTaskContext['emit'] = event => {
    if (!attachment.steps || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const data = event.data as Readonly<Record<string, unknown>>;
    let steps = attachment.steps;
    if (event.type === 'machine.setup.progress') {
      steps = steps.map(step => {
        if (step.planIndex !== data.planIndex || step.stepId !== event.stepId) return step;
        const state: NonNullable<SetupReference['steps']>[number]['state'] = data.status === 'started' ? 'running' : data.status === 'satisfied' ? 'succeeded'
          : data.phase === 'verify' || data.status === 'unsupported' || data.status === 'unavailable' ? 'failed' : 'pending';
        const failureCause = state === 'failed' && typeof data.reason === 'string' ? data.reason : undefined;
        const { failureCause: _previousCause, ...retained } = step;
        return { ...retained, state, ...(failureCause ? { failureCause } : {}) };
      });
    } else if (event.type === 'machine.setup.result' && data.status !== 'applied') {
      // Native execution can fail during a started check or apply before emitting
      // its observation. The running row disambiguates repeated ids across plans.
      steps = steps.map(step => step.state === 'running' && step.stepId === data.stepId
        ? { ...step, state: data.status === 'cancelled' ? 'cancelled' : 'failed',
          ...(typeof data.reason === 'string' ? { failureCause: data.reason } : {}) } : step);
    } else return;
    attachment = { ...attachment, steps };
    // The operation store owns equality and suppresses unchanged publications.
    publish({ domainRef: attachment });
  };
  const settle = (result: ActionExecuteResult) => {
    if (result.ok || !attachment.steps?.some(step => step.state === 'running')) return;
    const state: NonNullable<SetupReference['steps']>[number]['state'] = result.errorCode === 'cancelled' ? 'cancelled' : 'failed';
    attachment = { ...attachment, steps: attachment.steps.map(step => step.state === 'running'
      ? { ...step, state,
        ...(result.errorCode ? { failureCause: result.errorCode } : {}) } : step) };
    publish({ domainRef: attachment });
  };
  return { update, emit, settle };
}
