/** Action identity leaf: schema modules and the registry share these constants. */
import type { ExternalActionExecutionAuthorizationV1 } from '../externalActionApi.js';
export const PROJECT_WORKER_COPY_INSPECT_ACTION_ID_V1 = 'projects.worker.copy.inspect';
export const PROJECT_WORKER_COPY_RETIRE_ACTION_ID_V1 = 'projects.worker.copy.retire';

export function isProjectWorkerCopyRetireActionIdV1(actionId: unknown): boolean {
  return actionId === PROJECT_WORKER_COPY_RETIRE_ACTION_ID_V1;
}

/** Approval replay retains its existing Artifact receipt; direct retirement retains its root request. */
export function readWorkspaceSyncCopyRetirementReceiptV1(binding: ExternalActionExecutionAuthorizationV1['binding']): string | null {
  if (isProjectWorkerCopyRetireActionIdV1(binding.actionId)) return binding.requestId;
  return binding.actionId === 'approval.request.decide' && binding.approvalDecisionAdmission?.decision === 'approve'
    ? binding.approvalDecisionAdmission.artifactId : null;
}

export function isProjectWorkerCopyInspectActionIdV1(actionId: unknown): boolean {
  return actionId === PROJECT_WORKER_COPY_INSPECT_ACTION_ID_V1;
}

export const PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1 = [
  'projects.service.placement.get', 'projects.service.placement.set',
] as const;

export const PROJECT_WORKER_ACTION_IDS_V1 = [
  'projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
  'machines.worker.policy.get', 'machines.worker.policy.set',
  'projects.worker.status', PROJECT_WORKER_COPY_INSPECT_ACTION_ID_V1, PROJECT_WORKER_COPY_RETIRE_ACTION_ID_V1,
  ...PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1,
] as const;
