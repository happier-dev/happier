import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import {
  computeCanonicalDomainSeparatedDigest,
  encodeCanonicalLengthDelimited,
} from '../crypto/canonicalDigest.js';
import { BOX_BUNDLE_MIN_BYTES } from '../crypto/boxBundleFormat.js';
import {
  normalizeServerIdentityIdCapability,
  SERVER_IDENTITY_ID_PATTERN,
} from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { isLoopbackHostname } from '../server/urls/loopbackHostname.js';
import {
  IrohEndpointDescriptorV1Schema,
  IrohEndpointIdV1Schema,
} from '../connectivity/iroh/endpointDescriptorV1.js';

export {
  IrohEndpointDescriptorV1Schema,
  parseIrohEndpointDescriptorV1,
  type IrohEndpointDescriptorV1,
} from '../connectivity/iroh/endpointDescriptorV1.js';
export { AccountDirectoryCapabilitiesSchema } from '../features/payload/capabilities/accountDirectoryCapabilities.js';
export type { AccountDirectoryCapabilities } from '../features/payload/capabilities/accountDirectoryCapabilities.js';

/** The assertion is signed independently from ordinary account/session tokens. */
export const ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1 =
  'happier.account-directory.home-login.v1' as const;
export const ACCOUNT_DIRECTORY_CREDENTIAL_DESTINATION_DIGEST_DOMAIN_V1 =
  'happier.account-directory.home-login.credential-destination.v1' as const;

export const ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1 = '/v1/account-directory/me' as const;
export const ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1 = '/v1/account-directory/homes' as const;
export const ACCOUNT_DIRECTORY_HOME_HTTP_PATH_V1 =
  '/v1/account-directory/homes/:homeServerIdentityId' as const;
export const ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1 =
  '/v1/account-directory/homes/preferred' as const;
export const ACCOUNT_DIRECTORY_HOME_LOGIN_ASSERTION_HTTP_PATH_V1 =
  '/v1/account-directory/homes/:homeServerIdentityId/login-assertion' as const;
export const ACCOUNT_DIRECTORY_LINKS_HTTP_PATH_V1 =
  '/v1/account/directory-links/:issuerServerIdentityId' as const;
export const HOME_LOGIN_HTTP_PATH_V1 = '/v1/auth/home-login' as const;
export const HOME_LOGIN_APPROVALS_HTTP_PATH_V1 = '/v1/auth/home-login/approvals' as const;
export const HOME_LOGIN_APPROVAL_DECISION_HTTP_PATH_V1 =
  '/v1/auth/home-login/approvals/:approvalId/decision' as const;

export function buildAccountDirectoryHomeHttpPathV1(homeServerIdentityId: string): string {
  return `${ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1}/${encodeURIComponent(homeServerIdentityId)}`;
}

export function buildAccountDirectoryHomeLoginAssertionHttpPathV1(
  homeServerIdentityId: string,
): string {
  return `${buildAccountDirectoryHomeHttpPathV1(homeServerIdentityId)}/login-assertion`;
}

export function buildAccountDirectoryLinkHttpPathV1(issuerServerIdentityId: string): string {
  return `/v1/account/directory-links/${encodeURIComponent(issuerServerIdentityId)}`;
}

export function buildHomeLoginApprovalDecisionHttpPathV1(approvalId: string): string {
  return `${HOME_LOGIN_APPROVALS_HTTP_PATH_V1}/${encodeURIComponent(approvalId)}/decision`;
}

export const ACCOUNT_DIRECTORY_ASSERTION_MIN_LIFETIME_MS = 2 * 60 * 1000;
export const ACCOUNT_DIRECTORY_ASSERTION_MAX_LIFETIME_MS = 5 * 60 * 1000;
/** Redemption may apply this bounded skew; schema validation remains clock-independent. */
export const ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS = 30 * 1000;

