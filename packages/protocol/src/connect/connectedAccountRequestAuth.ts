import { z } from 'zod';

import { ProviderAccountUsageQuotaScopeV1Schema } from './providerAccountUsageQuotaScopeV1.js';
import {
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeV1Schema,
} from './connectedAccountPurposes.js';
import {
  ConnectedServiceAuthGroupIdSchema,
} from './connectedServiceBindings.js';
import { ConnectedServiceLimitCategoryCanonicalV1Schema } from './connectedServiceLimitCategory.js';
import { ConnectedServiceCredentialRevisionV1Schema } from './connectedServiceSchemas.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';

export const CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH =
  '/connected-accounts/request-auth/lookup' as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH =
  '/connected-accounts/request-auth/auth-failure' as const;
export const CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH =
  '/connected-accounts/request-auth/quota-failure' as const;

export const PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1 = [
  '0.81.0',
  '0.81.1',
  '0.82.0',
  '0.82.1',
] as const;

export const PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1 = Object.freeze({
  openAiCodexChatgptUsageLimit: 'openai-codex-chatgpt-usage-limit-v1',
  anthropicAccountExhaustion: 'anthropic-sdk-429-account-exhaustion-v1',
  anthropicRateLimit: 'anthropic-sdk-429-rate-limit-v1',
  anthropicAuthentication: 'anthropic-sdk-401-authentication-v1',
  anthropicOverloaded: 'anthropic-sdk-529-overloaded-v1',
  anthropicApiError500: 'anthropic-sdk-500-api-error-v1',
  anthropicApiError502: 'anthropic-sdk-502-api-error-v1',
  anthropicApiError503: 'anthropic-sdk-503-api-error-v1',
  anthropicApiError504: 'anthropic-sdk-504-api-error-v1',
} as const);

/**
 * Exact private-wire identities and canonical outcomes for Pi terminal evidence.
 *
 * Provider formatting and Pi retry-predicate matching remain owned by Plugin SDK's canonical
 * provider-limit classifier. This projection prevents a capability holder from inventing a
 * producer/provider/signature tuple or pairing a retained signature with a different category,
 * scope, or observed status at the daemon boundary.
 */
export const PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1 = Object.freeze([
  Object.freeze({
    provider: 'openai-codex',
    signatureId:
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.openAiCodexChatgptUsageLimit,
    httpStatus: 429,
    limitCategory: 'usage_limit',
    quotaScope: 'account',
  }),
  Object.freeze({
    provider: 'anthropic',
    signatureId:
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAccountExhaustion,
    httpStatus: 429,
    limitCategory: 'usage_limit',
    quotaScope: 'account',
  }),
  Object.freeze({
    provider: 'anthropic',
    signatureId: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicRateLimit,
    httpStatus: 429,
    limitCategory: 'rate_limit',
    quotaScope: 'unknown',
  }),
  Object.freeze({
    provider: 'anthropic',
    signatureId:
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAuthentication,
    httpStatus: 401,
    limitCategory: 'auth_invalid',
    quotaScope: 'unknown',
  }),
  Object.freeze({
    provider: 'anthropic',
    signatureId: PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicOverloaded,
    httpStatus: 529,
    limitCategory: 'capacity',
    quotaScope: 'unknown',
  }),
  ...([
    [
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError500,
      500,
    ],
    [
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError502,
      502,
    ],
    [
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError503,
      503,
    ],
    [
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError504,
      504,
    ],
  ] as const).map(([signatureId, httpStatus]) => Object.freeze({
    provider: 'anthropic' as const,
    signatureId,
    httpStatus,
    limitCategory: 'capacity' as const,
    quotaScope: 'unknown' as const,
  })),
] as const);

const RequestAuthAccessTokenSchema = z.string().min(1).max(128 * 1024);
const RequestAuthHeaderNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u);
const RequestAuthHeaderValueSchema = z.string()
  .max(16 * 1024)
  .refine((value) => !/[\r\n]/u.test(value), 'Header values cannot contain line breaks.');

const ConnectedAccountRequestAuthCanonicalHttpsOriginV1Schema = z.string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
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
  });

const ConnectedAccountRequestAuthHeaderNameV1Schema = RequestAuthHeaderNameSchema
  .regex(/^[a-z0-9!#$%&'*+\-.^_`|~]+$/u);

export const ConnectedAccountRequestAuthMaterializationV1Schema = z.object({
  kind: z.literal('httpHeaders'),
  origin: ConnectedAccountRequestAuthCanonicalHttpsOriginV1Schema,
  headerNames: z.array(ConnectedAccountRequestAuthHeaderNameV1Schema)
    .min(1)
    .max(32),
}).strict().superRefine((value, context) => {
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
  if (!seen.has('authorization')) {
    context.addIssue({
      code: 'custom',
      path: ['headerNames'],
      message: 'Request-auth materialization must request authorization.',
    });
  }
});

export const ConnectedAccountRequestAuthUseV1Schema = z.object({
  purpose: ConnectedAccountPurposeIdSchema,
  materialization: ConnectedAccountRequestAuthMaterializationV1Schema,
}).strict();

export const ConnectedAccountRequestAuthUsesV1Schema = z.array(
  ConnectedAccountRequestAuthUseV1Schema,
).max(32).superRefine((uses, context) => {
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
});

export const QualifiedConnectedAccountRequestAuthUseV1Schema = z.object({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  materialization: ConnectedAccountRequestAuthMaterializationV1Schema,
}).strict();

export const QualifiedConnectedAccountRequestAuthUsesV1Schema = z.array(
  QualifiedConnectedAccountRequestAuthUseV1Schema,
).max(32).superRefine((uses, context) => {
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
});

export const RequestAuthRequiredHeadersV1Schema = z.record(
  RequestAuthHeaderNameSchema,
  RequestAuthHeaderValueSchema,
).superRefine((headers, context) => {
  const names = Object.keys(headers);
  if (names.length > 32) {
    context.addIssue({
      code: 'custom',
      message: 'At most 32 required request-auth headers are allowed.',
    });
  }
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization') {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: 'Authorization is owned by accessToken.',
      });
    }
    if (seen.has(normalized)) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: 'Required request-auth header names must be unique case-insensitively.',
      });
    }
    seen.add(normalized);
  }
});

