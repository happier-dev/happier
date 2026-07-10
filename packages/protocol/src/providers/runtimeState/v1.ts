import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema } from '../ids.js';

export const ProviderModelLoadStateV1Schema = z.enum(['loaded', 'unloaded', 'unknown']);
export type ProviderModelLoadStateV1 = z.infer<typeof ProviderModelLoadStateV1Schema>;
export const ProviderEndpointHealthStatusV1Schema = z.enum(['not_checked', 'available', 'unreachable', 'temporarily_unavailable', 'rate_limited', 'unauthorized', 'invalid_response']);
export type ProviderEndpointHealthStatusV1 = z.infer<typeof ProviderEndpointHealthStatusV1Schema>;
export const ProviderEndpointProbeActivityV1Schema = z.enum(['idle', 'checking']);
export type ProviderEndpointProbeActivityV1 = z.infer<typeof ProviderEndpointProbeActivityV1Schema>;
export const ProviderConnectionSummaryHealthV1Schema = z.enum(['not_checked', 'available', 'partial', 'needs_attention', 'unreachable']);
export type ProviderConnectionSummaryHealthV1 = z.infer<typeof ProviderConnectionSummaryHealthV1Schema>;
const ObservationAuthorizationFingerprintV1Schema = z.string().trim().min(1).max(256)
  .startsWith('observation-authorization:v1:');

export const ProviderEndpointRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  endpointTemplateId: ProviderLocalIdSchema,
  endpointFingerprint: z.string().trim().min(1).max(256),
  observationAuthorizationFingerprint: ObservationAuthorizationFingerprintV1Schema,
}).strict();
export const ProviderCatalogRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
  catalogFingerprint: z.string().trim().min(1).max(256),
  observationAuthorizationFingerprint: ObservationAuthorizationFingerprintV1Schema,
}).strict();
export const ProviderInstallationRuntimeStateKeyV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema,
  checkId: ProviderLocalIdSchema,
}).strict();

const RuntimeTimestampSchema = z.number().finite().nonnegative();
const observedStateShape = {
  activity: ProviderEndpointProbeActivityV1Schema,
  observedAt: RuntimeTimestampSchema,
  staleAt: RuntimeTimestampSchema.optional(),
} as const;

export const ProviderEndpointRuntimeStateV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('not_checked'),
    activity: ProviderEndpointProbeActivityV1Schema,
  }).strict(),
  z.object({
    status: z.literal('available'),
    ...observedStateShape,
  }).strict(),
  z.object({
    status: z.literal('unreachable'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_unreachable'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('temporarily_unavailable'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_unavailable'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('rate_limited'),
    ...observedStateShape,
    errorCode: z.literal('provider_endpoint_rate_limited'),
    retryAt: RuntimeTimestampSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('unauthorized'),
    ...observedStateShape,
    errorCode: z.enum(['provider_endpoint_auth_required', 'provider_endpoint_unauthorized']),
  }).strict(),
  z.object({
    status: z.literal('invalid_response'),
    ...observedStateShape,
    errorCode: z.literal('provider_probe_response_invalid'),
  }).strict(),
]).superRefine((value, ctx) => {
  if ('observedAt' in value && value.staleAt !== undefined && value.staleAt < value.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['staleAt'], message: 'Stale time cannot precede observation time' });
  }
  if ('observedAt' in value && 'retryAt' in value && value.retryAt !== undefined && value.retryAt < value.observedAt) {
    ctx.addIssue({ code: 'custom', path: ['retryAt'], message: 'Retry time cannot precede observation time' });
  }
});

export function deriveProviderConnectionSummaryHealthV1(
  states: readonly z.infer<typeof ProviderEndpointRuntimeStateV1Schema>[],
): ProviderConnectionSummaryHealthV1 {
  if (states.length === 0 || states.every((state) => state.status === 'not_checked')) return 'not_checked';
  if (states.every((state) => state.status === 'available')) return 'available';
  if (states.some((state) => state.status === 'available')) return 'partial';
  if (states.some((state) => ['rate_limited', 'unauthorized', 'invalid_response'].includes(state.status))) return 'needs_attention';
  if (states.some((state) => state.status === 'not_checked')) return 'not_checked';
  return 'unreachable';
}
