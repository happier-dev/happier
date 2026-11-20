import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
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

/**
 * "Allow for this Session" rows: one person-authored record per Session. It is not an approval
 * request, but it is bound to its Session by the same server-gated `approvalSessionId` column.
 */
export const SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 = 'approval_session_consents.v1';

/** Kinds whose writers send the Session binding hint; the server admits it only for its owner. */
export function artifactKindCarriesApprovalSessionHintV1(kind: unknown): boolean {
  return kind === SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 || isApprovalArtifactKindV1(kind);
}

/** Non-content query hints only; private header/body admission still owns decisions. */
export const ApprovalArtifactStateV1Schema = lazyZodSchema(() => ApprovalRequestV2StatusSchema);
export type ApprovalArtifactStateV1 = z.infer<typeof ApprovalArtifactStateV1Schema>;
export const ApprovalArtifactQueryHintsV1Schema = z.strictObject({
  approvalState: z.nullable(ApprovalArtifactStateV1Schema),
  approvalSessionId: z.nullable(z.string()),
});
export type ApprovalArtifactQueryHintsV1 = z.infer<typeof ApprovalArtifactQueryHintsV1Schema>;

export function deriveApprovalArtifactQueryHintsV1(header: Readonly<Record<string, unknown>>): ApprovalArtifactQueryHintsV1 {
  if (header.kind === SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1) return { approvalState: null,
    approvalSessionId: typeof header.sessionId === 'string' && header.sessionId.length > 0 ? header.sessionId : null };
  if (!isApprovalArtifactKindV1(header.kind)) return { approvalState: null, approvalSessionId: null };
  const state = ApprovalArtifactStateV1Schema.safeParse(header.approvalStatus);
  return { approvalState: state.success ? state.data : null,
    approvalSessionId: typeof header.sessionId === 'string' && header.sessionId.length > 0 ? header.sessionId : null };
}
