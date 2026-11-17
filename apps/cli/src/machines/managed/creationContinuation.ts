import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedWorkflowContinuationResult } from '@/daemon/actionOperations/actionOperationTypes';
import type { ManagedMachineExecutionOptions } from './acquire';

/** One-call host preparation captured before the canonical managed child executor. */
export const managedCreationAcquisition = Symbol('managedCreationAcquisition');
export type ManagedCreationAcquisitionOptions = Pick<ManagedMachineExecutionOptions,
  'acquisitionMode' | 'reuseIdle' | 'expectedProvisioner' | 'onLocalSessionPlacement' | 'runCreationContinuation'>
  & Partial<Pick<ManagedMachineExecutionOptions, 'requestId'>>;
export type ManagedWorkflowContinuationResultPort = Readonly<{
  read(): ManagedWorkflowContinuationResult | undefined;
  restore(result: ManagedWorkflowContinuationResult): void;
}>;
export type ManagedCreationAcquisitionContext = ActionExecutorContext & Readonly<{
  [managedCreationAcquisition]?: Readonly<{
    input: ReturnType<typeof ManagedAcquireInputV1Schema.parse>;
    take(context: ActionExecutorContext): ManagedCreationAcquisitionOptions;
    workflowContinuationResult?: ManagedWorkflowContinuationResultPort;
  }>;
}>;

export function readManagedWorkflowContinuationResultPort(context: ActionExecutorContext):
  ManagedWorkflowContinuationResultPort | undefined {
  return (context as ManagedCreationAcquisitionContext)[managedCreationAcquisition]?.workflowContinuationResult;
}
