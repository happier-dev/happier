import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { normalizeServerIdentityIdCapability } from '../features/payload/capabilities/serverIdentityCapabilities.js';
export { AccountDirectoryCapabilitiesSchema } from '../features/payload/capabilities/accountDirectoryCapabilities.js';
export type { AccountDirectoryCapabilities } from '../features/payload/capabilities/accountDirectoryCapabilities.js';

/** The assertion is signed independently from ordinary account/session tokens. */
export const ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1 =
  'happier.account-directory.home-login.v1' as const;

export const ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1 = '/v1/account-directory/me' as const;
export const ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1 = '/v1/account-directory/homes' as const;
export const ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1 =
  '/v1/account-directory/homes/preferred' as const;
export const ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1 =
  '/v1/account-directory/homes/:homeServerIdentityId/login-assertion' as const;
export const ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1 =
  '/v1/account/directory-links/:issuerServerIdentityId' as const;
export const HOME_LOGIN_HTTP_PATH_V1 = '/v1/auth/home-login' as const;

export const ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS = 2 * 60 * 1000;
export const ACCOUNT_DIRECTORY_ASSERTION_MAX_LIFETIME_MS = 5 * 60 * 1000;
/** Redemption may apply this bounded skew; schema validation remains clock-independent. */
export const ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS = 30 * 1000;

export const ACCOUNT_DIRECTORY_MAX_ENDPOINTS = 16;
export const ACCOUNT_DIRECTORY_MAX_RELAY_URLS = 8;
export const ACCOUNT_DIRECTORY_MAX_DIRECT_ADDRESSES = 16;
export const ACCOUNT_DIRECTORY_MAX_HOMES = 256;
export const ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES = 128;
export const ACCOUNT_DIRECTORY_MAX_ID_UTF8_BYTES = 256;
export const ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES = 512;
export const ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES = 16 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();
const SERVER_IDENTITY_ID_PATTERN = /^srv_[A-Za-z0-9._-]{1,60}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const URL_WITHOUT_CREDENTIALS_OR_FRAGMENT = z.string()
  .trim()
  .min(1)
  .max(ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL exceeds its UTF-8 byte limit' });
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must use HTTP or HTTPS' });
      }
      if (parsed.username || parsed.password || parsed.hash) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must not contain credentials or a fragment' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must be absolute' });
    }
  });

const ServerIdentityIdSchema = z.preprocess(
  normalizeServerIdentityIdCapability,
  z.string().trim().min(1).max(64).regex(SERVER_IDENTITY_ID_PATTERN),
);

const BoundedIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(ACCOUNT_DIRECTORY_MAX_ID_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_ID_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Identifier exceeds its UTF-8 byte limit' });
    }
  });

const LabelSchema = z.string()
  .trim()
  .min(1)
  .max(ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Label exceeds its UTF-8 byte limit' });
    }
  });

function strictEncodedBytes(
  variant: 'base64' | 'base64url',
  expectedBytes: number | undefined,
  maxBytes: number,
): z.ZodType<string> {
  return z.string().min(1).max(Math.ceil(maxBytes / 3) * 4 + 4).refine((value) => {
    if (variant === 'base64') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) return false;
    } else if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
      return false;
    }
    try {
      const decoded = decodeBase64(value, variant);
      if (decoded.byteLength > maxBytes) return false;
      if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) return false;
      return encodeBase64(decoded, variant) === value;
    } catch {
      return false;
    }
  }, `must be canonical ${variant} and contain a valid bounded byte payload`);
}

const ClientBoxPublicKeyBase64Schema = strictEncodedBytes('base64', 32, 32);
const PublicKeyBase64UrlSchema = strictEncodedBytes('base64url', 32, 32);
const SignatureBase64UrlSchema = strictEncodedBytes('base64url', 64, 64);
const SealedHomeTokenBase64UrlSchema = strictEncodedBytes(
  'base64url',
  undefined,
  ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES,
);

const PositiveRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TimestampMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const IrohEndpointDescriptorV1Schema = z.object({
  kind: z.literal('iroh'),
  endpointId: BoundedIdentifierSchema,
  relayUrls: z.array(URL_WITHOUT_CREDENTIALS_OR_FRAGMENT).max(ACCOUNT_DIRECTORY_MAX_RELAY_URLS).optional(),
  directAddresses: z.array(z.string().trim().min(1).max(256)).max(ACCOUNT_DIRECTORY_MAX_DIRECT_ADDRESSES).optional(),
}).strict();

const HttpsEndpointDescriptorV1Schema = z.object({
  kind: z.literal('https'),
  url: URL_WITHOUT_CREDENTIALS_OR_FRAGMENT,
}).strict();

export const HomeConnectionEndpointV1Schema = z.discriminatedUnion('kind', [
  HttpsEndpointDescriptorV1Schema,
  IrohEndpointDescriptorV1Schema,
]);
export type HomeConnectionEndpointV1 = z.infer<typeof HomeConnectionEndpointV1Schema>;

export const HomeConnectionDescriptorV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: URL_WITHOUT_CREDENTIALS_OR_FRAGMENT,
  revision: PositiveRevisionSchema,
  endpoints: z.array(HomeConnectionEndpointV1Schema)
    .min(1)
    .max(ACCOUNT_DIRECTORY_MAX_ENDPOINTS),
}).strict();
export type HomeConnectionDescriptorV1 = z.infer<typeof HomeConnectionDescriptorV1Schema>;

const AccountDirectoryHomeIdentityFieldsSchema = z.object({
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: URL_WITHOUT_CREDENTIALS_OR_FRAGMENT,
}).strict();

function validateDescriptorIdentityAndUrl(
  value: Readonly<{ homeServerIdentityId: string; canonicalServerUrl: string; connectionDescriptor?: HomeConnectionDescriptorV1 }>,
  context: z.RefinementCtx,
): void {
  if (!value.connectionDescriptor) return;
  if (value.connectionDescriptor.homeServerIdentityId !== value.homeServerIdentityId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['connectionDescriptor', 'homeServerIdentityId'], message: 'Descriptor identity must match its directory entry' });
  }
  if (value.connectionDescriptor.canonicalServerUrl !== value.canonicalServerUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['connectionDescriptor', 'canonicalServerUrl'], message: 'Descriptor canonical URL must match its directory entry' });
  }
}

export const AccountDirectoryHomeEntryV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: URL_WITHOUT_CREDENTIALS_OR_FRAGMENT,
  label: LabelSchema,
  connectionDescriptor: HomeConnectionDescriptorV1Schema,
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  preferred: z.boolean(),
}).strict().superRefine(validateDescriptorIdentityAndUrl);
export type AccountDirectoryHomeEntryV1 = z.infer<typeof AccountDirectoryHomeEntryV1Schema>;

export const AccountDirectoryHomePutRequestV1Schema = z.object({
  v: z.literal(1),
  label: LabelSchema,
  connectionDescriptor: HomeConnectionDescriptorV1Schema,
}).strict();
export type AccountDirectoryHomePutRequestV1 = z.infer<typeof AccountDirectoryHomePutRequestV1Schema>;

export const AccountDirectoryHomePutResponseV1Schema = AccountDirectoryHomeEntryV1Schema;
export type AccountDirectoryHomePutResponseV1 = AccountDirectoryHomeEntryV1;

export const AccountDirectoryHomeDeleteRequestV1Schema = z.object({ v: z.literal(1) }).strict();
export type AccountDirectoryHomeDeleteRequestV1 = z.infer<typeof AccountDirectoryHomeDeleteRequestV1Schema>;

export const AccountDirectoryHomeDeleteParamsV1Schema = z.object({
  homeServerIdentityId: ServerIdentityIdSchema,
}).strict();
export type AccountDirectoryHomeDeleteParamsV1 = z.infer<typeof AccountDirectoryHomeDeleteParamsV1Schema>;

