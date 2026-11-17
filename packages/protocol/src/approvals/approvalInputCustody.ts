import { z } from '../zodRuntimePolicy.js';
import { isApprovalRequestV2TerminalStatus } from './approvalRequestStatus.js';

/** The original operands stay with the live invocation and are erased at settlement. */
export const ApprovalInputCustodySchema = z.literal('live_only');
export type ApprovalInputCustody = z.infer<typeof ApprovalInputCustodySchema>;

/** The receipt writer and opaque storage transport share the same settlement fact. */
export function readSettledApprovalInputCustodyV1(request: Readonly<{
  approvalInputCustody?: ApprovalInputCustody; status: unknown;
}>): ApprovalInputCustody | undefined {
  return isApprovalRequestV2TerminalStatus(request.status) ? request.approvalInputCustody : undefined;
}
