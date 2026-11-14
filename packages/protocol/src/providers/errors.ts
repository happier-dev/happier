import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ProviderConnectionIdSchema, ProviderMachineIdSchema } from './ids.js';
import { ProfileRecordIdV1Schema } from '../profiles/v2/profileId.js';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../connect/connectedServiceUxDiagnostics.js';
import { ActionFailureCauseV1Schema, parseActionExecuteFailure, projectActionFailureCauseV1, type ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';
import {
  SavedSecretOperationAdmissionFailureReasonV1Schema,
  type SavedSecretOperationAdmissionFailureReasonV1,
} from '../account/settings/savedSecretReferenceV1.js';

export const ProviderErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  'model_not_granted', 'model_selection_required', 'permission_mode_not_granted',
  'provider_feature_disabled', 'provider_connection_not_found', 'provider_connection_changed', 'provider_contribution_unavailable', 'provider_connection_disabled',
  'provider_account_grant_stale', 'provider_account_scope_required', 'provider_not_enabled_on_machine', 'provider_machine_grant_stale',
  'provider_incompatible_with_agent', 'provider_compatibility_unverified', 'provider_secret_missing', 'provider_secret_unavailable',
  'provider_credential_transport_unavailable', 'provider_run_credential_selection_required', 'provider_endpoint_unreachable', 'provider_endpoint_unavailable',
  'provider_machine_unavailable',
  'machine_offline', 'agent_unavailable', 'agent_timeout', 'agent_error',
  'provider_probe_capacity_exhausted',
  'provider_catalog_unavailable', 'provider_rpc_response_invalid', 'provider_rpc_mutation_outcome_unknown',
  'provider_endpoint_rate_limited', 'provider_endpoint_auth_required', 'provider_endpoint_unauthorized',
  'provider_probe_response_invalid', 'provider_model_not_found', 'provider_model_unloaded',
  'provider_model_config_option_unsupported',
  'provider_authorization_changed', 'provider_binding_changed', 'provider_switch_unsupported',
  'provider_agent_runtime_unsupported', 'provider_managed_requires_daemon', 'provider_materialization_failed',
  'provider_probe_authorization_invalid', 'provider_settings_limit_exceeded',
  'provider_settings_invalid', 'provider_connection_invalid',
  'provider_profile_migration_source_changed', 'provider_profile_migration_source_not_found',
  'provider_profile_migration_conflict',
]));
export type ProviderErrorCodeV1 = z.infer<typeof ProviderErrorCodeV1Schema>;

/** Closed configuration causes from the canonical Machine connection resolver, never provider prose. */
export const ProviderConnectionInvalidReasonV1Schema = lazyZodSchema(() => z.enum([
  'invalid_connection_id',
  'invalid_machine_id',
  'unknown_endpoint_override',
  'managed_deployment_unavailable',
  'managed_purpose_bindings_missing',
  'managed_purpose_bindings_invalid',
]));
export type ProviderConnectionInvalidReasonV1 = z.infer<typeof ProviderConnectionInvalidReasonV1Schema>;

export const ProviderRecoveryActionV1Schema = lazyZodSchema(() => z.enum([
  'review_features', 'choose_connection', 'restore_plugin', 'enable_connection', 'review_account_grant', 'enable_on_machine',
  'review_machine_grant', 'review_compatibility', 'add_secret', 'review_credential_transport',
  'review_connection', 'retry', 'replace_secret', 'choose_model', 'load_model', 'review_and_restart',
  'restart_probe', 'reduce_provider_settings',
  'review_profile_migration', 'review_current_state',
]));
export type ProviderRecoveryActionV1 = z.infer<typeof ProviderRecoveryActionV1Schema>;

