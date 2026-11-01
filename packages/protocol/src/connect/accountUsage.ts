import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
  type AccountScopedOpenResult,
} from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { ProviderAccountSubscriptionV1Schema } from './accountSubscription.js';
import {
  SealedConnectedServiceQuotaSnapshotV1Schema,
  ConnectedServiceQuotaConfidenceV1Schema,
  ConnectedServiceQuotaMeterV1Schema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
  ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
  ConnectedServiceQuotaSourceV1Schema,
  ConnectedServiceUsageSourceV1Schema,
  type ConnectedServiceQuotaConfidenceV1,
  type ConnectedServiceQuotaRecoveryCreditsV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceQuotaSourceV1,
  type ConnectedServiceUsageSourceV1,
} from './connectedServiceSchemas.js';
import { lazySchema } from '../lazySchema.js';

const encoder = new TextEncoder();

export const ProviderAccountUsageRecordIdSchema = lazySchema(() => z.string().regex(/^paug_v1_[A-Za-z0-9_-]{8,}$/));
export type ProviderAccountUsageRecordId = z.infer<typeof ProviderAccountUsageRecordIdSchema>;

const PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH = 102;
const ProviderAccountUsageOpaqueRefPartSchema = lazySchema(() => z.string()
  .trim()
  .min(1)
  .max(PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/));

function isPathLikeLocalCredentialRef(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('~/')
    || value.startsWith('~\\')
    || value.startsWith('file:')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.includes('\\')
    || value.includes('/');
}

export function buildProviderAccountUsageOpaqueLocalCredentialRef(params: Readonly<{
  providerId: string;
  kind: string;
  value: string;
}>): string {
  const providerId = ProviderAccountUsageOpaqueRefPartSchema.parse(params.providerId);
  const kind = ProviderAccountUsageOpaqueRefPartSchema.parse(params.kind);
  const value = z.string().trim().min(1).max(4096).parse(params.value);
  const digest = sha256(encoder.encode(JSON.stringify({ providerId, kind, value })));
  return `opaque:${providerId}:${kind}:${encodeBase64(digest, 'base64url')}`;
}

export const ProviderAccountUsageSubjectKindV1Schema = lazySchema(() => z.enum([
  'account',
  'workspace',
  'organization',
  'tenant',
  'subscription',
  'project',
  'modelFamily',
  'unknown',
]));
export type ProviderAccountUsageSubjectKindV1 = z.infer<typeof ProviderAccountUsageSubjectKindV1Schema>;

export const ProviderAccountUsageQuotaScopeV1Schema = lazySchema(() => z.enum([
  'account',
  'workspace',
  'organization',
  'project',
  'model',
  'provider',
  'unknown',
]));
export type ProviderAccountUsageQuotaScopeV1 = z.infer<typeof ProviderAccountUsageQuotaScopeV1Schema>;

export const ProviderAccountUsageRecordKeyV1Schema = lazySchema(() => z.object({
  providerId: z.string().trim().min(1).max(128),
  accountSubjectId: z.string().trim().min(1).max(512),
  subjectKind: ProviderAccountUsageSubjectKindV1Schema,
  quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
  quotaScopeId: z.string().trim().min(1).max(256).optional(),
}).strict());
export type ProviderAccountUsageRecordKeyV1 = z.infer<typeof ProviderAccountUsageRecordKeyV1Schema>;

export type ProviderAccountUsageOrganizationContext = Readonly<{
  providerAccountId: string | null;
  providerOrganizationId: string | null;
}>;

/** Compare the account-owned organization allowance across PAU and its quota projection. */
export function isProviderAccountUsageOrganizationContextMatch(
  observed: Pick<ProviderAccountUsageRecordKeyV1, 'accountSubjectId' | 'subjectKind' | 'quotaScope' | 'quotaScopeId'>
    | Pick<ConnectedServiceQuotaSnapshotV1, 'activeAccountId' | 'providerOrganizationId'>,
  current: ProviderAccountUsageOrganizationContext | null,
): boolean {
  if (!current?.providerAccountId || !current.providerOrganizationId) return false;
  if ('quotaScope' in observed) {
    return observed.subjectKind === 'account'
      && observed.quotaScope === 'organization'
      && observed.accountSubjectId === current.providerAccountId
      && observed.quotaScopeId === current.providerOrganizationId;
  }
  return observed.activeAccountId === current.providerAccountId
    && observed.providerOrganizationId === current.providerOrganizationId;
}

export const ProviderAccountSubjectRefV1Schema = lazySchema(() => z.object({
  kind: z.enum(['providerSubject', 'provisionalLocalSubject']),
  id: z.string().trim().min(1).max(512),
  mergeKey: z.string().trim().min(1).max(512).optional(),
}).strict());
export type ProviderAccountSubjectRefV1 = z.infer<typeof ProviderAccountSubjectRefV1Schema>;

