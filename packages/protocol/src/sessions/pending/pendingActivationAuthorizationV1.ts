import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ManagedWakeTargetV1Schema } from '../../machines/managed/managedIntentV1.js';
import { SessionInputMachineTargetV1Schema } from '../messages/sessionInputAdmission.js';
import { SpawnSessionErrorCodeSchema } from '../spawnSession.js';

export const PendingActivationFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  'runtime_start_failed', 'managed_start_refused', 'managed_start_denied', 'managed_start_expired', 'managed_start_failed',
]));
export type PendingActivationFailureCodeV1 = z.infer<typeof PendingActivationFailureCodeV1Schema>;

/** Optional read-only queue diagnostics. Unknown reasons are ignored, never activation authority. */
export const PendingActivationHoldReasonV1Schema = lazyZodSchema(() => z.enum([
  'resume_not_requested', 'managed_power_required',
]));
export type PendingActivationHoldReasonV1 = z.infer<typeof PendingActivationHoldReasonV1Schema>;

export const PendingActivationRuntimeFailureReasonV1Schema = lazyZodSchema(() => z.enum([
  'runner_authority_unavailable', 'runner_presence_unproven', 'no_token', 'shutdown',
  'transport_unavailable', 'encryption_material_unavailable', 'runtime_upgrade_required',
  'malformed_response', 'rpc_method_unavailable', 'rpc_failed', 'no_eligible_member',
  'connected_service_credential_reconnect_required', 'connected_service_credential_refresh_unavailable',
]));

/** Diagnostic facts only: no native prose, paths, input content or credential material. */
export const PendingActivationFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum(['ineligible', 'identity-unavailable', 'takeover-required', 'session-directory-missing', 'spawn-rejected']),
  spawnErrorCode: z.optional(SpawnSessionErrorCodeSchema),
  runtimeReason: z.optional(PendingActivationRuntimeFailureReasonV1Schema),
}));
export type PendingActivationFailureDetailsV1 = z.infer<typeof PendingActivationFailureDetailsV1Schema>;

// The predecessor ignores query diagnostics and still accepts the unchanged CAS body.
export const PendingActivationFailureQueryV1Schema = lazyZodSchema(() => z.strictObject({
  failureDetails: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
  }), PendingActivationFailureDetailsV1Schema)),
}));

const PendingActivationAuthorizationBaseV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().check(z.trim(), z.minLength(1)),
  requestedAt: z.number().check(z.int(), z.nonnegative()),
  managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  admittedTarget: z.optional(SessionInputMachineTargetV1Schema),
}));

export const PendingActivationAuthorizationV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PendingActivationAuthorizationBaseV1Schema, { status: z.literal('waiting') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PendingActivationAuthorizationBaseV1Schema, {
    status: z.literal('failed'),
    failureCode: PendingActivationFailureCodeV1Schema,
  })),
]));
export type PendingActivationAuthorizationV1 = z.infer<typeof PendingActivationAuthorizationV1Schema>;

export const PendingActivationFailureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.trim(), z.minLength(1)),
  requestedAt: z.number().check(z.int(), z.nonnegative()),
  failureCode: PendingActivationFailureCodeV1Schema,
}));
export type PendingActivationFailureRequestV1 = z.infer<typeof PendingActivationFailureRequestV1Schema>;

/** Installation-signed controller report; the target reference is not bearer authority. */
export const ManagedPendingActivationFailureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  target: ManagedWakeTargetV1Schema,
  failureCode: PendingActivationFailureCodeV1Schema,
}).check(z.refine(value => value.target.origin.kind === 'session-input')));
export type ManagedPendingActivationFailureRequestV1 = z.infer<typeof ManagedPendingActivationFailureRequestV1Schema>;

export const PendingActivationFailureResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  didFail: z.boolean(),
}));
export type PendingActivationFailureResponseV1 = z.infer<typeof PendingActivationFailureResponseV1Schema>;

/** Only a confirmed owner removal permits restoring the original input as a draft. */
export const PendingMessageWithdrawOutcomeV1Schema = lazyZodSchema(() => z.enum([
  'removed', 'already_delivered', 'delivery_unknown',
]));
export type PendingMessageWithdrawOutcomeV1 = z.infer<typeof PendingMessageWithdrawOutcomeV1Schema>;