const ERROR_DEFAULTS = {
  [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired]: [false, 'review_connection'],
  model_not_granted: [false, 'choose_model'],
  model_selection_required: [false, 'choose_model'],
  permission_mode_not_granted: [false, 'review_account_grant'],
  provider_feature_disabled: [false, 'review_features'],
  provider_connection_not_found: [false, 'choose_connection'],
  provider_connection_changed: [true, 'review_connection'],
  provider_contribution_unavailable: [false, 'restore_plugin'],
  provider_connection_disabled: [false, 'enable_connection'],
  provider_account_grant_stale: [false, 'review_account_grant'],
  provider_account_scope_required: [false, 'enable_connection'],
  provider_not_enabled_on_machine: [false, 'enable_on_machine'],
  provider_machine_grant_stale: [false, 'review_machine_grant'],
  provider_incompatible_with_agent: [false, 'choose_connection'],
  provider_compatibility_unverified: [false, 'review_compatibility'],
  provider_secret_missing: [false, 'add_secret'],
  provider_secret_unavailable: [true, 'retry'],
  provider_credential_transport_unavailable: [false, 'review_credential_transport'],
  provider_run_credential_selection_required: [false, 'choose_connection'],
  provider_endpoint_unreachable: [true, 'retry'],
  provider_endpoint_unavailable: [true, 'retry'],
  provider_machine_unavailable: [true, 'retry'],
  machine_offline: [true, 'retry'],
  agent_unavailable: [false, 'review_connection'],
  agent_timeout: [true, 'retry'],
  agent_error: [false, 'review_connection'],
  // Host-side probe admission was full, so no endpoint request was attempted.
  // Reporting an endpoint outage here would send users to check a healthy service.
  provider_probe_capacity_exhausted: [true, 'retry'],
  provider_catalog_unavailable: [true, 'retry'],
  provider_rpc_response_invalid: [true, 'retry'],
  provider_rpc_mutation_outcome_unknown: [false, 'review_current_state'],
  provider_endpoint_rate_limited: [true, 'retry'],
  provider_endpoint_auth_required: [false, 'add_secret'],
  provider_endpoint_unauthorized: [false, 'replace_secret'],
  provider_probe_response_invalid: [false, 'review_connection'],
  provider_model_not_found: [false, 'choose_model'],
  provider_model_config_option_unsupported: [false, 'choose_model'],
  provider_model_unloaded: [false, 'review_connection'],
  provider_authorization_changed: [true, 'retry'],
  provider_binding_changed: [false, 'review_and_restart'],
  provider_switch_unsupported: [false, 'review_and_restart'],
  provider_agent_runtime_unsupported: [false, 'review_connection'],
  provider_managed_requires_daemon: [false, 'review_connection'],
  provider_materialization_failed: [false, 'review_connection'],
  provider_probe_authorization_invalid: [false, 'restart_probe'],
  provider_settings_limit_exceeded: [false, 'reduce_provider_settings'],
  provider_settings_invalid: [false, 'review_connection'],
  provider_connection_invalid: [false, 'review_connection'],
  provider_profile_migration_source_changed: [false, 'review_profile_migration'],
  provider_profile_migration_source_not_found: [false, 'review_profile_migration'],
  provider_profile_migration_conflict: [false, 'review_profile_migration'],
} as const satisfies Record<ProviderErrorCodeV1, readonly [boolean, ProviderRecoveryActionV1]>;

export const ProviderErrorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  code: ProviderErrorCodeV1Schema,
  requestId: z.optional(z.string().check(z.minLength(1))),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  connectionId: z.optional(ProviderConnectionIdSchema),
  machineId: z.optional(ProviderMachineIdSchema),
  sourceProfileId: z.optional(ProfileRecordIdV1Schema),
  retryable: z.boolean(),
  retryAfterMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  reason: z.optional(ProviderConnectionInvalidReasonV1Schema),
  /** The Saved Secret owner's admission reason behind a credential refusal, carried unchanged. */
  savedSecretReason: z.optional(SavedSecretOperationAdmissionFailureReasonV1Schema),
  action: ProviderRecoveryActionV1Schema,
}).check(z.superRefine((value, ctx) => {
  const [expectedRetryable, defaultAction] = ERROR_DEFAULTS[value.code];
  if (value.retryable !== expectedRetryable) {
    ctx.addIssue({ code: 'custom', path: ['retryable'], message: 'Retryability must match the provider error code' });
  }
  const actionAllowed = value.code === 'provider_model_unloaded'
    ? value.action === defaultAction || value.action === 'load_model'
    : value.action === defaultAction;
  if (!actionAllowed) {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'Recovery action must match the provider error code' });
  }
  if (value.code !== 'provider_endpoint_rate_limited' && value.retryAfterMs !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['retryAfterMs'], message: 'Retry delay is rate-limit only' });
  }
  if (value.code !== 'provider_connection_invalid' && value.reason !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Configuration reason is invalid-connection only' });
  }
  if (value.savedSecretReason !== undefined && value.code !== 'provider_secret_missing'
    && value.code !== 'provider_secret_unavailable' && value.code !== 'provider_binding_changed') {
    ctx.addIssue({ code: 'custom', path: ['savedSecretReason'], message: 'Saved Secret reason is credential-refusal only' });
  }
})));
export type ProviderErrorV1 = z.infer<typeof ProviderErrorV1Schema>;

