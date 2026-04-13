import type { BootstrapMachineSyncRuntimeParams, BootstrapMachineSyncRuntimeResult } from './bootstrapMachineSyncRuntime';
import { bootstrapMachineSyncRuntime } from './bootstrapMachineSyncRuntime';
import type { StartMachineRegistrationRetryLoopParams } from './startMachineRegistrationRetryLoop';
import { startMachineRegistrationRetryLoop } from './startMachineRegistrationRetryLoop';

export type StartDaemonMachineRegistrationParams = Readonly<
  Omit<StartMachineRegistrationRetryLoopParams, 'onMachineRegistered'> & {
    bootstrapRuntime: Omit<BootstrapMachineSyncRuntimeParams, 'machineId' | 'machine'>;
    onMachineSyncRuntime: (runtime: BootstrapMachineSyncRuntimeResult) => void;
  }
>;

export function startDaemonMachineRegistration(params: StartDaemonMachineRegistrationParams): void {
  const { bootstrapRuntime, onMachineSyncRuntime, ...retryLoopParams } = params;

  startMachineRegistrationRetryLoop({
    ...retryLoopParams,
    onMachineRegistered: async ({ machineId, machine }) => {
      const machineSyncRuntime = await bootstrapMachineSyncRuntime({
        ...bootstrapRuntime,
        machineId,
        machine,
      });
      onMachineSyncRuntime(machineSyncRuntime);
    },
  });
}
