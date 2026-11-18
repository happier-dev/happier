import type { ActionOperationProgressStepV1 } from '@happier-dev/protocol/actions/operations/v1';

export type ManagedMachinePresetPreparationProgressV1 = Readonly<{
  phase: string; label: string; steps: readonly ActionOperationProgressStepV1[];
}>;

/** Invocation-local display facts, published through the incumbent Action run. */
export function createPresetPreparationProgress(
  publish: ((progress: ManagedMachinePresetPreparationProgressV1) => void) | undefined,
) {
  const steps: ActionOperationProgressStepV1[] = [
    { id: 'prepare-inputs', label: 'Prepare build inputs', state: 'pending' },
    { id: 'build-image', label: 'Build prepared image', state: 'pending' },
    { id: 'save-image', label: 'Save prepared image', state: 'pending' },
  ];
  let current = -1;
  const emit = () => {
    if (current >= 0) publish?.({ phase: steps[current]!.id, label: steps[current]!.label, steps: steps.slice() });
  };
  return {
    start(id: 'prepare-inputs' | 'build-image' | 'save-image') {
      const next = steps.findIndex(step => step.id === id);
      if (next === current) return;
      const now = Date.now();
      if (next < current) {
        for (let index = next; index < steps.length; index++) {
          const { id, label } = steps[index]!;
          steps[index] = { id, label, state: 'pending' };
        }
      }
      // Recovery after persisted composition knows the input step finished, but
      // does not invent its missing start/end times.
      for (let index = 0; index < next; index++) {
        const step = steps[index]!;
        if (step.state === 'pending' || step.state === 'running') steps[index] = { ...step, state: 'succeeded',
          ...(step.startedAt === undefined ? {} : { settledAt: now }) };
      }
      current = next;
      steps[next] = { ...steps[next]!, state: 'running', startedAt: now };
      emit();
    },
    finish(state: 'succeeded' | 'failed' | 'cancelled') {
      if (current < 0 || steps[current]!.state !== 'running') return;
      steps[current] = { ...steps[current]!, state, settledAt: Date.now() };
      emit();
    },
  };
}