export function createProviderErrorV1(
  code: ProviderErrorCodeV1,
  context: Readonly<{
    connectionId?: string;
    requestId?: string;
    failureCause?: ActionFailureCauseV1;
    machineId?: string;
    sourceProfileId?: string;
    retryAfterMs?: number;
    reason?: ProviderConnectionInvalidReasonV1;
    savedSecretReason?: SavedSecretOperationAdmissionFailureReasonV1;
    modelLoadAvailable?: boolean;
  }> = {},
  cause?: unknown,
): ProviderErrorV1 {
  const [retryable, action] = ERROR_DEFAULTS[code];
  const { modelLoadAvailable = false, ...errorContext } = context;
  const resolvedAction = code === 'provider_model_unloaded' && modelLoadAvailable ? 'load_model' : action;
  return ProviderErrorV1Schema.parse({ v: 1, code, retryable, action: resolvedAction, ...errorContext,
    ...(errorContext.failureCause === undefined && cause !== undefined
      ? { failureCause: projectActionFailureCauseV1(cause) } : {}),
  });
}

/** Classify Provider transport/Account mutation failures without disclosing raw failure prose. */
export function providerErrorFromRpcFailure(
  caught: unknown,
  context: Readonly<{ connectionId?: string; machineId?: string; sourceProfileId?: string }> = {},
): ProviderErrorV1 {
  const failure = parseActionExecuteFailure(caught);
  const requestId = failure?.requestId ?? (caught && typeof caught === 'object' && 'requestId' in caught
    && typeof caught.requestId === 'string' && caught.requestId.length > 0 ? caught.requestId : undefined);
  const failureCause = failure?.failureCause ?? projectActionFailureCauseV1(caught);
  const errorContext = { ...context, ...(requestId ? { requestId } : {}), failureCause };
  const typed = ProviderErrorV1Schema.safeParse(failure?.details ?? caught);
  if (typed.success) return { ...typed.data, ...(requestId ? { requestId } : {}),
    ...(!typed.data.failureCause && failure?.failureCause ? { failureCause: failure.failureCause } : {}) };

  const transportCode = failure?.failureCause?.errorCode ?? failure?.errorCode ?? (caught && typeof caught === 'object' && 'code' in caught
    ? (typeof caught.code === 'string' ? caught.code : undefined)
    : undefined);
  const providerCode = ProviderErrorCodeV1Schema.safeParse(transportCode);
  if (providerCode.success) return createProviderErrorV1(providerCode.data, errorContext);
  const rpcErrorCode = readRpcErrorCode(failure ? { code: transportCode } : caught);
  const message = caught instanceof Error ? caught.message : undefined;

  if (transportCode === 'provider_catalog_outcome_unknown') {
    return createProviderErrorV1('provider_rpc_mutation_outcome_unknown', errorContext);
  }
  if (transportCode === 'provider_catalog_conflict') {
    return createProviderErrorV1('provider_connection_changed', errorContext);
  }

  if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
    return createProviderErrorV1('agent_unavailable', errorContext);
  }
  if (rpcErrorCode === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE) {
    return createProviderErrorV1('provider_machine_unavailable', errorContext);
  }
  if (rpcErrorCode === RPC_ERROR_CODES.FORBIDDEN) {
    return createProviderErrorV1('provider_machine_grant_stale', errorContext);
  }
  if (isMachineRpcTimeoutError(caught)
    || transportCode === MACHINE_RPC_TIMEOUT_ERROR_CODE
    || transportCode === 'ETIMEDOUT'
    || transportCode === 'TIMEOUT'
    || rpcErrorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE
    || rpcErrorCode === 'RPC_TIMEOUT') {
    return createProviderErrorV1('agent_timeout', errorContext);
  }
  if (rpcErrorCode === 'machine_offline'
    || rpcErrorCode === 'MACHINE_ENCRYPTION_UNAVAILABLE'
    || transportCode === 'machine_offline'
    || transportCode === 'ENETUNREACH'
    || transportCode === 'EHOSTUNREACH'
    || transportCode === 'ENETDOWN'
    || transportCode === 'ECONNREFUSED'
    || transportCode === 'ENOTFOUND'
    || transportCode === 'EAI_AGAIN'
    || transportCode === 'ECONNRESET'
    || transportCode === 'ERR_NETWORK'
    || transportCode === 'OFFLINE'
    || message === 'offline'
    || message === 'machine_offline'
    || message === 'Socket not connected'
    || message?.includes('Machine encryption not found')) {
    return createProviderErrorV1('machine_offline', errorContext);
  }
  return createProviderErrorV1('agent_error', errorContext);
}
