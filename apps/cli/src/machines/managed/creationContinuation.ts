import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedCreationContinuationResult } from '@/daemon/actionOperations/actionOperationTypes';
import type { ManagedMachineExecutionOptions } from './acquire';

/** One-call host preparation captured before the canonical managed child executor. */
export const managedCreationAcquisition = Symbol('managedCreationAcquisition');
export type ManagedCreationAcquisitionOptions = Pick<ManagedMachineExecutionOptions,
  'acquisitionMode' | 'reuseIdle' | 'expectedProvisioner' | 'configuredPreset' | 'onLocalSessionPlacement' | 'runCreationContinuation' | 'sessionPresetPlacement'>
  & Partial<Pick<ManagedMachineExecutionOptions, 'requestId'>>;
export type ManagedCreationContinuationResultPort = Readonly<{
  read(): ManagedCreationContinuationResult | undefined;
  restore(result: ManagedCreationContinuationResult): void;
}>;
export type ManagedCreationAcquisitionContext = ActionExecutorContext & Readonly<{
  [managedCreationAcquisition]?: Readonly<{
    input: ReturnType<typeof ManagedAcquireInputV1Schema.parse>;
    take(context: ActionExecutorContext): ManagedCreationAcquisitionOptions;
    creationContinuationResult?: ManagedCreationContinuationResultPort;
  }>;
}>;

export function readManagedCreationContinuationResultPort(context: ActionExecutorContext):
  ManagedCreationContinuationResultPort | undefined {
  return (context as ManagedCreationAcquisitionContext)[managedCreationAcquisition]?.creationContinuationResult;
}