export const AccountDirectoryHomeDeleteResponseV1Schema = z.object({
  v: z.literal(1),
  deleted: z.literal(true),
  homeServerIdentityId: ServerIdentityIdSchema,
  preferredHomeServerIdentityId: ServerIdentityIdSchema.nullable(),
}).strict();
export type AccountDirectoryHomeDeleteResponseV1 = z.infer<typeof AccountDirectoryHomeDeleteResponseV1Schema>;

export const AccountDirectoryHomesResponseV1Schema = z.object({
  v: z.literal(1),
  homes: z.array(AccountDirectoryHomeEntryV1Schema).max(ACCOUNT_DIRECTORY_MAX_HOMES),
  preferredHomeServerIdentityId: ServerIdentityIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  const preferred = value.preferredHomeServerIdentityId;
  if (preferred && !value.homes.some((home) => home.homeServerIdentityId === preferred)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['preferredHomeServerIdentityId'], message: 'Preferred Home must be present in homes' });
  }
  const preferredEntries = value.homes.filter((home) => home.preferred);
  if (preferredEntries.length > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['homes'], message: 'At most one Home may be marked preferred' });
  }
  if (preferred && preferredEntries.length === 1 && preferredEntries[0]!.homeServerIdentityId !== preferred) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['homes'], message: 'Entry preferred status must match preferredHomeServerIdentityId' });
  }
}).transform((value) => value);
export type AccountDirectoryHomesResponseV1 = z.infer<typeof AccountDirectoryHomesResponseV1Schema>;

export const AccountDirectoryPreferredHomePatchRequestV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema.nullable(),
}).strict();
export type AccountDirectoryPreferredHomePatchRequestV1 = z.infer<typeof AccountDirectoryPreferredHomePatchRequestV1Schema>;
export const AccountDirectoryPreferredHomePatchResponseV1Schema = AccountDirectoryHomesResponseV1Schema;
export type AccountDirectoryPreferredHomePatchResponseV1 = AccountDirectoryHomesResponseV1;

export const AccountDirectoryLinkedAuthenticationMethodV1Schema = z.object({
  providerId: BoundedIdentifierSchema,
  login: BoundedIdentifierSchema.nullable(),
}).strict();
export type AccountDirectoryLinkedAuthenticationMethodV1 = z.infer<typeof AccountDirectoryLinkedAuthenticationMethodV1Schema>;

export const AccountDirectoryMeResponseV1Schema = z.object({
  v: z.literal(1),
  accountId: BoundedIdentifierSchema,
  displayName: LabelSchema.nullable(),
  avatar: z.string().trim().max(ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES).url().nullable(),
  linkedAuthenticationMethods: z.array(AccountDirectoryLinkedAuthenticationMethodV1Schema).max(32),
}).strict();
export type AccountDirectoryMeResponseV1 = z.infer<typeof AccountDirectoryMeResponseV1Schema>;

export const AccountDirectoryLinkV1Schema = z.object({
  v: z.literal(1),
  issuerServerIdentityId: ServerIdentityIdSchema,
  issuerSubjectId: BoundedIdentifierSchema,
  issuerSigningKeyId: z.string().regex(HEX_SHA256_PATTERN),
  issuerSigningPublicKeyBase64Url: PublicKeyBase64UrlSchema,
}).strict();
export type AccountDirectoryLinkV1 = z.infer<typeof AccountDirectoryLinkV1Schema>;

