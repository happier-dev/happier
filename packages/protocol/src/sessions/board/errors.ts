import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import type { FeatureDecision } from '../../features/decision.js';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import type { SessionBoardActionIdV1 } from './actionIds.js';

export const SessionBoardErrorCodeSchema = lazyZodSchema(() => z.enum([
  'session_board_invalid',
  'session_board_item_not_found',
  'session_board_forbidden',
  'session_board_storage_mode_mismatch',
  'session_board_source_conflict',
  'session_board_revision_conflict',
]));
export type SessionBoardErrorCode = z.infer<typeof SessionBoardErrorCodeSchema>;
export const SessionBoardErrorV1Schema = lazyZodSchema(() => z.discriminatedUnion('error', [
  z.object({ error: z.literal('session_board_invalid') }).strict(),
  z.object({ error: z.literal('session_board_item_not_found') }).strict(),
  z.object({ error: z.literal('session_board_forbidden') }).strict(),
  z.object({ error: z.literal('session_board_storage_mode_mismatch') }).strict(),
  z.object({ error: z.literal('session_board_source_conflict') }).strict(),
  z.object({
    error: z.literal('session_board_revision_conflict'),
    currentItemRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
    currentLayoutRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
  }).strict(),
]));
export type SessionBoardErrorV1 = z.infer<typeof SessionBoardErrorV1Schema>;

/** The incumbent server feature-admission response for a hidden Board route. */
export const SessionBoardFeatureGateErrorV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('not_found'),
}).strict());

export type SessionBoardFeatureDecisionActionFailureV1 =
  | Readonly<{
      ok: false;
      errorCode: 'feature_disabled' | 'feature_unavailable';
      error: 'feature_disabled' | 'feature_unavailable';
      details: Readonly<{
        operation: SessionBoardActionIdV1;
        featureDecision?: FeatureDecision;
      }>;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'update_required';
      error: 'update_required';
      details: z.infer<typeof OperationUpdateRequiredV1Schema>;
    }>;

/**
 * Preserve the canonical feature decision instead of collapsing every
 * pre-dispatch refusal to unsupported_action. An older Home gets the shared
 * operation update contract; a known disabled feature and an unavailable
 * decision remain distinguishable and cannot be mistaken for an issued write.
 */
export function projectSessionBoardFeatureDecisionFailureV1(
  actionId: SessionBoardActionIdV1,
  decision: FeatureDecision | null,
): SessionBoardFeatureDecisionActionFailureV1 {
  if (decision?.state === 'unsupported') {
    return {
      ok: false,
      errorCode: 'update_required',
      error: 'update_required',
      details: OperationUpdateRequiredV1Schema.parse({
        kind: 'update_required',
        operation: actionId,
        component: 'server',
        reason: `sessions_board_${decision.blockerCode}`,
      }),
    };
  }
  const errorCode = decision?.state === 'disabled' ? 'feature_disabled' : 'feature_unavailable';
  return {
    ok: false,
    errorCode,
    error: errorCode,
    details: { operation: actionId, ...(decision ? { featureDecision: decision } : {}) },
  };
}

/** Project a definite route-level Board gate refusal without claiming an unknown write outcome. */
export function projectSessionBoardFeatureGateFailureV1(
  actionId: SessionBoardActionIdV1,
): Readonly<{
  ok: false;
  errorCode: 'feature_disabled';
  error: 'feature_disabled';
  details: Readonly<{ operation: SessionBoardActionIdV1 }>;
}> {
  return {
    ok: false,
    errorCode: 'feature_disabled',
    error: 'feature_disabled',
    details: { operation: actionId },
  };
}
