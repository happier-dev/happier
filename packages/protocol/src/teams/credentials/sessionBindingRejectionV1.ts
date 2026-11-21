import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../../connect/connectedServiceUxDiagnostics.js';

export const SessionTeamCredentialBindingRejectionV1Schema = lazyZodSchema(() => z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  'invalid_input',
  'feature_disabled',
  'session_missing',
  'session_owner_mismatch',
  'resource_missing',
  'resource_changed',
  'access_removed',
  'disabled',
  'resource_corrupt',
  'source_owner_required',
  'source_replaced_or_missing',
  'team_context_required',
  'team_visibility_required',
  'broker_unavailable',
  'update_required',
  'authentication_required',
  'authentication_unavailable',
]));
export type SessionTeamCredentialBindingRejectionV1 = z.infer<
  typeof SessionTeamCredentialBindingRejectionV1Schema
>;

export const SessionTeamCredentialBindingMutationRejectionV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('session_team_credential_binding_rejected'),
  reason: SessionTeamCredentialBindingRejectionV1Schema,
}));
