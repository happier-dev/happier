import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ProviderAccountUsageQuotaScopeV1Schema } from './providerAccountUsageQuotaScopeV1.js';
import {
  ConnectedAccountMaterializationDestinationsSchema,
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeV1Schema,
} from './connectedAccountPurposes.js';
import {
  ConnectedServiceAuthGroupIdSchema,
} from './connectedServiceBindings.js';
import { ConnectedServiceLimitCategoryCanonicalV1Schema } from './connectedServiceLimitCategory.js';
import { ConnectedServiceCredentialRevisionV1Schema } from './connectedServiceSchemas.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER =
  'x-happier-connected-account-capability' as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION = 2 as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH = 256 as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH =
  '/connected-accounts/request-auth/lookup' as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH =
  '/connected-accounts/request-auth/auth-failure' as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH =
  '/connected-accounts/request-auth/quota-failure' as const;

/**
 * The closed error vocabulary of the local request-auth HTTP transport. The
 * daemon may classify internal service failures more finely, but none of that
 * internal detail crosses this capability-scoped boundary.
 */
export const ConnectedAccountRequestAuthErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'request_auth_unauthorized',
  'request_auth_purpose_forbidden',
  'request_auth_not_active',
  'request_auth_unavailable',
]));
export type ConnectedAccountRequestAuthErrorCodeV1 = z.infer<
  typeof ConnectedAccountRequestAuthErrorCodeV1Schema
>;

export const CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1: Readonly<Record<
  ConnectedAccountRequestAuthErrorCodeV1,
  401 | 403 | 409 | 503
>> = Object.freeze({
  request_auth_unauthorized: 401,
  request_auth_purpose_forbidden: 403,
  request_auth_not_active: 409,
  request_auth_unavailable: 503,
} as const);

export function getConnectedAccountRequestAuthErrorHttpStatusV1(
  code: ConnectedAccountRequestAuthErrorCodeV1,
): 401 | 403 | 409 | 503 {
  return CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1[code];
}

export const ConnectedAccountRequestAuthErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: ConnectedAccountRequestAuthErrorCodeV1Schema,
  }),
}));

const RequestAuthHeaderNameSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128), z.regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u)));
// Preserve the former accessToken bound after including its Bearer scheme.
const RequestAuthHeaderValueSchema = lazyZodSchema(() => z.string().check(z.maxLength(128 * 1024 + 'Bearer '.length), z.refine((value) => !/[\r\n]/u.test(value), 'Header values cannot contain line breaks.')));

const ConnectedAccountRequestAuthCanonicalHttpsOriginV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(2_048), z.superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Request-auth origin must be a valid URL.',
      });
      return;
    }
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || value !== url.origin
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Request-auth origin must be an exact canonical HTTPS origin.',
      });
    }
  })));

const ConnectedAccountRequestAuthHeaderNameV1Schema = lazyZodSchema(() => RequestAuthHeaderNameSchema.check(z.regex(/^[a-z0-9!#$%&'*+\-.^_`|~]+$/u)));

export const ConnectedAccountRequestAuthMaterializationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('httpHeaders'),
  origin: ConnectedAccountRequestAuthCanonicalHttpsOriginV1Schema,
  headerNames: z.readonly(z.array(ConnectedAccountRequestAuthHeaderNameV1Schema).check(z.minLength(1), z.maxLength(32))),
  queryParameterNames: z.optional(ConnectedAccountMaterializationDestinationsSchema),
}).check(z.superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, headerName] of value.headerNames.entries()) {
    if (seen.has(headerName)) {
      context.addIssue({
        code: 'custom',
        path: ['headerNames', index],
        message: 'Request-auth materialization header names must be unique.',
      });
    }
    seen.add(headerName);
  }
})));

export const ConnectedAccountRequestAuthUseV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: ConnectedAccountPurposeIdSchema,
  materialization: ConnectedAccountRequestAuthMaterializationV1Schema,
}));