export const ACCOUNT_DIRECTORY_MAX_ENDPOINTS = 16;
export const ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES = 128;
export const ACCOUNT_DIRECTORY_MAX_ID_UTF8_BYTES = 256;
export const ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES = 512;
/** Existing ordinary Home-token boundary shared with direct enrollment. */
export const ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES = 4_096;
const UTF8_ENCODER = new TextEncoder();
/**
 * JSON.stringify escape worst case: a raw byte can expand to a six-byte
 * `\uXXXX` escape. Token and URL strings are admitted as arbitrary bounded
 * text, so it takes the full 6× allowance.
 */
const JSON_STRING_ESCAPE_MAX_BYTES_PER_UTF8_BYTE = 6;

const HOME_LOGIN_CREDENTIAL_SERIALIZATION_OVERHEAD_BYTES = UTF8_ENCODER.encode(
  JSON.stringify({ token: '' }),
).byteLength;

/**
 * Conservative bound for the locked strict `{ token }` plaintext, including
 * JSON string escaping. It is a malformed-input allocation boundary, not a quota.
 */
export const ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES =
  HOME_LOGIN_CREDENTIAL_SERIALIZATION_OVERHEAD_BYTES
  + JSON_STRING_ESCAPE_MAX_BYTES_PER_UTF8_BYTE * ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES;
/**
 * Maximum decoded box-bundle bytes. This protects response parsing/allocation;
 * encoded base64url length is derived by `strictEncodedBytes`, not a second limit.
 */
export const ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES =
  ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES + BOX_BUNDLE_MIN_BYTES;

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * Application endpoint policy for Home enrollment and canonical Home URLs.
 * Account Service endpoint parsing is a separate client-owned contract.
 */
export const HomeApplicationOriginV1Schema = z.string()
  .trim()
  .min(1)
  .max(ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL exceeds its UTF-8 byte limit' });
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Home application URL must use HTTPS or loopback HTTP' });
      }
      if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Home application URL must not contain credentials, a query, or a fragment' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'URL must be absolute' });
    }
  });
export type HomeApplicationOriginV1 = z.infer<typeof HomeApplicationOriginV1Schema>;

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
const Sha256DigestBase64UrlSchema = strictEncodedBytes('base64url', 32, 32);
const SealedHomeTokenBase64UrlSchema = strictEncodedBytes(
  'base64url',
  undefined,
  ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES,
);

const PositiveRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TimestampMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The Iroh endpoint sub-descriptor is owned by the shared connectivity module
// (`connectivity/iroh/endpointDescriptorV1.ts`) and re-exported above; the
// union variant below composes it without redefining the wire shape.
const HttpsEndpointDescriptorV1Schema = z.object({
  kind: z.literal('https'),
  url: HomeApplicationOriginV1Schema,
}).strict();

export const HomeConnectionEndpointV1Schema = z.discriminatedUnion('kind', [
  HttpsEndpointDescriptorV1Schema,
  // Extend keeps the canonical schema's strict/unknown-field rejection while
  // adding the outer endpoint-union discriminant.
  IrohEndpointDescriptorV1Schema.extend({ kind: z.literal('iroh') }),
]);
export type HomeConnectionEndpointV1 = z.infer<typeof HomeConnectionEndpointV1Schema>;

export const HomeConnectionDescriptorV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: HomeApplicationOriginV1Schema,
  revision: PositiveRevisionSchema,
  endpoints: z.array(HomeConnectionEndpointV1Schema)
    .min(1)
    .max(ACCOUNT_DIRECTORY_MAX_ENDPOINTS),
}).strict();
export type HomeConnectionDescriptorV1 = z.infer<typeof HomeConnectionDescriptorV1Schema>;

/** Device-persisted read projection only; live descriptor admission remains strict. */
export const StoredHomeConnectionDescriptorV1Schema = createStoredReadSchema(HomeConnectionDescriptorV1Schema);

function normalizeHomeApplicationOriginV1(value: string): string {
  return new URL(HomeApplicationOriginV1Schema.parse(value)).toString().replace(/\/+$/u, '');
}

function isCanonicalHomeApplicationOriginV1(value: string): boolean {
  try {
    return value === new URL(value).toString().replace(/\/+$/u, '');
  } catch {
    return false;
  }
}

function isCanonicalSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const CanonicalHomeApplicationOriginV1Schema = HomeApplicationOriginV1Schema.refine(
  isCanonicalHomeApplicationOriginV1,
  'Home application URL must use its canonical URL serialization',
);

export const HomeCredentialDestinationV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: CanonicalHomeApplicationOriginV1Schema,
  applicationEndpointUrls: z.array(CanonicalHomeApplicationOriginV1Schema)
    .max(ACCOUNT_DIRECTORY_MAX_ENDPOINTS)
    .refine(isCanonicalSortedUnique, 'Application endpoint URLs must be sorted and unique'),
  irohEndpointIds: z.array(IrohEndpointIdV1Schema)
    .max(ACCOUNT_DIRECTORY_MAX_ENDPOINTS)
    .refine(isCanonicalSortedUnique, 'Iroh endpoint IDs must be sorted and unique'),
}).strict();
export type HomeCredentialDestinationV1 = z.infer<typeof HomeCredentialDestinationV1Schema>;

export type HomeCredentialDestinationSelectionV1 =
  | Readonly<{ kind: 'https'; applicationUrl: string }>
  | Readonly<{ kind: 'iroh'; endpointId: string }>;

/**
 * Canonical authority projection for every destination capable of receiving a
 * Home credential. Routing hints and publication revision are deliberately excluded.
 */
export function createHomeCredentialDestinationV1(
  descriptor: HomeConnectionDescriptorV1,
): HomeCredentialDestinationV1 {
  const parsed = HomeConnectionDescriptorV1Schema.parse(descriptor);
  const applicationEndpointUrls = [...new Set(parsed.endpoints
    .filter((endpoint): endpoint is Extract<HomeConnectionEndpointV1, { kind: 'https' }> => endpoint.kind === 'https')
    .map((endpoint) => normalizeHomeApplicationOriginV1(endpoint.url)))]
    .sort();
  const irohEndpointIds = [...new Set(parsed.endpoints
    .filter((endpoint): endpoint is Extract<HomeConnectionEndpointV1, { kind: 'iroh' }> => endpoint.kind === 'iroh')
    .map((endpoint) => endpoint.endpointId))]
    .sort();

  return HomeCredentialDestinationV1Schema.parse({
    v: 1,
    homeServerIdentityId: parsed.homeServerIdentityId,
    canonicalServerUrl: normalizeHomeApplicationOriginV1(parsed.canonicalServerUrl),
    applicationEndpointUrls,
    irohEndpointIds,
  });
}

export function createHomeCredentialDestinationDigestV1(
  descriptor: HomeConnectionDescriptorV1,
): string {
  const destination = createHomeCredentialDestinationV1(descriptor);
  return Sha256DigestBase64UrlSchema.parse(computeCanonicalDomainSeparatedDigest(
    ACCOUNT_DIRECTORY_CREDENTIAL_DESTINATION_DIGEST_DOMAIN_V1,
    [
      String(destination.v),
      destination.homeServerIdentityId,
      destination.canonicalServerUrl,
      'https',
      String(destination.applicationEndpointUrls.length),
      ...destination.applicationEndpointUrls,
      'iroh',
      String(destination.irohEndpointIds.length),
      ...destination.irohEndpointIds,
    ],
  ));
}

/**
 * Checks the concrete carrier destination selected by a client against the
 * canonical assertion-bound projection. Runtime loopback origins and Iroh
 * routing hints are intentionally not valid credential destinations.
 */
export function isHomeCredentialDestinationAllowedV1(
  destination: HomeCredentialDestinationV1,
  selected: HomeCredentialDestinationSelectionV1,
): boolean {
  const parsedDestination = HomeCredentialDestinationV1Schema.safeParse(destination);
  if (!parsedDestination.success) return false;
  if (selected.kind === 'iroh') {
    const parsedEndpointId = IrohEndpointIdV1Schema.safeParse(selected.endpointId);
    return parsedEndpointId.success
      && parsedDestination.data.irohEndpointIds.includes(parsedEndpointId.data);
  }
  try {
    return parsedDestination.data.applicationEndpointUrls.includes(
      normalizeHomeApplicationOriginV1(selected.applicationUrl),
    );
  } catch {
    return false;
  }
}

