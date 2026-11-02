import { DeploymentReceiptResultV1Schema } from '@happier-dev/protocol';
import type { SignedRootActionId } from '@happier-dev/protocol';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { isApprovalRequestCreatedResult } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import type { SessionControlExitCode } from '@/cli/output/jsonEnvelope';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

export { supportsFiniteActionOutcome } from './commandPresentationMetadata';

/** Finite mode alone distinguishes an actionable hold from failure or uncertainty. */
export function finiteActionExitCode(code: string, unexpected = false): SessionControlExitCode {
  if (code === 'approval_waiting' || code === 'approval_required') return 3;
  if (code === 'machine_unavailable') return 4;
  if (['outcome_unknown', 'action_outcome_unknown', 'outcome_uncertain', 'indeterminate'].includes(code)) return 5;
  return unexpected ? 2 : 1;
}

function refuse(code: string, details: unknown, message: string): never {
  throw Object.assign(new Error(message), { actionFailure: true, code, details });
}

/** Observe returned custody, never reconstruct a host from current placement. */
export async function readFiniteActionOperationAddress(input: unknown, result: unknown): Promise<ReturnType<typeof ActionOperationAddressV1Schema.parse> | null> {
  if (!result || typeof result !== 'object' || !('operation' in result)) return null;
  const address = ActionOperationAddressV1Schema.safeParse(result.operation);
  if (!address.success || 'actionOperationId' in result && result.actionOperationId !== address.data.operationId
    || input && typeof input === 'object' && 'serverId' in input
      && (typeof input.serverId !== 'string' || !await isServerProfileHomeIdentity(input.serverId, address.data.serverId))) return null;
  return address.data;
}

/** Present only confirmed settlement. The operation transport owns all waiting. */
export function readFiniteActionOutcome(params: Readonly<{
  actionId: SignedRootActionId;
  input: unknown;
  result: unknown;
}>): unknown {
  let data = params.result;
  if (isApprovalRequestCreatedResult(data)) {
    refuse('approval_waiting', data, 'Action is waiting for approval. Open the approval in Happier.');
  }
  if (params.actionId === 'action.operations.get') {
    const observed = ActionOperationGetV1ResponseSchema.safeParse(data);
    if (!observed.success || observed.data.kind === 'not_found') {
      refuse('outcome_unknown', { input: params.input },
        'Operation outcome is unavailable. Inspect the existing operation in Happier before retrying.');
    }
    const operation = observed.data.operation;
    const input = params.input && typeof params.input === 'object' ? params.input : {};
    if (!('operationId' in input) || operation.operationId !== input.operationId
      || 'machineId' in input && operation.scope.machineId !== input.machineId) {
      refuse('outcome_unknown', { input: params.input }, 'Operation result does not match the requested address.');
    }
    if (operation.state === 'failed') {
      refuse(operation.error!.errorCode, { operation }, operation.error!.error);
    }
    if (operation.state === 'cancelled') refuse('cancelled', { operation }, 'Operation was cancelled.');
    if (operation.state !== 'succeeded') {
      if (operation.progress?.kind === 'phase' && operation.progress.phase === 'waiting_for_approval') {
        refuse('approval_waiting', { operation }, 'Operation is waiting for approval. Open the approval in Happier.');
      }
      refuse('outcome_unknown', { operation }, 'Operation has not settled. Inspect the existing operation in Happier.');
    }
    if (isApprovalRequestCreatedResult(operation.result)) {
      refuse('approval_waiting', { operation }, 'Action is waiting for approval. Open the approval in Happier.');
    }
    if (operation.actionId !== 'deployments.deploy'
      && operation.actionId !== 'deployments.rollback' && operation.actionId !== 'deployments.promote'
      && operation.actionId !== 'deployments.teardown') return data;
    data = operation.result;
  }
  const receipt = DeploymentReceiptResultV1Schema.safeParse(data);
  if (!receipt.success) refuse('outcome_unknown', data, 'Deployment outcome is unavailable. Inspect its receipt in Happier before retrying.');
  if (!receipt.data.ok) refuse(receipt.data.error, receipt.data, receipt.data.error);
  if (!('deploymentId' in receipt.data)) {
    refuse('outcome_unknown', receipt.data, 'Deployment is pending. Inspect its operation in Happier before retrying.');
  }
  switch (receipt.data.state) {
    case 'succeeded':
    case 'running_unverified': return data;
    case 'failed': refuse('deployment_failed', receipt.data, 'Deployment failed.');
    case 'cancelled': refuse('cancelled', receipt.data, 'Deployment was cancelled.');
    default: refuse('outcome_unknown', receipt.data,
      'Deployment has no confirmed settled result. Inspect its receipt in Happier before retrying.');
  }
}
