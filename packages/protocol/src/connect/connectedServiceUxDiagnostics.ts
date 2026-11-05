import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ConnectedAccountCatalogUnavailableReasonV1Schema } from './connectedAccountCatalogV1.js';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
} from './connectedServiceSchemas.js';
import { ConnectedAccountServiceKeyIngressSchema } from './connectedServiceBindings.js';
import {
  isBaseCredentialDiagnosticKey,
  splitSensitiveDiagnosticKeySegments,
} from '../common/sensitiveKeys.js';

/** Content-free provenance for a refusal before any pool/model is admitted. */
export const ConnectedServicesDefaultUnavailableDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  source: z.literal('account_default'),
  reason: z.enum(['connected_services_default_settings_invalid', 'connected_account_purpose_catalog_unavailable']),
  phase: z.literal('purpose_binding'),
  catalogReason: z.optional(ConnectedAccountCatalogUnavailableReasonV1Schema),
}));

export type ConnectedServicesDefaultUnavailableDetailsV1 = z.infer<typeof ConnectedServicesDefaultUnavailableDetailsV1Schema>;

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
  connectedServiceCredentialRefreshUnavailable: 'connected_service_credential_refresh_unavailable',
  claudeSubscriptionMissingClaudeCodeScope: 'claude_subscription_missing_claude_code_scope',
  claudeSubscriptionNativeAuthMaterializationFailed: 'claude_subscription_native_auth_materialization_failed',
  claudeSubscriptionSetupTokenNotSupportedForUnified: 'claude_subscription_setup_token_not_supported_for_unified',
} as const;

export const ConnectedServiceUxDiagnosticCodeV1Schema = lazyZodSchema(() => z.enum([
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
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified,
]));

export type ConnectedServiceUxDiagnosticCodeV1 = z.infer<typeof ConnectedServiceUxDiagnosticCodeV1Schema>;

export const ConnectedServiceUxDiagnosticFailurePhaseV1Schema = lazyZodSchema(() => z.enum([
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
]));

export type ConnectedServiceUxDiagnosticFailurePhaseV1 =
  z.infer<typeof ConnectedServiceUxDiagnosticFailurePhaseV1Schema>;

export const ConnectedServiceUxDiagnosticSourceV1Schema = lazyZodSchema(() => z.enum([
  'spawn_resume',
  'new_session',
  'inactive_resume',
  'manual_auth_switch',
  'runtime_auth_recovery',
  'usage_limit_recovery',
  'transcript_switch_attempt',
  'session_view',
]));

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

export const ConnectedServiceUxDiagnosticSuggestedActionV1Schema = lazyZodSchema(() => z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewLatestFork,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewNativeFork,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
]));

export type ConnectedServiceUxDiagnosticSuggestedActionV1 =
  z.infer<typeof ConnectedServiceUxDiagnosticSuggestedActionV1Schema>;

export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS = 16;
export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEY_LENGTH = 64;
export const CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_STRING_LENGTH = 512;

const CONNECTED_SERVICE_UX_DIAGNOSTIC_CREDENTIAL_SUFFIXES = new Set([
  'auth',
  'authentication',
  'bearer',
  'credential',
  'credentials',
  'secret',
  'token',
]);

function isConnectedServiceUxDiagnosticCredentialKey(key: string): boolean {
  if (isBaseCredentialDiagnosticKey(key)) return true;
  const segments = splitSensitiveDiagnosticKeySegments(key);
  return CONNECTED_SERVICE_UX_DIAGNOSTIC_CREDENTIAL_SUFFIXES.has(segments.at(-1) ?? '');
}

const ConnectedServiceUxDiagnosticKeyV1Schema = lazyZodSchema(() => z
  .string().check(z.trim(), z.minLength(1), z.maxLength(CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEY_LENGTH), z.refine((key) => !isConnectedServiceUxDiagnosticCredentialKey(key), 'diagnostic keys must not identify secrets or tokens')));