const HomeLoginTokenV1Schema = z.string().trim().min(1).max(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES)
  .superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_TOKEN_UTF8_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Home token exceeds its UTF-8 byte limit' });
    }
  });

/** Exact strict sealed plaintext. Descriptor and legacy credential envelopes fail closed. */
export const HomeLoginCredentialPayloadV1Schema = z.object({
  token: HomeLoginTokenV1Schema,
}).strict().superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Home credential payload exceeds its plaintext byte limit' });
  }
});
export type HomeLoginCredentialPayloadV1 = z.infer<typeof HomeLoginCredentialPayloadV1Schema>;

const AccountDirectoryHomeIdentityFieldsSchema = z.object({
  homeServerIdentityId: ServerIdentityIdSchema,
  canonicalServerUrl: HomeApplicationOriginV1Schema,
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
  canonicalServerUrl: HomeApplicationOriginV1Schema,
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
  homes: z.array(AccountDirectoryHomeEntryV1Schema),
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
  if (preferred === null && preferredEntries.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['homes'], message: 'No Home may be marked preferred when the preferred pointer is null' });
  }
  if (preferred !== null && preferredEntries.length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['homes'], message: 'Exactly one Home must be marked preferred when the preferred pointer is set' });
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
  /**
   * How this Account's recovery key can be reached, from its stored mode: `none` for a Plain Account
   * (it has no key), `password_unlock` for an E2EE Account with a password envelope, `key_only` for
   * an E2EE Account without one. Absent from servers that predate it; clients then offer nothing.
   */
  recoveryKey: z.enum(['none', 'password_unlock', 'key_only']).optional(),
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
  credentialDestinationDigestBase64Url: Sha256DigestBase64UrlSchema,
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
    ACCOUNT_DIRECTORY_ASSERTION_SIGNING_DOMAIN_V1,
    String(parsed.v),
    parsed.purpose,
    parsed.issuerServerIdentityId,
    parsed.issuerSubjectId,
    parsed.audienceHomeServerIdentityId,
    parsed.credentialDestinationDigestBase64Url,
    parsed.clientBoxPublicKeyBase64,
    String(parsed.issuedAtMs),
    String(parsed.expiresAtMs),
    parsed.keyId,
  ]);
}

const HOME_LOGIN_REQUESTER_FINGERPRINT_DOMAIN_V1 =
  'happier.account-directory.requester-fingerprint.v1' as const;

/**
 * Stable advisory label for an assertion-bound requester key. It is deliberately
 * truncated for display and must never be used as identity or authorization.
 */
export function createHomeLoginRequesterFingerprintV1(
  clientBoxPublicKeyBase64: string,
): string {
  const canonicalKey = ClientBoxPublicKeyBase64Schema.parse(clientBoxPublicKeyBase64);
  const digest = computeCanonicalDomainSeparatedDigest(
    HOME_LOGIN_REQUESTER_FINGERPRINT_DOMAIN_V1,
    [decodeBase64(canonicalKey, 'base64')],
  ).slice(0, 16);
  return digest.match(/.{1,4}/gu)!.join('-');
}

export const HomeLoginRedemptionRequestV1Schema = z.object({
  v: z.literal(1),
  assertion: HomeLoginAssertionV1Schema,
  approvalId: BoundedIdentifierSchema.optional(),
}).strict();
export type HomeLoginRedemptionRequestV1 = z.infer<typeof HomeLoginRedemptionRequestV1Schema>;

/**
 * Locked five-field V1 success shape. `expiresAtMs` bounds assertion redemption;
 * it is not the expiry of the durable ordinary Home token inside the sealed envelope.
 * The sealed plaintext is exactly `HomeLoginCredentialPayloadV1`: `{ token }`.
 */
