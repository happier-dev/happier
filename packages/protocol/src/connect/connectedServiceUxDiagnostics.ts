import { z } from 'zod';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from './connectedServiceSchemas.js';

export const CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES = {
  providerSessionStateUnavailableForResume: 'provider_session_state_unavailable_for_resume',
  connectedServiceMaterializationIdentityMissing: 'connected_service_materialization_identity_missing',
  resumeReachabilityInputsMissing: 'resume_reachability_inputs_missing',
  metadataUpdateFailed: 'metadata_update_failed',
  noEligibleGroupMember: 'no_eligible_group_member',
  recoveryRetryScheduled: 'recovery_retry_scheduled',
  recoveryDeadLettered: 'recovery_dead_lettered',
  providerAccountAdoptionMismatch: 'provider_account_adoption_mismatch',
  postSwitchVerificationFailed: 'post_switch_verification_failed',
  connectedServiceCredentialReconnectRequired: 'connected_service_credential_reconnect_required',
  claudeSubscriptionMissingClaudeCodeScope: 'claude_subscription_missing_claude_code_scope',
  claudeSubscriptionNativeAuthMaterializationFailed: 'claude_subscription_native_auth_materialization_failed',
  claudeSubscriptionSetupTokenNotSupportedForUnified: 'claude_subscription_setup_token_not_supported_for_unified',
} as const;

export const ConnectedServiceUxDiagnosticCodeV1Schema = z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified,
]);

export type ConnectedServiceUxDiagnosticCodeV1 = z.infer<typeof ConnectedServiceUxDiagnosticCodeV1Schema>;

export const ConnectedServiceUxDiagnosticFailurePhaseV1Schema = z.enum([
  'session_lookup',
  'agent_validation',
  'normalization',
  'continuity',
  'materialization',
  'metadata',
  'restart',
  'hot_apply',
  'rollback',
  'post_switch_recovery',
  'post_switch_verification',
  'runtime_auth_recovery',
]);

export type ConnectedServiceUxDiagnosticFailurePhaseV1 =
  z.infer<typeof ConnectedServiceUxDiagnosticFailurePhaseV1Schema>;

export const ConnectedServiceUxDiagnosticSourceV1Schema = z.enum([
  'spawn_resume',
  'new_session',
  'inactive_resume',
  'manual_auth_switch',
  'runtime_auth_recovery',
  'usage_limit_recovery',
  'transcript_switch_attempt',
  'session_view',
]);

export type ConnectedServiceUxDiagnosticSourceV1 =
  z.infer<typeof ConnectedServiceUxDiagnosticSourceV1Schema>;

export const CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS = {
  retry: 'retry',
  startFreshUnderSelectedAccount: 'start_fresh_under_selected_account',
  resumeCurrentAccount: 'resume_current_account',
  openConnectedAccounts: 'open_connected_accounts',
  reconnectProfile: 'reconnect_profile',
  enableStateSharing: 'enable_state_sharing',
  viewLatestFork: 'view_latest_fork',
  viewNativeFork: 'view_native_fork',
  dismiss: 'dismiss',
} as const;

export const ConnectedServiceUxDiagnosticSuggestedActionV1Schema = z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewLatestFork,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewNativeFork,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
]);

export type ConnectedServiceUxDiagnosticSuggestedActionV1 =
  z.infer<typeof ConnectedServiceUxDiagnosticSuggestedActionV1Schema>;

export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS = 16;
export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEY_LENGTH = 64;
export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_STRING_LENGTH = 512;

const CONNECTED_SERVICE_UX_DIAGNOSTIC_SENSITIVE_KEY_PATTERN =
  /(?:^token$|[a-z0-9_-]+[_-]?token$|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|bearer|secret|credential|password|private[_-]?key|api[_-]?key)/i;

const ConnectedServiceUxDiagnosticKeyV1Schema = z
  .string()
  .trim()
  .min(1)
  .max(CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEY_LENGTH)
  .refine(
    (key) => !CONNECTED_SERVICE_UX_DIAGNOSTIC_SENSITIVE_KEY_PATTERN.test(key),
    'diagnostic keys must not identify secrets or tokens',
  );

const ConnectedServiceUxDiagnosticScalarV1Schema = z.union([
  z.string().max(CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const ConnectedServiceUxDiagnosticDiagnosticsV1Schema = z
  .record(ConnectedServiceUxDiagnosticKeyV1Schema, ConnectedServiceUxDiagnosticScalarV1Schema)
  .refine(
    (diagnostics) => Object.keys(diagnostics).length <= CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS,
    `diagnostics must include at most ${CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS} keys`,
  );

export const ConnectedServiceUxDiagnosticV1Schema = z.object({
  code: ConnectedServiceUxDiagnosticCodeV1Schema,
  failurePhase: ConnectedServiceUxDiagnosticFailurePhaseV1Schema,
  source: ConnectedServiceUxDiagnosticSourceV1Schema,
  serviceId: ConnectedServiceIdSchema.optional(),
  providerId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  profileId: ConnectedServiceProfileIdSchema.optional(),
  groupId: ConnectedServiceAuthGroupIdSchema.optional(),
  retryable: z.boolean(),
  suggestedActions: z.array(ConnectedServiceUxDiagnosticSuggestedActionV1Schema).default([]),
  diagnostics: ConnectedServiceUxDiagnosticDiagnosticsV1Schema.optional(),
}).strict();

export type ConnectedServiceUxDiagnosticV1 = z.infer<typeof ConnectedServiceUxDiagnosticV1Schema>;

export function normalizeConnectedServiceUxDiagnosticV1(
  value: unknown,
): ConnectedServiceUxDiagnosticV1 | null {
  const parsed = ConnectedServiceUxDiagnosticV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isConnectedServiceUxDiagnosticV1(value: unknown): value is ConnectedServiceUxDiagnosticV1 {
  return normalizeConnectedServiceUxDiagnosticV1(value) !== null
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as { suggestedActions?: unknown }).suggestedActions);
}
