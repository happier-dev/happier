import { internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
export { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1, internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1 } from '@happier-dev/triage-protocol/v1';

export const INTERNAL_TASK_SOURCE_LABEL_V1 = 'Happier tasks';

/** Ordering is private Account data, regardless of shared-task edit access. */
export function isPersonalTaskReferenceV1(ref: TriageEntryRefV1, viewerAccountId?: string): boolean {
  return isInternalTaskReferenceV1(ref) && (ref.collisionScope === 'personal'
    || viewerAccountId !== undefined && internalTaskOwnerAccountIdV1(ref, viewerAccountId) === viewerAccountId);
}