export const ProviderAccountUsageSourceV1Schema = lazySchema(() => z.enum([
  'runtimeSignal',
  'providerHttp',
  'proxy',
  'connectedServiceProbe',
  'cached',
  'manual',
  'unknown',
]));
export type ProviderAccountUsageSourceV1 = z.infer<typeof ProviderAccountUsageSourceV1Schema>;

export const ProviderAccountUsageConfidenceV1Schema = lazySchema(() => z.enum(['confirmed', 'estimated', 'unknown']));
export type ProviderAccountUsageConfidenceV1 = z.infer<typeof ProviderAccountUsageConfidenceV1Schema>;

export const ProviderAccountUsageStateV1Schema = lazySchema(() => z.enum([
  'not_loaded',
  'loaded_empty',
  'loaded_data',
  'stale_data',
  'error_last_known_good',
]));
export type ProviderAccountUsageStateV1 = z.infer<typeof ProviderAccountUsageStateV1Schema>;

const SECRET_FIELD_VALUE_PATTERN =
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|password|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i;
const AUTHORIZATION_BEARER_VALUE_PATTERN = /\bauthorization\s*:\s*bearer\s+\S+/i;
const X_API_KEY_HEADER_VALUE_PATTERN = /\bx-api-key\s*:\s*\S{12,}/i;
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/;
const AWS_ACCESS_KEY_VALUE_PATTERN = /\b(?:A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/;
const GITHUB_TOKEN_VALUE_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/;
const OPENAI_SECRET_KEY_VALUE_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{10,}\b/i;

function containsUnsafeProviderAccountUsageDiagnosticText(value: string | undefined): boolean {
  if (!value) return false;
  return SECRET_FIELD_VALUE_PATTERN.test(value)
    || AUTHORIZATION_BEARER_VALUE_PATTERN.test(value)
    || X_API_KEY_HEADER_VALUE_PATTERN.test(value)
    || JWT_VALUE_PATTERN.test(value)
    || AWS_ACCESS_KEY_VALUE_PATTERN.test(value)
    || GITHUB_TOKEN_VALUE_PATTERN.test(value)
    || OPENAI_SECRET_KEY_VALUE_PATTERN.test(value);
}

export const ProviderAccountUsageDiagnosticV1Schema = lazySchema(() => z.object({
  kind: z.enum(['unavailable', 'provider_http', 'runtime_signal', 'projection', 'validation', 'storage', 'unknown']),
  code: z.string().trim().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(512).optional(),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  observedAtMs: z.number().int().nonnegative().optional(),
}).strict().superRefine((diagnostic, ctx) => {
  if (diagnostic.headers) {
    for (const [headerName, headerValue] of Object.entries(diagnostic.headers)) {
      const normalized = headerName.trim().toLowerCase();
      if (
        normalized === 'authorization'
        || normalized === 'proxy-authorization'
        || normalized === 'cookie'
        || normalized === 'set-cookie'
        || normalized.includes('authorization')
        || normalized.includes('token')
        || normalized.includes('secret')
        || normalized.includes('api-key')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unsafe provider account usage diagnostic header',
          path: ['headers', headerName],
        });
      }
      if (containsUnsafeProviderAccountUsageDiagnosticText(headerValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unsafe provider account usage diagnostic header value',
          path: ['headers', headerName],
        });
      }
    }
  }
  if (containsUnsafeProviderAccountUsageDiagnosticText(diagnostic.code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsafe provider account usage diagnostic code',
      path: ['code'],
    });
  }
  if (containsUnsafeProviderAccountUsageDiagnosticText(diagnostic.message)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsafe provider account usage diagnostic message',
      path: ['message'],
    });
  }
}));
export type ProviderAccountUsageDiagnosticV1 = z.infer<typeof ProviderAccountUsageDiagnosticV1Schema>;

