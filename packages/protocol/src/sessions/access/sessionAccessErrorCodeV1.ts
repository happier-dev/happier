import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * The typed reason one desired assignment is refused. It deliberately does not
 * distinguish an absent Account, an inactive Account and an Account without
 * current read access, so the mutation cannot be used to enumerate identities
 * or access sources.
 */
export const SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1 =
  'session_responsibility_assignee_unavailable' as const;

/** Canonical keyset-decoder rejection for candidate continuation. */
export const SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1 =
  'invalid_cursor' as const;

export const SessionAccessErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'session_access_forbidden', 'session_access_session_not_found',
  'session_access_subject_not_found', 'session_access_subject_ineligible',
  'session_access_owner_grant_invalid', 'session_access_self_grant_invalid',
  'session_access_permission_delegation_forbidden', 'session_access_permission_delegation_requires_edit',
  'session_access_team_policy_required',
  'session_initial_access_creator_mismatch',
  'session_access_authentication_required',
  'session_access_authentication_unavailable',
  'session_access_external_sharing_requires_team_admin',
  'session_access_external_sharing_disabled',
  // The exact Home's `sharing.session` decision is not enabled, so it serves no
  // access-bearing operation. A Home configuration answer, never an update requirement.
  'session_access_sharing_unavailable',
  'session_access_invalid_recipient_envelope',
  SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1,
  SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1,
  'invalid_request', 'data_key_not_required',
  'recipient_envelope_required', 'recipient_key_unavailable',
]));
export type SessionAccessErrorCodeV1 = z.infer<typeof SessionAccessErrorCodeV1Schema>;
