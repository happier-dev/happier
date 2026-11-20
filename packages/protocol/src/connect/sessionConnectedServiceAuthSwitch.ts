import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  ConnectedAccountServiceKeyIngressSchema,
  ConnectedServiceBindingsV2IngressSchema,
} from './connectedServiceBindings.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../teams/credentials/sessionBindingIntentV1.js';
import { ConnectedServiceUxDiagnosticCurrentV1Schema } from './connectedServiceUxDiagnostics.js';

export const SessionConnectedServiceAuthSwitchRpcParamsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
  // Current callers write V2. Released V1 callers remain a required
  // new-daemon/old-client ingress and normalize before domain logic.
  bindings: ConnectedServiceBindingsV2IngressSchema,
  // Released V1 callers name the same services by scalar id in these adjacent
  // fields too, so they normalize through the one Connected Account service
  // key ingress rather than requiring the qualified key `bindings` accepts.
  rematerializeServiceId: z.optional(ConnectedAccountServiceKeyIngressSchema),
  expectedGroupGenerationByServiceId: z.optional(z.record(
    ConnectedAccountServiceKeyIngressSchema,
    z.number().check(z.int(), z.nonnegative()),
  )),
  teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema.check(z.minLength(1))),
  previousTeamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema.check(z.minLength(1))),
  teamVisibilityGrantConsent: z.optional(z.strictObject({ teamId: z.string().check(z.minLength(1)) })),
  accountSettingsVersionHint: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

export type SessionConnectedServiceAuthSwitchRpcParams = z.infer<
  typeof SessionConnectedServiceAuthSwitchRpcParamsSchema
>;

export const SESSION_CONNECTED_SERVICE_AUTH_OPTIONS_SOURCE_ID = 'session.connected_services_auth.available';

export const SessionConnectedServiceAuthSwitchRoutingSchema = lazyZodSchema(() =>
  z.extend(z.omit(SessionConnectedServiceAuthSwitchRpcParamsSchema, { sessionId: true }), {
    selectedServiceId: z.optional(ConnectedAccountServiceKeyIngressSchema),
  }),
);

export const SessionConnectedServiceAuthSwitchOptionsRpcParamsSchema = lazyZodSchema(() =>
  z.pick(SessionConnectedServiceAuthSwitchRpcParamsSchema, { sessionId: true }),
);

export const SessionConnectedServiceAuthSwitchOptionSchema = lazyZodSchema(() => z.strictObject({
  routing: z.extend(SessionConnectedServiceAuthSwitchRoutingSchema, { selectedServiceId: ConnectedAccountServiceKeyIngressSchema }),
  label: z.string(),
}));

export type SessionConnectedServiceAuthSwitchOption = z.infer<typeof SessionConnectedServiceAuthSwitchOptionSchema>;

export const SessionConnectedServiceAuthSwitchOptionsResultSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), options: z.array(SessionConnectedServiceAuthSwitchOptionSchema) }),
  z.strictObject({ ok: z.literal(false), errorCode: z.enum(['session_not_found', 'agent_mismatch', 'unavailable']) }),
]));

export type SessionConnectedServiceAuthSwitchOptionsResult = z.infer<typeof SessionConnectedServiceAuthSwitchOptionsResultSchema>;

const SwitchErrorCodeSchema = lazyZodSchema(() => z.enum([
  'session_not_found', 'agent_mismatch', 'unsupported_service', 'continuity_unsupported',
  'profile_missing', 'profile_disconnected', 'profile_action_required', 'group_missing',
  'not_group_selection', 'connected_service_required',
  'group_generation_conflict', 'provider_state_sharing_required', 'provider_state_sharing_unavailable',
  'provider_state_sharing_settings_unavailable', 'provider_session_state_unavailable_for_resume',
  'metadata_update_failed', 'restart_failed', 'hot_apply_failed', 'credential_revision_missing',
  'credential_revision_superseded', 'hot_apply_succeeded_but_recovery_failed',
  'provider_account_adoption_mismatch', 'post_switch_verification_failed',
  'partial_applied_pending_reconciliation',
]));

export type SessionConnectedServiceAuthSwitchErrorCode = z.infer<typeof SwitchErrorCodeSchema>;

export const SessionConnectedServiceAuthSwitchSuccessSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  action: z.enum(['unchanged', 'restart_requested', 'hot_applied', 'metadata_updated']),
}));

const SwitchServiceReceiptSchema = lazyZodSchema(() => z.object({
  status: z.enum(['applied', 'failed', 'not_attempted']),
}));

const SwitchFailureDiagnosticsSchema = lazyZodSchema(() => z.object({
  failurePhase: z.optional(z.enum(['session_lookup', 'agent_validation', 'normalization', 'continuity',
    'materialization', 'metadata', 'restart', 'hot_apply', 'post_switch_verification', 'recover', 'reconciliation'])),
  application: z.optional(z.object({
    status: z.enum(['hot_apply_failed', 'restart_failed', 'recover_failed',
      'hot_apply_succeeded_but_recovery_failed', 'partial_applied_pending_reconciliation']),
  })),
  serviceResultsByServiceId: z.optional(z.record(ConnectedAccountServiceKeyIngressSchema, SwitchServiceReceiptSchema)),
  // This recovery operand originates in personal Account profile validation.
  actionRequired: z.optional(z.object({
    kind: z.literal('reconnect_profile'),
    profileId: z.string(),
  })),
  uxDiagnostic: z.optional(z.object(z.pick(ConnectedServiceUxDiagnosticCurrentV1Schema, {
    code: true, failurePhase: true, source: true, serviceId: true, retryable: true, suggestedActions: true,
  }).shape)),
}));

export const SessionConnectedServiceAuthSwitchReceiptSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  SessionConnectedServiceAuthSwitchSuccessSchema,
  z.object({
    ok: z.literal(false),
    errorCode: SwitchErrorCodeSchema,
    serviceId: z.optional(ConnectedAccountServiceKeyIngressSchema),
    diagnostics: z.optional(SwitchFailureDiagnosticsSchema),
  }),
]));

export type SessionConnectedServiceAuthSwitchReceipt = z.infer<typeof SessionConnectedServiceAuthSwitchReceiptSchema>;
export type SessionConnectedServiceAuthSwitchServiceReceipt = z.infer<typeof SwitchServiceReceiptSchema>;