export const ProviderAccountUsageSnapshotV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  recordId: ProviderAccountUsageRecordIdSchema,
  recordKey: ProviderAccountUsageRecordKeyV1Schema,
  providerId: z.string().trim().min(1).max(128),
  accountSubject: ProviderAccountSubjectRefV1Schema,
  observedAtMs: z.number().int().nonnegative(),
  fetchedAtMs: z.number().int().nonnegative(),
  staleAfterMs: z.number().int().min(1),
  source: ProviderAccountUsageSourceV1Schema,
  confidence: ProviderAccountUsageConfidenceV1Schema,
  state: ProviderAccountUsageStateV1Schema.default('loaded_data'),
  planLabel: z.string().trim().min(1).max(256).nullable().optional(),
  accountLabel: z.string().trim().min(1).max(256).nullable().optional(),
  recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1Schema.optional(),
  recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.optional(),
  subscription: ProviderAccountSubscriptionV1Schema.optional(),
  meters: z.array(ConnectedServiceQuotaMeterV1Schema),
  diagnostics: z.array(ProviderAccountUsageDiagnosticV1Schema).optional(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.recordId !== buildProviderAccountUsageRecordId(snapshot.recordKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Snapshot recordId must match recordKey',
      path: ['recordId'],
    });
  }
  if (snapshot.providerId !== snapshot.recordKey.providerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Snapshot providerId must match recordKey providerId',
      path: ['providerId'],
    });
  }
  if (snapshot.accountSubject.id !== snapshot.recordKey.accountSubjectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Account subject id must match recordKey accountSubjectId',
      path: ['accountSubject', 'id'],
    });
  }
}));
export type ProviderAccountUsageSnapshotV1 = z.infer<typeof ProviderAccountUsageSnapshotV1Schema>;

/** Remove subscription observations when their feature is disabled. */
export function splitProviderAccountUsageSubscription(snapshot: ProviderAccountUsageSnapshotV1) {
  const { subscription, ...base } = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
  return { snapshot: base, subscription };
}

/** Released strict V1 bodies exclude supplemental facts carried by the outer envelope. */
export function splitProviderAccountUsageSupplementalFacets(snapshot: ProviderAccountUsageSnapshotV1) {
  const { subscription, recoveryCreditDetails, ...base } = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
  return { snapshot: base, subscription, recoveryCreditDetails };
}

export const SealedProviderAccountUsageSnapshotV1Schema = SealedConnectedServiceQuotaSnapshotV1Schema;
export type SealedProviderAccountUsageSnapshotV1 = z.infer<typeof SealedProviderAccountUsageSnapshotV1Schema>;

function canonicalRecordKeyJson(key: ProviderAccountUsageRecordKeyV1): string {
  return JSON.stringify({
    providerId: key.providerId,
    accountSubjectId: key.accountSubjectId,
    subjectKind: key.subjectKind,
    quotaScope: key.quotaScope,
    ...(key.quotaScopeId ? { quotaScopeId: key.quotaScopeId } : {}),
  });
}

export function buildProviderAccountUsageRecordId(key: ProviderAccountUsageRecordKeyV1): ProviderAccountUsageRecordId {
  const parsed = ProviderAccountUsageRecordKeyV1Schema.parse(key);
  const digest = sha256(encoder.encode(canonicalRecordKeyJson(parsed)));
  return ProviderAccountUsageRecordIdSchema.parse(`paug_v1_${encodeBase64(digest, 'base64url')}`);
}

function mapUsageSourceToQuotaSource(source: ProviderAccountUsageSourceV1): ConnectedServiceQuotaSourceV1 {
  const mapped: Record<ProviderAccountUsageSourceV1, ConnectedServiceQuotaSourceV1> = {
    runtimeSignal: 'in_band_provider_snapshot',
    providerHttp: 'provider_api',
    proxy: 'background_fetch',
    connectedServiceProbe: 'user_probe',
    cached: 'cached',
    manual: 'manual_refresh',
    unknown: 'unknown',
  };
  return ConnectedServiceQuotaSourceV1Schema.parse(mapped[source]);
}

function mapUsageConfidenceToQuotaConfidence(confidence: ProviderAccountUsageConfidenceV1): ConnectedServiceQuotaConfidenceV1 {
  const mapped: Record<ProviderAccountUsageConfidenceV1, ConnectedServiceQuotaConfidenceV1> = {
    confirmed: 'exact',
    estimated: 'estimated',
    unknown: 'unknown',
  };
  return ConnectedServiceQuotaConfidenceV1Schema.parse(mapped[confidence]);
}

export function projectProviderAccountUsageToConnectedServiceQuotaSnapshot(
  snapshot: ProviderAccountUsageSnapshotV1,
  source: ConnectedServiceUsageSourceV1,
): ConnectedServiceQuotaSnapshotV1 | null {
  const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
  const parsedSource = ConnectedServiceUsageSourceV1Schema.parse(source);
  const serviceId = parsedSource.serviceId;
  const profileId = parsedSource.profileId;

  return {
    v: 1,
    serviceId,
    profileId,
    fetchedAt: parsed.fetchedAtMs,
    staleAfterMs: parsed.staleAfterMs,
    planLabel: parsed.planLabel ?? null,
    accountLabel: parsed.accountLabel ?? null,
    providerId: parsed.providerId,
    activeAccountId: parsed.recordKey.accountSubjectId,
    ...(parsed.recordKey.quotaScope === 'organization' && parsed.recordKey.quotaScopeId
      ? { providerOrganizationId: parsed.recordKey.quotaScopeId }
      : {}),
    fetchedAtMs: parsed.fetchedAtMs,
    staleAtMs: parsed.fetchedAtMs + parsed.staleAfterMs,
    source: mapUsageSourceToQuotaSource(parsed.source),
    confidence: mapUsageConfidenceToQuotaConfidence(parsed.confidence),
    ...(parsed.recoveryCredits ? { recoveryCredits: parsed.recoveryCredits satisfies ConnectedServiceQuotaRecoveryCreditsV1 } : {}),
    ...(parsed.recoveryCreditDetails ? { recoveryCreditDetails: parsed.recoveryCreditDetails } : {}),
    ...(parsed.subscription ? { subscription: parsed.subscription } : {}),
    meters: parsed.meters,
  };
}

