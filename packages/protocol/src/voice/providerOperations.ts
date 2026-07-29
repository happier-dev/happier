import { z } from 'zod';

export const VoiceProviderOperationErrorCodeSchema = z.enum([
  'invalid_parameters',
  'credential_unavailable',
  'provider_unavailable',
  'operation_unsupported',
  'rate_limited',
  'request_timeout',
  'cancelled',
  'provider_response_invalid',
  'internal_error',
]);
export type VoiceProviderOperationErrorCode = z.infer<typeof VoiceProviderOperationErrorCodeSchema>;

export const VoiceProviderCredentialRemediationCodeSchema = z.enum([
  'credential_unavailable',
  'credential_access_review_required',
]);
export type VoiceProviderCredentialRemediationCode = z.infer<
  typeof VoiceProviderCredentialRemediationCodeSchema
>;

export function classifyVoiceProviderHttpFailure(
  status: number,
): 'credential_unavailable' | 'provider_response_invalid' | null {
  if (Number.isInteger(status) && status >= 200 && status < 300) return null;
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

export const VoiceProviderOperationErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: VoiceProviderOperationErrorCodeSchema,
  error: VoiceProviderOperationErrorCodeSchema,
  retryable: z.boolean(),
}).strict();

export const VoiceClientAuthArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sdk_token'), value: z.string().min(1).max(16_384), expiresAtMs: z.number().int().positive(), placement: z.literal('provider_sdk_parameter') }).strict(),
  z.object({ kind: z.literal('subprotocol_token'), value: z.string().min(1).max(16_384), expiresAtMs: z.number().int().positive(), placement: z.literal('websocket_subprotocol') }).strict(),
  z.object({ kind: z.literal('bearer_token'), value: z.string().min(1).max(16_384), expiresAtMs: z.number().int().positive(), placement: z.literal('authorization_header') }).strict(),
  z.object({ kind: z.literal('signed_url'), value: z.string().url().max(16_384), expiresAtMs: z.number().int().positive(), placement: z.literal('request_url') }).strict(),
]);
export type VoiceClientAuthArtifact = z.infer<typeof VoiceClientAuthArtifactSchema>;

const CatalogMetadataValueSchema = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
export const VoiceProviderCatalogItemSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  metadata: z.record(z.string().max(64), CatalogMetadataValueSchema).default({}),
}).strict();
export type VoiceProviderCatalogItem = z.infer<typeof VoiceProviderCatalogItemSchema>;
export const VoiceProviderCatalogResponseSchema = z.union([
  z.object({ ok: z.literal(true), items: z.array(VoiceProviderCatalogItemSchema).max(500) }).strict(),
  VoiceProviderOperationErrorSchema,
]);
export type VoiceProviderCatalogResponse = z.infer<typeof VoiceProviderCatalogResponseSchema>;
