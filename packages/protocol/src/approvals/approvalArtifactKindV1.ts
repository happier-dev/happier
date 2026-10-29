import { z } from 'zod/mini';
import { ApprovalRequestV2StatusSchema } from './approvalRequestStatus.js';

/** Approval Artifact identities shared by their writers, readers, and generic content admission. */
export const APPROVAL_ARTIFACT_KINDS_V1 = Object.freeze({
  builtIn: 'approval_request.v1',
  targetAction: 'target_action_approval.v1',
  executionRunHostAction: 'execution_run_host_action_approval.v1',
} as const);

export function isApprovalArtifactKindV1(kind: unknown): boolean {
  return Object.values(APPROVAL_ARTIFACT_KINDS_V1).some((candidate) => candidate === kind);
}

/** Non-content query hints only; private header/body admission still owns decisions. */
export const ApprovalArtifactStateV1Schema = ApprovalRequestV2StatusSchema;
export type ApprovalArtifactStateV1 = z.infer<typeof ApprovalArtifactStateV1Schema>;
export const ApprovalArtifactQueryHintsV1Schema = z.strictObject({
  approvalState: z.nullable(ApprovalArtifactStateV1Schema),
  approvalSessionId: z.nullable(z.string()),
});
export type ApprovalArtifactQueryHintsV1 = z.infer<typeof ApprovalArtifactQueryHintsV1Schema>;

export function deriveApprovalArtifactQueryHintsV1(header: Readonly<Record<string, unknown>>): ApprovalArtifactQueryHintsV1 {
  if (!isApprovalArtifactKindV1(header.kind)) return { approvalState: null, approvalSessionId: null };
  const state = ApprovalArtifactStateV1Schema.safeParse(header.approvalStatus);
  return { approvalState: state.success ? state.data : null,
    approvalSessionId: typeof header.sessionId === 'string' && header.sessionId.length > 0 ? header.sessionId : null };
}
