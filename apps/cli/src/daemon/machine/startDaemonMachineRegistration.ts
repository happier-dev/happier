import type { BootstrapMachineSyncRuntimeParams, BootstrapMachineSyncRuntimeResult } from './bootstrapMachineSyncRuntime';
import { bootstrapMachineSyncRuntime } from './bootstrapMachineSyncRuntime';
import type {
  MachineRegistrationRetryLoopHandle,
  StartMachineRegistrationRetryLoopParams,
} from './startMachineRegistrationRetryLoop';
import { startMachineRegistrationRetryLoop } from './startMachineRegistrationRetryLoop';

export type StartDaemonMachineRegistrationParams = Readonly<
  Omit<StartMachineRegistrationRetryLoopParams, 'onMachineRegistered'> & {
    bootstrapRuntime: Omit<BootstrapMachineSyncRuntimeParams, 'machineId' | 'machine'>;
    onMachineSyncRuntime: (runtime: BootstrapMachineSyncRuntimeResult) => void | Promise<void>;
  }
>;

export function startDaemonMachineRegistration(
  params: StartDaemonMachineRegistrationParams,
): MachineRegistrationRetryLoopHandle {
  const { bootstrapRuntime, onMachineSyncRuntime, ...retryLoopParams } = params;

  return startMachineRegistrationRetryLoop({
    ...retryLoopParams,
    onMachineRegistered: async ({ machineId, machine }) => {
      const machineSyncRuntime = await bootstrapMachineSyncRuntime({
        ...bootstrapRuntime,
        machineId,
        machine,
      });
      await onMachineSyncRuntime(machineSyncRuntime);
    },
  });
}
