import type { ActionOperationDomainRefV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { InteractiveSystemTaskContext } from '@happier-dev/cli-common/systemTasks/interactiveTaskKinds';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';

type SetupReference = Extract<ActionOperationDomainRefV1, { kind: 'machineSetup' }>;

/** One projection for local and elevated setup, shared by apply, remove and updates. */
export function createSetupOperationSnapshot(reference: SetupReference, plans: readonly MachineSetupEffectPlanV1[],
  publish: (update: ActionOperationOwnerUpdate) => void) {
  let attachment: SetupReference = { ...reference, ...(plans.length ? {
    steps: plans.flatMap((plan, planIndex) => plan.steps.map(step => ({ planIndex, stepId: step.id,
      label: step.review?.title ?? { key: step.id, fallback: step.id }, state: 'pending' as const }))),
  } : {}) };
  const update = (value: ActionOperationOwnerUpdate) => {
    if (value.domainRef?.kind !== 'machineSetup') { publish(value); return; }
    attachment = { ...attachment, ...value.domainRef, ...(attachment.steps ? { steps: attachment.steps } : {}) };
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
  return { update, emit };
}
