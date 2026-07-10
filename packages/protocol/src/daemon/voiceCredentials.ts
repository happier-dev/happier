import { z } from 'zod';

export const DAEMON_VOICE_CREDENTIAL_SECRET_MAX_LENGTH = 16_384;
export const DAEMON_VOICE_PROVIDER_CATALOG_MAX_ITEMS = 500;

export const DaemonVoiceCredentialProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
export type DaemonVoiceCredentialProviderId = z.infer<typeof DaemonVoiceCredentialProviderIdSchema>;

export const DaemonVoiceCredentialKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
export type DaemonVoiceCredentialKind = z.infer<typeof DaemonVoiceCredentialKindSchema>;

export const DaemonVoiceCredentialProtectionSchema = z.enum(['os_protected', 'file_permissions']);
export type DaemonVoiceCredentialProtection = z.infer<typeof DaemonVoiceCredentialProtectionSchema>;

export const DaemonVoiceCredentialErrorCodeSchema = z.enum([
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
export type DaemonVoiceCredentialErrorCode = z.infer<typeof DaemonVoiceCredentialErrorCodeSchema>;

export const DaemonVoiceCredentialErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceCredentialErrorCodeSchema,
  error: DaemonVoiceCredentialErrorCodeSchema,
  retryable: z.boolean(),
}).strict();
export type DaemonVoiceCredentialError = z.infer<typeof DaemonVoiceCredentialErrorSchema>;

const CredentialIdentitySchema = z.object({
  providerId: DaemonVoiceCredentialProviderIdSchema,
  credentialKind: DaemonVoiceCredentialKindSchema,
}).strict();

export const DaemonVoiceCredentialStatusRequestSchema = CredentialIdentitySchema;
export type DaemonVoiceCredentialStatusRequest = z.infer<typeof DaemonVoiceCredentialStatusRequestSchema>;
export const DaemonVoiceCredentialStatusResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    exists: z.boolean(),
    protection: DaemonVoiceCredentialProtectionSchema,
  }).strict(),
  DaemonVoiceCredentialErrorSchema,
]);
export type DaemonVoiceCredentialStatusResponse = z.infer<typeof DaemonVoiceCredentialStatusResponseSchema>;

export const DaemonVoiceCredentialStoreRequestSchema = z.object({
  providerId: DaemonVoiceCredentialProviderIdSchema,
  credentialKind: DaemonVoiceCredentialKindSchema,
  secret: z.string().min(1).max(DAEMON_VOICE_CREDENTIAL_SECRET_MAX_LENGTH),
}).strict();
export type DaemonVoiceCredentialStoreRequest = z.infer<typeof DaemonVoiceCredentialStoreRequestSchema>;
export const DaemonVoiceCredentialStoreResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    protection: DaemonVoiceCredentialProtectionSchema,
  }).strict(),
  DaemonVoiceCredentialErrorSchema,
]);
export type DaemonVoiceCredentialStoreResponse = z.infer<typeof DaemonVoiceCredentialStoreResponseSchema>;

export const DaemonVoiceCredentialDeleteRequestSchema = CredentialIdentitySchema;
export type DaemonVoiceCredentialDeleteRequest = z.infer<typeof DaemonVoiceCredentialDeleteRequestSchema>;
export const DaemonVoiceCredentialDeleteResponseSchema = z.union([
  z.object({ ok: z.literal(true), deleted: z.boolean() }).strict(),
  DaemonVoiceCredentialErrorSchema,
]);
export type DaemonVoiceCredentialDeleteResponse = z.infer<typeof DaemonVoiceCredentialDeleteResponseSchema>;

export const DaemonVoiceCredentialMintClientAuthRequestSchema = z.object({
  providerId: DaemonVoiceCredentialProviderIdSchema,
  credentialKind: DaemonVoiceCredentialKindSchema,
  audience: z.string().trim().min(1).max(256),
}).strict();
export type DaemonVoiceCredentialMintClientAuthRequest = z.infer<typeof DaemonVoiceCredentialMintClientAuthRequestSchema>;

export const DaemonVoiceClientAuthArtifactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sdk_token'),
    value: z.string().min(1).max(16_384),
    expiresAtMs: z.number().int().positive(),
    placement: z.literal('provider_sdk_parameter'),
  }).strict(),
  z.object({
    kind: z.literal('subprotocol_token'),
    value: z.string().min(1).max(16_384),
    expiresAtMs: z.number().int().positive(),
    placement: z.literal('websocket_subprotocol'),
  }).strict(),
  z.object({
    kind: z.literal('bearer_token'),
    value: z.string().min(1).max(16_384),
    expiresAtMs: z.number().int().positive(),
    placement: z.literal('authorization_header'),
  }).strict(),
  z.object({
    kind: z.literal('signed_url'),
    value: z.string().url().max(16_384),
    expiresAtMs: z.number().int().positive(),
    placement: z.literal('request_url'),
  }).strict(),
]);
export type DaemonVoiceClientAuthArtifact = z.infer<typeof DaemonVoiceClientAuthArtifactSchema>;

export const DaemonVoiceCredentialMintClientAuthResponseSchema = z.union([
  z.object({ ok: z.literal(true), artifact: DaemonVoiceClientAuthArtifactSchema }).strict(),
  DaemonVoiceCredentialErrorSchema,
]);
export type DaemonVoiceCredentialMintClientAuthResponse = z.infer<typeof DaemonVoiceCredentialMintClientAuthResponseSchema>;

export const DaemonVoiceProviderCatalogRequestSchema = z.object({
  providerId: DaemonVoiceCredentialProviderIdSchema,
  credentialKind: DaemonVoiceCredentialKindSchema,
  catalog: z.enum(['voices', 'models']),
}).strict();
export type DaemonVoiceProviderCatalogRequest = z.infer<typeof DaemonVoiceProviderCatalogRequestSchema>;

const CatalogMetadataValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const DaemonVoiceProviderCatalogItemSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  metadata: z.record(z.string().max(64), CatalogMetadataValueSchema).default({}),
}).strict();
export type DaemonVoiceProviderCatalogItem = z.infer<typeof DaemonVoiceProviderCatalogItemSchema>;
export const DaemonVoiceProviderCatalogResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    items: z.array(DaemonVoiceProviderCatalogItemSchema).max(DAEMON_VOICE_PROVIDER_CATALOG_MAX_ITEMS),
  }).strict(),
  DaemonVoiceCredentialErrorSchema,
]);
export type DaemonVoiceProviderCatalogResponse = z.infer<typeof DaemonVoiceProviderCatalogResponseSchema>;
