import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionApprovalRequestCreatedResult,
} from '@happier-dev/protocol/actions';

/** Narrow a raw Action result to the canonical policy-deferral result. */
export function isHappierActionApprovalRequestCreated(
  value: unknown,
): value is ActionApprovalRequestCreatedResult {
  return ActionApprovalRequestCreatedResultSchema.safeParse(value).success;
}