export const AccountDirectoryLinkPutRequestV1Schema = AccountDirectoryLinkV1Schema.extend({
  relink: z.boolean().optional().default(false),
}).strict();
export type AccountDirectoryLinkPutRequestV1 = z.infer<typeof AccountDirectoryLinkPutRequestV1Schema>;
export const AccountDirectoryLinkPutResponseV1Schema = AccountDirectoryLinkV1Schema;
export type AccountDirectoryLinkPutResponseV1 = AccountDirectoryLinkV1;
export const AccountDirectoryLinkDeleteRequestV1Schema = z.object({ v: z.literal(1) }).strict();
export type AccountDirectoryLinkDeleteRequestV1 = z.infer<typeof AccountDirectoryLinkDeleteRequestV1Schema>;
export const AccountDirectoryLinkDeleteParamsV1Schema = z.object({
  issuerServerIdentityId: ServerIdentityIdSchema,
}).strict();
export type AccountDirectoryLinkDeleteParamsV1 = z.infer<typeof AccountDirectoryLinkDeleteParamsV1Schema>;
export const AccountDirectoryLinkDeleteResponseV1Schema = z.object({
  v: z.literal(1),
  deleted: z.literal(true),
  issuerServerIdentityId: ServerIdentityIdSchema,
}).strict();
export type AccountDirectoryLinkDeleteResponseV1 = z.infer<typeof AccountDirectoryLinkDeleteResponseV1Schema>;

export const HomeLoginAssertionRequestV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  clientBoxPublicKeyBase64: ClientBoxPublicKeyBase64Schema,
}).strict();
export type HomeLoginAssertionRequestV1 = z.infer<typeof HomeLoginAssertionRequestV1Schema>;

const HomeLoginAssertionSigningFactsV1Schema = z.object({
  v: z.literal(1),
  purpose: z.literal('happier.home-login'),
  issuerServerIdentityId: ServerIdentityIdSchema,
  issuerSubjectId: BoundedIdentifierSchema,
  audienceHomeServerIdentityId: ServerIdentityIdSchema,
  clientBoxPublicKeyBase64: ClientBoxPublicKeyBase64Schema,
  issuedAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
  keyId: z.string().regex(HEX_SHA256_PATTERN),
}).strict().superRefine((value, context) => {
  const lifetime = value.expiresAtMs - value.issuedAtMs;
  if (lifetime < ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS || lifetime > ACCOUNT_DIRECTORY_ASSERTION_MAX_LIFETIME_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAtMs'], message: 'Assertion lifetime must be between two and five minutes' });
  }
});

export const HomeLoginAssertionV1Schema = HomeLoginAssertionSigningFactsV1Schema.extend({
  signatureBase64Url: SignatureBase64UrlSchema,
}).strict();
export type HomeLoginAssertionV1 = z.infer<typeof HomeLoginAssertionV1Schema>;

export const HomeLoginAssertionResponseV1Schema = HomeLoginAssertionV1Schema;
export type HomeLoginAssertionResponseV1 = HomeLoginAssertionV1;

export function createHomeLoginAssertionSigningBytesV1(
  input: HomeLoginAssertionV1 | Omit<HomeLoginAssertionV1, 'signatureBase64Url'>,
): Uint8Array {
  const { signatureBase64Url: _signature, ...facts } = input as HomeLoginAssertionV1;
  const parsed = HomeLoginAssertionSigningFactsV1Schema.parse(facts);
  return encodeCanonicalLengthDelimited([
    String(parsed.v),
    parsed.purpose,
    parsed.issuerServerIdentityId,
    parsed.issuerSubjectId,
    parsed.audienceHomeServerIdentityId,
    parsed.clientBoxPublicKeyBase64,
    String(parsed.issuedAtMs),
    String(parsed.expiresAtMs),
    parsed.keyId,
  ]);
}

/** Alias used by signers that call the canonical bytes a signing input. */
export const createHomeLoginAssertionSigningInputV1 = createHomeLoginAssertionSigningBytesV1;

export const HomeLoginRedemptionRequestV1Schema = z.object({
  v: z.literal(1),
  assertion: HomeLoginAssertionV1Schema,
  approvalId: BoundedIdentifierSchema.optional(),
}).strict();
export type HomeLoginRedemptionRequestV1 = z.infer<typeof HomeLoginRedemptionRequestV1Schema>;

