import { runElevatedAdminAccessTransition, type MachineElevationDependencies,
    type RunElevatedAdminAccessTransitionInput } from './runElevatedEffect';

export type MachineAdminAccessReconcileInput = RunElevatedAdminAccessTransitionInput;

/** Observation/publication and desired-policy CAS remain with the caller. */
export function createMachineAdminAccessHost(dependencies: Omit<MachineElevationDependencies, 'verifyCurrent'>) {
    return {
        async inspect() { return { observation: await dependencies.observe(), checkedAt: Date.now() }; },
        reconcile: (input: MachineAdminAccessReconcileInput) => runElevatedAdminAccessTransition(input, dependencies),
    };
}
