import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import type { SessionAccessErrorCodeV1 } from '../access/sessionAccessOperationsV1.js';

const PRE_DISPATCH_INPUT_REJECTION_CODES = [
  'permission_mode_not_granted',
  'attachment_unavailable',
] as const;
export type PreDispatchInputRejectionCodeV1 = (typeof PRE_DISPATCH_INPUT_REJECTION_CODES)[number];

export function isPreDispatchInputRejectionCodeV1(code: unknown): code is PreDispatchInputRejectionCodeV1 {
  return PRE_DISPATCH_INPUT_REJECTION_CODES.some(candidate => candidate === code);
}

/**
 * Dependency-light owner for rejection codes shared by Session input and
 * Session creation settlement. Keeping this leaf outside the full admission
 * graph prevents Action-spec imports from forming an initialization cycle.
 */
export const SESSION_INPUT_ADMISSION_REJECTION_CODES_V1 = [
  'session_input_invalid',
  'model_not_granted',
  ...PRE_DISPATCH_INPUT_REJECTION_CODES,
  'session_input_archived',
  'session_input_unauthorized',
  'session_access_forbidden' satisfies SessionAccessErrorCodeV1,
  'session_input_target_unavailable',
  'session_input_machine_binding_unavailable',
  'session_input_muted',
  'session_input_storage_unavailable',
  'session_input_target_update_required',
  'session_input_cancelled',
  'session_input_untrusted_assertion',
  'session_input_idempotency_conflict',
  'session_input_source_authority_mismatch',
  'session_input_permission_ceiling_rejected',
  'session_input_encryption_mode_mismatch',
] as const;

export const SessionInputAdmissionRejectionCodeV1Schema = lazyZodSchema(() => z.enum(
  SESSION_INPUT_ADMISSION_REJECTION_CODES_V1,
));
export type SessionInputAdmissionRejectionCodeV1 = z.infer<
  typeof SessionInputAdmissionRejectionCodeV1Schema
>;