export const ConnectedAccountRequestAuthUsesV1Schema = lazyZodSchema(() => z.array(
  ConnectedAccountRequestAuthUseV1Schema,
).check(z.maxLength(32), z.superRefine((uses, context) => {
  const seenPurposes = new Set<string>();
  for (const [index, use] of uses.entries()) {
    if (seenPurposes.has(use.purpose)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'purpose'],
        message: 'Connected-account request-auth purposes must be unique within one consumer.',
      });
    }
    seenPurposes.add(use.purpose);
  }
})));

export const QualifiedConnectedAccountRequestAuthUseV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  materialization: ConnectedAccountRequestAuthMaterializationV1Schema,
}));

export const QualifiedConnectedAccountRequestAuthUsesV1Schema = lazyZodSchema(() => z.array(
  QualifiedConnectedAccountRequestAuthUseV1Schema,
).check(z.maxLength(32), z.superRefine((uses, context) => {
  const seenPurposes = new Set<string>();
  for (const [index, use] of uses.entries()) {
    const purposeKey = JSON.stringify([
      use.purpose.consumer.pluginId,
      use.purpose.consumer.localId,
      use.purpose.purpose,
    ]);
    if (seenPurposes.has(purposeKey)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'purpose'],
        message: 'Qualified connected-account request-auth purposes must be unique.',
      });
    }
    seenPurposes.add(purposeKey);
  }
})));

export const RequestAuthHeaderMapV1Schema = lazyZodSchema(() => z.record(
  RequestAuthHeaderNameSchema,
  RequestAuthHeaderValueSchema,
).check(z.superRefine((headers, context) => {
  const names = Object.keys(headers);
  if (names.length > 32) {
    context.addIssue({
      code: 'custom',
      message: 'At most 32 request-auth headers are allowed.',
    });
  }
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (normalized !== 'authorization' && headers[name]!.length > 16 * 1024) {
      context.addIssue({ code: 'custom', path: [name], message: 'Request-auth header exceeds its value bound.' });
    }
    if (seen.has(normalized)) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: 'Request-auth header names must be unique case-insensitively.',
      });
    }
    seen.add(normalized);
  }
})));

const RequestAuthTokenFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u)));

export const RequestAuthCredentialContextV1Schema = lazyZodSchema(() => z.strictObject({
  account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  group: z.optional(z.strictObject({
    groupId: ConnectedServiceAuthGroupIdSchema,
    generation: z.number().check(z.int(), z.nonnegative()),
  })),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  failingAccessTokenFingerprint: z.optional(RequestAuthTokenFingerprintV1Schema),
}));

export const RequestAuthFactsV1Schema = lazyZodSchema(() => z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])));

export const RequestAuthHeadersV1Schema = lazyZodSchema(() => z.strictObject({
  headers: RequestAuthHeaderMapV1Schema,
  facts: RequestAuthFactsV1Schema,
  expiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  credentialContext: RequestAuthCredentialContextV1Schema,
}));

export const ConnectedAccountRequestAuthLookupRequestV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}));


export const ProviderFailureEvidenceSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('structured'),
}));

export const BoundedProviderFailureEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  httpStatus: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
  providerCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  retryAfterMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(7 * 24 * 60 * 60 * 1000))),
  resetAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  limitCategory: ConnectedServiceLimitCategoryCanonicalV1Schema,
  quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
  evidenceSource: ProviderFailureEvidenceSourceV1Schema,
}));

const ConnectedAccountAuthenticationFailureV1Schema = lazyZodSchema(() => z.strictObject({
  class: z.literal('authentication'),
  evidence: BoundedProviderFailureEvidenceV1Schema.check(z.refine((evidence) => evidence.limitCategory === 'auth_invalid', 'Authentication failures require the auth_invalid category.')),
}));

const ConnectedAccountQuotaFailureV1Schema = lazyZodSchema(() => z.strictObject({
  class: z.literal('quota'),
  evidence: BoundedProviderFailureEvidenceV1Schema.check(z.refine((evidence) => evidence.limitCategory !== 'auth_invalid', 'Quota failures cannot carry the auth_invalid category.')),
}));