const ConnectedServiceUxDiagnosticScalarV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.maxLength(CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_STRING_LENGTH)),
  z.number(),
  z.boolean(),
  z.null(),
]));

export const ConnectedServiceCredentialReconnectCauseV1Schema = lazyZodSchema(() => z.enum([
  'credential_missing',
  'listed_needs_reauth',
  'stored_health_rejected',
]));
export type ConnectedServiceCredentialReconnectCauseV1 = z.infer<typeof ConnectedServiceCredentialReconnectCauseV1Schema>;

const ConnectedServiceUxDiagnosticDiagnosticsV1Schema = lazyZodSchema(() => z.pipe(
  z.record(ConnectedServiceUxDiagnosticKeyV1Schema, ConnectedServiceUxDiagnosticScalarV1Schema).check(z.refine((diagnostics) => Object.keys(diagnostics).length <= CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS, `diagnostics must include at most ${CONNECTED_SERVICE_UX_DIAGNOSTIC_MAX_DIAGNOSTIC_KEYS} keys`)),
  z.catchall(
    z.object({ reconnectCause: z.optional(ConnectedServiceCredentialReconnectCauseV1Schema) }),
    ConnectedServiceUxDiagnosticScalarV1Schema,
  ),
));

// R.17 classification (2026-07-10): the former `providerId` field carried
// `ConnectedServiceStateSharingDescriptor.providerId` values, which are typed
// `CatalogAgentId` (agent-meaning, e.g. 'codex') — NOT connected-service ids
// (those travel in `serviceId`). It was merged into `agentId`; legacy persisted
// diagnostics are normalized below.
const ConnectedServiceUxDiagnosticV1ObjectSchema = lazyZodSchema(() => z.strictObject({
  code: ConnectedServiceUxDiagnosticCodeV1Schema,
  failurePhase: ConnectedServiceUxDiagnosticFailurePhaseV1Schema,
  source: ConnectedServiceUxDiagnosticSourceV1Schema,
  serviceId: z.optional(ConnectedAccountServiceKeyIngressSchema),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  profileId: z.optional(ConnectedServiceProfileIdSchema),
  groupId: z.optional(ConnectedServiceAuthGroupIdSchema),
  retryable: z.boolean(),
  suggestedActions: z._default(z.array(ConnectedServiceUxDiagnosticSuggestedActionV1Schema), []),
  diagnostics: z.optional(ConnectedServiceUxDiagnosticDiagnosticsV1Schema),
}));

// legacy `providerId` read-compat (pre-rename persisted diagnostics in transcripts)
function normalizeLegacyConnectedServiceUxDiagnosticAgentId(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, 'providerId')) return value;
  const { providerId: legacyProviderId, ...rest } = record;
  if (Object.hasOwn(record, 'agentId')) return rest;
  return typeof legacyProviderId === 'string' && legacyProviderId.trim()
    ? { ...rest, agentId: legacyProviderId }
    : rest;
}

export const ConnectedServiceUxDiagnosticV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyConnectedServiceUxDiagnosticAgentId), ConnectedServiceUxDiagnosticV1ObjectSchema));

export type ConnectedServiceUxDiagnosticV1 = z.infer<typeof ConnectedServiceUxDiagnosticV1ObjectSchema>;

/** Read the owner's diagnostic from a local error or its transport envelope. */
export function readConnectedServiceUxDiagnosticFromError(error: unknown): ConnectedServiceUxDiagnosticV1 | null {
  if (!error || typeof error !== 'object') return null;
  const carrier = error as Readonly<Record<string, unknown>>;
  const details = carrier.details && typeof carrier.details === 'object'
    ? carrier.details as Readonly<Record<string, unknown>> : null;
  const errorDetail = carrier.errorDetail && typeof carrier.errorDetail === 'object'
    ? carrier.errorDetail as Readonly<Record<string, unknown>> : null;
  return normalizeConnectedServiceUxDiagnosticV1(carrier.uxDiagnostic ?? details?.uxDiagnostic ?? errorDetail?.uxDiagnostic);
}

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