const RequestAuthTokenFingerprintV1Schema = z.string()
  .regex(/^sha256:[a-f0-9]{64}$/u);

export const RequestAuthCredentialContextV1Schema = z.object({
  account: QualifiedConnectedAccountRefSchema,
  group: z.object({
    groupId: ConnectedServiceAuthGroupIdSchema,
    generation: z.number().int().nonnegative(),
  }).strict().optional(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  failingAccessTokenFingerprint: RequestAuthTokenFingerprintV1Schema.optional(),
}).strict();

export const OAuthBearerLeaseV1Schema = z.object({
  accessToken: RequestAuthAccessTokenSchema,
  requiredHeaders: RequestAuthRequiredHeadersV1Schema.optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  credentialContext: RequestAuthCredentialContextV1Schema,
}).strict();

export const ConnectedAccountRequestAuthLookupRequestV1Schema = z.object({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}).strict();


export const ProviderFailureEvidenceSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('structured'),
  }).strict(),
  z.object({
    kind: z.literal('pinnedProviderTerminal'),
    producer: z.literal('pi'),
    producerVersion: z.enum(PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1),
    provider: z.enum(['anthropic', 'openai-codex']),
    signatureId: z.enum([
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.openAiCodexChatgptUsageLimit,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAccountExhaustion,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicRateLimit,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicAuthentication,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicOverloaded,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError500,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError502,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError503,
      PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURE_IDS_V1.anthropicApiError504,
    ]),
  }).strict(),
]);

export const BoundedProviderFailureEvidenceV1Schema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerCode: z.string().trim().min(1).max(128).optional(),
  retryAfterMs: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1000).optional(),
  resetAtMs: z.number().int().nonnegative().optional(),
  limitCategory: ConnectedServiceLimitCategoryCanonicalV1Schema,
  quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
  evidenceSource: ProviderFailureEvidenceSourceV1Schema,
}).strict().superRefine((evidence, context) => {
  const evidenceSource = evidence.evidenceSource;
  if (evidenceSource.kind !== 'pinnedProviderTerminal') return;
  const signature = PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1.find((candidate) => (
    candidate.provider === evidenceSource.provider
    && candidate.signatureId === evidenceSource.signatureId
  ));
  if (
    !signature
    || signature.limitCategory !== evidence.limitCategory
    || signature.quotaScope !== evidence.quotaScope
    || (
      evidence.httpStatus !== undefined
      && signature.httpStatus !== evidence.httpStatus
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceSource'],
      message: 'Pinned Provider terminal evidence must match the retained Pi signature frontier.',
    });
  }
});

const ConnectedAccountAuthenticationFailureV1Schema = z.object({
  class: z.literal('authentication'),
  evidence: BoundedProviderFailureEvidenceV1Schema.refine(
    (evidence) => evidence.limitCategory === 'auth_invalid',
    'Authentication failures require the auth_invalid category.',
  ),
}).strict();

const ConnectedAccountQuotaFailureV1Schema = z.object({
  class: z.literal('quota'),
  evidence: BoundedProviderFailureEvidenceV1Schema.refine(
    (evidence) => evidence.limitCategory !== 'auth_invalid',
    'Quota failures cannot carry the auth_invalid category.',
  ),
}).strict();

const ConnectedAccountOtherFailureV1Schema = z.object({
  class: z.literal('other'),
  evidence: BoundedProviderFailureEvidenceV1Schema.refine(
    (evidence) => evidence.limitCategory !== 'auth_invalid',
    'Other failures cannot carry the auth_invalid category.',
  ),
}).strict();

export const ConnectedAccountConsumerFailureV1Schema = z.union([
  ConnectedAccountAuthenticationFailureV1Schema,
  ConnectedAccountQuotaFailureV1Schema,
  ConnectedAccountOtherFailureV1Schema,
]);

export const ConnectedAccountAuthFailureRequestV1Schema = z.object({
  credentialContext: RequestAuthCredentialContextV1Schema,
  normalizedFailure: ConnectedAccountAuthenticationFailureV1Schema,
}).strict();

export const ConnectedAccountQuotaFailureRequestV1Schema = z.object({
  credentialContext: RequestAuthCredentialContextV1Schema,
  normalizedFailure: ConnectedAccountQuotaFailureV1Schema,
}).strict();

export const RequestAuthFailureOutcomeV1Schema = z.object({
  status: z.enum([
    'stale_context',
    'current_unchanged',
    'current_changed',
    'denied',
  ]),
}).strict();

export type RequestAuthRequiredHeadersV1 = z.infer<typeof RequestAuthRequiredHeadersV1Schema>;
export type ConnectedAccountRequestAuthMaterializationV1 = Readonly<{
  kind: 'httpHeaders';
  origin: string;
  headerNames: readonly string[];
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
export type OAuthBearerLeaseV1 = z.infer<typeof OAuthBearerLeaseV1Schema>;
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