const ConnectedAccountOtherFailureV1Schema = lazyZodSchema(() => z.strictObject({
  class: z.literal('other'),
  evidence: BoundedProviderFailureEvidenceV1Schema.check(z.refine((evidence) => evidence.limitCategory !== 'auth_invalid', 'Other failures cannot carry the auth_invalid category.')),
}));

const ConnectedAccountInsufficientScopeFailureV1Schema = lazyZodSchema(() => z.strictObject({
  class: z.literal('insufficient_scope'),
  requiredScopes: z.array(z.string().check(z.minLength(1))),
  evidence: BoundedProviderFailureEvidenceV1Schema.check(z.refine((evidence) => evidence.limitCategory === 'validation_failed', 'Scope challenges require validation_failed evidence, not token or quota recovery.')),
}));

export const ConnectedAccountConsumerFailureV1Schema = lazyZodSchema(() => z.union([
  ConnectedAccountAuthenticationFailureV1Schema,
  ConnectedAccountQuotaFailureV1Schema,
  ConnectedAccountOtherFailureV1Schema,
  ConnectedAccountInsufficientScopeFailureV1Schema,
]));

export const ConnectedAccountAuthFailureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  credentialContext: RequestAuthCredentialContextV1Schema,
  normalizedFailure: z.union([ConnectedAccountAuthenticationFailureV1Schema, ConnectedAccountInsufficientScopeFailureV1Schema]),
}));

export const ConnectedAccountQuotaFailureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  credentialContext: RequestAuthCredentialContextV1Schema,
  normalizedFailure: ConnectedAccountQuotaFailureV1Schema,
}));

export const RequestAuthFailureOutcomeV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum([
    'stale_context',
    'current_unchanged',
    'current_changed',
    'denied',
  ]),
}));

export const ConnectedAccountRequestAuthLookupSuccessResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  value: RequestAuthHeadersV1Schema,
}));

export const ConnectedAccountRequestAuthFailureSuccessResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  value: RequestAuthFailureOutcomeV1Schema,
}));

export type RequestAuthFactsV1 = z.infer<typeof RequestAuthFactsV1Schema>;
export type RequestAuthHeaderMapV1 = z.infer<typeof RequestAuthHeaderMapV1Schema>;
export type ConnectedAccountRequestAuthMaterializationV1 = Readonly<{
  kind: 'httpHeaders';
  origin: string;
  headerNames: readonly string[];
  queryParameterNames?: readonly string[];
}>;
export type ConnectedAccountRequestAuthUseV1 = Readonly<{
  purpose: z.infer<typeof ConnectedAccountPurposeIdSchema>;
  materialization: ConnectedAccountRequestAuthMaterializationV1;
}>;
export type QualifiedConnectedAccountRequestAuthUseV1 = Readonly<{
  purpose: z.infer<typeof QualifiedConnectedAccountPurposeV1Schema>;
  materialization: ConnectedAccountRequestAuthMaterializationV1;
}>;
export type RequestAuthCredentialContextV1 = z.infer<typeof RequestAuthCredentialContextV1Schema>;
export type RequestAuthHeadersV1 = z.infer<typeof RequestAuthHeadersV1Schema>;
export type ConnectedAccountRequestAuthLookupRequestV1 = z.infer<
  typeof ConnectedAccountRequestAuthLookupRequestV1Schema
>;
export type BoundedProviderFailureEvidenceV1 = z.infer<typeof BoundedProviderFailureEvidenceV1Schema>;
export type ProviderFailureEvidenceSourceV1 = z.infer<typeof ProviderFailureEvidenceSourceV1Schema>;
export type ConnectedAccountConsumerFailureV1 = z.infer<typeof ConnectedAccountConsumerFailureV1Schema>;
export type ConnectedAccountAuthFailureRequestV1 = z.infer<
  typeof ConnectedAccountAuthFailureRequestV1Schema
>;
export type ConnectedAccountQuotaFailureRequestV1 = z.infer<
  typeof ConnectedAccountQuotaFailureRequestV1Schema
>;
export type RequestAuthFailureOutcomeV1 = z.infer<typeof RequestAuthFailureOutcomeV1Schema>;