export const HomeLoginRedemptionResponseV1Schema = z.object({
  v: z.literal(1),
  homeServerIdentityId: ServerIdentityIdSchema,
  sealedHomeTokenBase64Url: SealedHomeTokenBase64UrlSchema,
  issuedAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.issuedAtMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAtMs'], message: 'Redemption validity expiry must be after issuance' });
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

export const HomeLoginRedemptionResultV1Schema = z.union([
  HomeLoginRedemptionResponseV1Schema,
  HomeLoginRedemptionApprovalRequiredV1Schema,
]);

export const HomeDeviceApprovalRequestV1Schema = z.object({
  approvalId: BoundedIdentifierSchema,
  accountId: BoundedIdentifierSchema,
  flow: z.literal('account_assertion'),
  requesterBoxPublicKeyBase64: ClientBoxPublicKeyBase64Schema,
  issuerServerIdentityId: ServerIdentityIdSchema,
  issuerSubjectId: BoundedIdentifierSchema,
  deviceLabel: z.string().max(256).nullable(),
  status: z.enum(['pending', 'approved', 'rejected']),
  expiresAtMs: TimestampMsSchema,
  decidedAtMs: TimestampMsSchema.nullable(),
}).strict();
export type HomeDeviceApprovalRequestV1 = z.infer<typeof HomeDeviceApprovalRequestV1Schema>;

/** Lane 05 defines no approval-list cardinality cap; consumers must not invent one. */
export const HomeDeviceApprovalListV1Schema = z.array(HomeDeviceApprovalRequestV1Schema);
export type HomeDeviceApprovalListV1 = z.infer<typeof HomeDeviceApprovalListV1Schema>;

export const HomeDeviceApprovalDecisionRequestV1Schema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict();
export type HomeDeviceApprovalDecisionRequestV1 = z.infer<
  typeof HomeDeviceApprovalDecisionRequestV1Schema
>;

export const HomeDeviceApprovalDecisionResponseV1Schema = z.object({
  status: z.enum(['approved', 'rejected', 'already_decided']),
}).strict();
export type HomeDeviceApprovalDecisionResponseV1 = z.infer<
  typeof HomeDeviceApprovalDecisionResponseV1Schema
>;
export type HomeLoginRedemptionResultV1 = z.infer<typeof HomeLoginRedemptionResultV1Schema>;

export const ACCOUNT_DIRECTORY_ERROR_CODES_V1 = {
  invalidToken: 'invalid_token',
  invalidRequest: 'invalid_request',
  unsupportedVersion: 'unsupported_version',
  unsupportedCapability: 'unsupported_capability',
  directoryUnavailable: 'directory_unavailable',
  homeUnavailable: 'home_unavailable',
  accountDisabled: 'account-disabled',
  invalidAssertionSignature: 'invalid_assertion_signature',
  invalidIssuer: 'invalid_issuer',
  invalidSubject: 'invalid_subject',
  invalidAudience: 'invalid_audience',
  invalidClientKey: 'invalid_client_key',
  assertionExpired: 'assertion_expired',
  assertionClockSkew: 'assertion_clock_skew',
  directoryLinkNotFound: 'directory_link_not_found',
  descriptorRevisionConflict: 'descriptor_revision_conflict',
  approvalRequired: 'approval_required',
  approvalRejected: 'approval_rejected',
  approvalExpired: 'approval_expired',
  approvalInvalid: 'approval_invalid',
  rateLimited: 'rate_limited',
} as const;

export const AccountDirectoryErrorCodeV1Schema = z.enum([
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidToken,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.unsupportedVersion,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.unsupportedCapability,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryUnavailable,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.homeUnavailable,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.accountDisabled,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAssertionSignature,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidIssuer,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidSubject,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAudience,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidClientKey,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionExpired,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionClockSkew,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryLinkNotFound,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.descriptorRevisionConflict,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalRequired,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalRejected,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalExpired,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalInvalid,
  ACCOUNT_DIRECTORY_ERROR_CODES_V1.rateLimited,
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
    credentialDestinationDigestBase64Url: parsed.data.credentialDestinationDigestBase64Url,
    issuedAtMs: parsed.data.issuedAtMs,
    expiresAtMs: parsed.data.expiresAtMs,
    keyId: parsed.data.keyId,
    clientBoxPublicKeyBase64: '[REDACTED]',
    signatureBase64Url: '[REDACTED]',
  };
}