export const HomeLoginRedemptionResponseV1Schema = z.object({
  v: z.literal(1),
  outcome: z.literal('authorized'),
  homeServerIdentityId: ServerIdentityIdSchema,
  sealedHomeTokenBase64Url: SealedHomeTokenBase64UrlSchema,
  issuedAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.issuedAtMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAtMs'], message: 'Home token expiry must be after issuance' });
  }
});
export type HomeLoginRedemptionResponseV1 = z.infer<typeof HomeLoginRedemptionResponseV1Schema>;

export const HomeLoginRedemptionApprovalRequiredV1Schema = z.object({
  v: z.literal(1),
  outcome: z.literal('approval_required'),
  homeServerIdentityId: ServerIdentityIdSchema,
  approvalId: BoundedIdentifierSchema,
  deviceLabel: LabelSchema.nullable(),
  expiresAtMs: TimestampMsSchema,
}).strict();
export type HomeLoginRedemptionApprovalRequiredV1 = z.infer<typeof HomeLoginRedemptionApprovalRequiredV1Schema>;

export const HomeLoginRedemptionResultV1Schema = z.discriminatedUnion('outcome', [
  HomeLoginRedemptionResponseV1Schema,
  HomeLoginRedemptionApprovalRequiredV1Schema,
]);
export type HomeLoginRedemptionResultV1 = z.infer<typeof HomeLoginRedemptionResultV1Schema>;

export const ACCOUNT_DIRECTORY_ERROR_CODES_V1 = {
  invalidRequest: 'invalid_request',
  unsupportedVersion: 'unsupported_version',
  unsupportedCapability: 'unsupported_capability',
  directoryUnavailable: 'directory_unavailable',
  homeUnavailable: 'home_unavailable',
  invalidAssertionSignature: 'invalid_assertion_signature',
  invalidIssuer: 'invalid_issuer',
  invalidSubject: 'invalid_subject',
  invalidAudience: 'invalid_audience',
  invalidClientKey: 'invalid_client_key',
  assertionExpired: 'assertion_expired',
  assertionClockSkew: 'assertion_clock_skew',
  directoryLinkNotFound: 'directory_link_not_found',
  approvalRequired: 'approval_required',
} as const;

export const AccountDirectoryErrorCodeV1Schema = z.enum([
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.unsupportedVersion,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.unsupportedCapability,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryUnavailable,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.homeUnavailable,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAssertionSignature,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidIssuer,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidSubject,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAudience,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidClientKey,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionExpired,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionClockSkew,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryLinkNotFound,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalRequired,
]);
export type AccountDirectoryErrorCodeV1 = z.infer<typeof AccountDirectoryErrorCodeV1Schema>;

/** Error bodies intentionally contain no bearer, assertion, key, or account fields. */
export const AccountDirectoryRouteErrorResponseV1Schema = z.object({
  error: AccountDirectoryErrorCodeV1Schema,
}).strict();
export type AccountDirectoryRouteErrorResponseV1 = z.infer<typeof AccountDirectoryRouteErrorResponseV1Schema>;

/**
 * Safe diagnostic projection: authority-bearing values are deliberately omitted.
 * This is for logs/errors only and is not a wire DTO.
 */
export function redactHomeLoginAssertionV1(input: unknown): Readonly<Record<string, unknown>> {
  const parsed = HomeLoginAssertionV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'invalid_assertion' };
  return {
    v: 1,
    issuerServerIdentityId: parsed.data.issuerServerIdentityId,
    issuerSubjectId: parsed.data.issuerSubjectId,
    audienceHomeServerIdentityId: parsed.data.audienceHomeServerIdentityId,
    issuedAtMs: parsed.data.issuedAtMs,
    expiresAtMs: parsed.data.expiresAtMs,
    keyId: parsed.data.keyId,
    clientBoxPublicKeyBase64: '[REDACTED]',
    signatureBase64Url: '[REDACTED]',
  };
}
