import type {
  ExecutionRunConnectedServicesCleanupReceiptV1,
  ExecutionRunConnectedServicesLaunchV1,
} from '@happier-dev/protocol';

export function buildExecutionRunConnectedServicesCleanupReceipt(
  registration: ExecutionRunConnectedServicesLaunchV1 | null | undefined,
): ExecutionRunConnectedServicesCleanupReceiptV1 | null {
  if (!registration?.activationId) return null;
  return {
    v: 1,
    activationId: registration.activationId,
    runKey: registration.runKey,
    agentId: registration.agentId,
  };
}
