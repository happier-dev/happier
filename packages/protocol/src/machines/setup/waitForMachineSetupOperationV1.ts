import { ActionOperationGetV1ResponseSchema, type ActionOperationGetV2Request } from '../../actions/operations/v1.js';
import type { ActionExecuteFailure } from '../../actions/executor/types.js';
import { MachineSetupRetryV1Schema, type MachineSetupRetryV1 } from './machineSetupOperationV1.js';

/** The failed Setup operation links to the Workflow owner's exact recovery. */
export function readMachineSetupRetryV1(failure: ActionExecuteFailure | null): MachineSetupRetryV1 | null {
  const details = failure?.details;
  if (!details || typeof details !== 'object' || !('setupRetry' in details)) return null;
  const retry = MachineSetupRetryV1Schema.safeParse(details.setupRetry);
  return retry.success ? retry.data : null;
}

/** Setup's receipt acknowledges its Workflow; join its settlement or recorded uncertainty. */
export async function waitForMachineSetupOperationV1(
  operationId: string,
  observe: (request: ActionOperationGetV2Request) => Promise<unknown>,
): Promise<ActionExecuteFailure | null> {
  const settled = ActionOperationGetV1ResponseSchema.parse(await observe({ operationId, waitForTerminal: true }));
  if (settled.kind !== 'found') return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
  if (settled.operation.state === 'succeeded') return null;
  const failure = settled.operation.error;
  const code = settled.operation.observation?.code
    ?? (settled.operation.state === 'cancelled' ? 'cancelled' : 'machine_setup_child_failed');
  const details = failure?.setupRetry ? { ...failure.details, setupRetry: failure.setupRetry } : failure?.details;
  return { ok: false, errorCode: failure?.errorCode ?? code, error: failure?.error ?? code,
    ...(failure?.failureCause ? { failureCause: failure.failureCause } : {}),
    ...(details ? { details } : {}) };
}
