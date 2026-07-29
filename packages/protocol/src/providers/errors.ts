import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderMachineIdSchema } from './ids.js';

export const ProviderErrorCodeV1Schema = z.enum([
  'provider_feature_disabled', 'provider_connection_not_found', 'provider_connection_changed', 'provider_contribution_unavailable', 'provider_connection_disabled',
  'provider_account_grant_stale', 'provider_not_enabled_on_machine', 'provider_machine_grant_stale',
  'provider_incompatible_with_agent', 'provider_compatibility_unverified', 'provider_secret_missing',
  'provider_credential_transport_unavailable', 'provider_endpoint_unreachable', 'provider_endpoint_unavailable',
  'provider_rpc_response_invalid', 'provider_rpc_mutation_outcome_unknown',
  'provider_endpoint_rate_limited', 'provider_endpoint_auth_required', 'provider_endpoint_unauthorized',
  'provider_probe_response_invalid', 'provider_model_not_found', 'provider_model_unloaded',
  'provider_authorization_changed', 'provider_binding_changed', 'provider_switch_unsupported',
  'provider_agent_runtime_unsupported', 'provider_materialization_failed',
  'provider_probe_authorization_invalid', 'provider_settings_limit_exceeded',
  'provider_settings_invalid', 'provider_connection_invalid',
  'provider_profile_migration_source_changed', 'provider_profile_migration_source_not_found',
  'provider_profile_migration_conflict',
]);
export type ProviderErrorCodeV1 = z.infer<typeof ProviderErrorCodeV1Schema>;

export const ProviderRecoveryActionV1Schema = z.enum([
  'review_features', 'choose_connection', 'restore_plugin', 'enable_connection', 'review_account_grant', 'enable_on_machine',
  'review_machine_grant', 'review_compatibility', 'add_secret', 'review_credential_transport',
  'review_connection', 'retry', 'replace_secret', 'choose_model', 'load_model', 'review_and_restart',
  'restart_probe', 'reduce_provider_settings',
  'review_profile_migration', 'review_current_state',
]);
export type ProviderRecoveryActionV1 = z.infer<typeof ProviderRecoveryActionV1Schema>;

const ERROR_DEFAULTS = {
  provider_feature_disabled: [false, 'review_features'],
  provider_connection_not_found: [false, 'choose_connection'],
  provider_connection_changed: [true, 'review_connection'],
  provider_contribution_unavailable: [false, 'restore_plugin'],
  provider_connection_disabled: [false, 'enable_connection'],
  provider_account_grant_stale: [false, 'review_account_grant'],
  provider_not_enabled_on_machine: [false, 'enable_on_machine'],
  provider_machine_grant_stale: [false, 'review_machine_grant'],
  provider_incompatible_with_agent: [false, 'choose_connection'],
  provider_compatibility_unverified: [false, 'review_compatibility'],
  provider_secret_missing: [false, 'add_secret'],
  provider_credential_transport_unavailable: [false, 'review_credential_transport'],
  provider_endpoint_unreachable: [true, 'retry'],
  provider_endpoint_unavailable: [true, 'retry'],
  provider_rpc_response_invalid: [true, 'retry'],
  provider_rpc_mutation_outcome_unknown: [false, 'review_current_state'],
  provider_endpoint_rate_limited: [true, 'retry'],
  provider_endpoint_auth_required: [false, 'add_secret'],
  provider_endpoint_unauthorized: [false, 'replace_secret'],
  provider_probe_response_invalid: [false, 'review_connection'],
  provider_model_not_found: [false, 'choose_model'],
  provider_model_unloaded: [false, 'review_connection'],
  provider_authorization_changed: [true, 'retry'],
  provider_binding_changed: [false, 'review_and_restart'],
  provider_switch_unsupported: [false, 'review_and_restart'],
  provider_agent_runtime_unsupported: [false, 'review_connection'],
  provider_materialization_failed: [false, 'review_connection'],
  provider_probe_authorization_invalid: [false, 'restart_probe'],
  provider_settings_limit_exceeded: [false, 'reduce_provider_settings'],
  provider_settings_invalid: [false, 'review_connection'],
  provider_connection_invalid: [false, 'review_connection'],
  provider_profile_migration_source_changed: [false, 'review_profile_migration'],
  provider_profile_migration_source_not_found: [false, 'review_profile_migration'],
  provider_profile_migration_conflict: [false, 'review_profile_migration'],
} as const satisfies Record<ProviderErrorCodeV1, readonly [boolean, ProviderRecoveryActionV1]>;

export const ProviderErrorV1Schema = z.object({
  v: z.literal(1),
  code: ProviderErrorCodeV1Schema,
  connectionId: ProviderConnectionIdSchema.optional(),
  machineId: ProviderMachineIdSchema.optional(),
  sourceProfileId: z.string().min(1).max(256).optional(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  action: ProviderRecoveryActionV1Schema,
}).strict().superRefine((value, ctx) => {
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
});
export type ProviderErrorV1 = z.infer<typeof ProviderErrorV1Schema>;

export function createProviderErrorV1(
  code: ProviderErrorCodeV1,
  context: Readonly<{
    connectionId?: string;
    machineId?: string;
    sourceProfileId?: string;
    retryAfterMs?: number;
    modelLoadAvailable?: boolean;
  }> = {},
): ProviderErrorV1 {
  const [retryable, action] = ERROR_DEFAULTS[code];
  const { modelLoadAvailable = false, ...errorContext } = context;
  const resolvedAction = code === 'provider_model_unloaded' && modelLoadAvailable ? 'load_model' : action;
  return ProviderErrorV1Schema.parse({ v: 1, code, retryable, action: resolvedAction, ...errorContext });
}
