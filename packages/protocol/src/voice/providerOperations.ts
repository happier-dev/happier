import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/** Existing Voice diagnostic-code boundary, shared by provider and host ingress. */
export function normalizeVoiceFailureCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(normalized) ? normalized : null;
}

export const VoiceProviderOperationErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_parameters',
  'credential_unavailable',
  'provider_unavailable',
  'operation_unsupported',
  'rate_limited',
  'request_timeout',
  'cancelled',
  'provider_response_invalid',
  'internal_error',
]));
export type VoiceProviderOperationErrorCode = z.infer<typeof VoiceProviderOperationErrorCodeSchema>;

export const VoiceProviderCredentialRemediationCodeSchema = lazyZodSchema(() => z.enum([
  'credential_unavailable',
  'credential_access_review_required',
]));
export type VoiceProviderCredentialRemediationCode = z.infer<
  typeof VoiceProviderCredentialRemediationCodeSchema
>;

export function classifyVoiceProviderHttpFailure(
  status: number,
): 'credential_unavailable' | 'rate_limited' | 'provider_response_invalid' | null {
  if (Number.isInteger(status) && status >= 200 && status < 300) return null;
  if (status === 429) return 'rate_limited';
  return status === 401 || status === 403
    ? 'credential_unavailable'
    : 'provider_response_invalid';
}

export function readVoiceProviderCredentialRemediationCode(
  value: unknown,
): VoiceProviderCredentialRemediationCode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = VoiceProviderCredentialRemediationCodeSchema.safeParse(
    (value as Readonly<{ code?: unknown }>).code,
  );
  return parsed.success ? parsed.data : null;
}

export const VoiceProviderOperationErrorSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: VoiceProviderOperationErrorCodeSchema,
  error: VoiceProviderOperationErrorCodeSchema,
  retryable: z.boolean(),
}));

export const VoiceClientAuthArtifactSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sdk_token'), value: z.string().check(z.minLength(1), z.maxLength(16_384)), expiresAtMs: z.number().check(z.int(), z.positive()), placement: z.literal('provider_sdk_parameter') }),
  z.strictObject({ kind: z.literal('subprotocol_token'), value: z.string().check(z.minLength(1), z.maxLength(16_384)), expiresAtMs: z.number().check(z.int(), z.positive()), placement: z.literal('websocket_subprotocol') }),
  z.strictObject({ kind: z.literal('bearer_token'), value: z.string().check(z.minLength(1), z.maxLength(16_384)), expiresAtMs: z.number().check(z.int(), z.positive()), placement: z.literal('authorization_header') }),
  z.strictObject({ kind: z.literal('signed_url'), value: z.string().check(z.url(), z.maxLength(16_384)), expiresAtMs: z.number().check(z.int(), z.positive()), placement: z.literal('request_url') }),
]));
export type VoiceClientAuthArtifact = z.infer<typeof VoiceClientAuthArtifactSchema>;

const CatalogMetadataValueSchema = lazyZodSchema(() => z.union([z.string().check(z.maxLength(512)), z.number(), z.boolean(), z.null()]));
export const VoiceProviderCatalogItemSchema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  metadata: z._default(z.record(z.string().check(z.maxLength(64)), CatalogMetadataValueSchema), {}),
}));
export type VoiceProviderCatalogItem = z.infer<typeof VoiceProviderCatalogItemSchema>;
export const VoiceProviderCatalogResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(VoiceProviderCatalogItemSchema).check(z.maxLength(500)) }),
  VoiceProviderOperationErrorSchema,
]));
export type VoiceProviderCatalogResponse = z.infer<typeof VoiceProviderCatalogResponseSchema>;