export function projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1(params: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  source: ConnectedServiceUsageSourceV1;
}>): ConnectedServiceQuotaSnapshotV1 | null {
  return projectProviderAccountUsageToConnectedServiceQuotaSnapshot(params.snapshot, params.source);
}

export function sealProviderAccountUsageSnapshotCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: 'provider_account_usage_snapshot',
    material: params.material,
    payload: params.payload,
    randomBytes: params.randomBytes,
  });
}

export function openProviderAccountUsageSnapshotCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): AccountScopedOpenResult {
  return openAccountScopedBlobCiphertext({
    kind: 'provider_account_usage_snapshot',
    material: params.material,
    ciphertext: params.ciphertext,
  });
}

export function sealProviderAccountUsageSnapshot(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  snapshot: ProviderAccountUsageSnapshotV1;
  randomBytes: (length: number) => Uint8Array;
}>): SealedProviderAccountUsageSnapshotV1 {
  const { snapshot, subscription, recoveryCreditDetails } = splitProviderAccountUsageSupplementalFacets(params.snapshot);
  return {
    format: 'account_scoped_v1',
    ciphertext: sealProviderAccountUsageSnapshotCiphertext({ ...params, payload: snapshot }),
    ...(subscription ? {
      subscription: {
        observedAtMs: Math.max(subscription.observedAtMs, subscription.lastRefreshError?.observedAtMs ?? 0),
        ciphertext: sealProviderAccountUsageSnapshotCiphertext({
          ...params,
          payload: { v: 1, recordId: snapshot.recordId, subscription },
        }),
      },
    } : {}),
    ...(recoveryCreditDetails ? {
      recoveryCreditDetails: {
        ciphertext: sealProviderAccountUsageSnapshotCiphertext({
          ...params,
          payload: { v: 1, recordId: snapshot.recordId, fetchedAtMs: snapshot.fetchedAtMs, recoveryCreditDetails },
        }),
      },
    } : {}),
  };
}

export function openSealedProviderAccountUsageSnapshot(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  sealed: SealedProviderAccountUsageSnapshotV1;
}>): ProviderAccountUsageSnapshotV1 | null {
  const sealed = SealedProviderAccountUsageSnapshotV1Schema.safeParse(params.sealed);
  if (!sealed.success) return null;
  const opened = openProviderAccountUsageSnapshotCiphertext({ material: params.material, ciphertext: sealed.data.ciphertext });
  const snapshot = ProviderAccountUsageSnapshotV1Schema.safeParse(opened?.value);
  if (!snapshot.success) return null;
  const result = { ...snapshot.data };
  if (sealed.data.subscription) {
    const facet = openProviderAccountUsageSnapshotCiphertext({ material: params.material, ciphertext: sealed.data.subscription.ciphertext });
    const parsedFacet = z.object({
      v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, subscription: ProviderAccountSubscriptionV1Schema,
    }).strict().safeParse(facet?.value);
    if (!parsedFacet.success || parsedFacet.data.recordId !== snapshot.data.recordId) return null;
    const subscription = parsedFacet.data.subscription;
    if (Math.max(subscription.observedAtMs, subscription.lastRefreshError?.observedAtMs ?? 0) !== sealed.data.subscription.observedAtMs) return null;
    result.subscription = subscription;
  }
  if (sealed.data.recoveryCreditDetails) {
    const facet = openProviderAccountUsageSnapshotCiphertext({ material: params.material, ciphertext: sealed.data.recoveryCreditDetails.ciphertext });
    const parsedFacet = z.object({
      v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema,
      fetchedAtMs: z.number().int().nonnegative(), recoveryCreditDetails: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
    }).strict().safeParse(facet?.value);
    if (!parsedFacet.success || parsedFacet.data.recordId !== snapshot.data.recordId || parsedFacet.data.fetchedAtMs !== snapshot.data.fetchedAtMs) return null;
    result.recoveryCreditDetails = parsedFacet.data.recoveryCreditDetails;
  }
  return result;
}
