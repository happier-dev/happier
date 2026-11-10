import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { z } from '../zodRuntimePolicy.js';
import { ProviderAccountSubscriptionV1Schema } from './accountSubscription.js';

import { encodeBase64 } from '../crypto/base64.js';
import {
  ProviderAccountUsageQuotaScopeV1Schema,
} from './providerAccountUsageQuotaScopeV1.js';
import {
  ConnectedServiceQuotaMeterV1Schema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
  ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema,
} from './connectedServiceSchemas.js';
import { ProviderAccountUsageDiagnosticV1Schema } from './providerAccountUsageDiagnostic.js';
export type { ProviderAccountUsageDiagnosticV1 } from './providerAccountUsageDiagnostic.js';

export {
  ProviderAccountUsageQuotaScopeV1Schema,
  type ProviderAccountUsageQuotaScopeV1,
} from './providerAccountUsageQuotaScopeV1.js';

const encoder = new TextEncoder();

export const SealedProviderAccountUsageRecoveryCreditDetailsV1Schema = lazyZodSchema(() => z.strictObject({ ciphertext: z.string().check(z.minLength(1)) }));

export const ProviderAccountUsageRecordIdSchema = lazyZodSchema(() => z.string().check(z.regex(/^paug_v1_[A-Za-z0-9_-]{8,}$/)));
export type ProviderAccountUsageRecordId = z.infer<typeof ProviderAccountUsageRecordIdSchema>;

/** Immutable accepted-entry reference; no protected cycle facts are exposed. */
export const ProviderAccountUsageHistoryCursorV1Schema = lazyZodSchema(() => z.strictObject({ observedAtMs: z.number().check(z.int(), z.nonnegative()), id: z.string().check(z.minLength(1)) }));
export const ProviderAccountUsageHistoryWitnessV1Schema = ProviderAccountUsageHistoryCursorV1Schema;
export type ProviderAccountUsageHistoryWitnessV1 = z.infer<typeof ProviderAccountUsageHistoryWitnessV1Schema>;

const PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH = 102;
const ProviderAccountUsageOpaqueRefPartSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH), z.regex(/^[A-Za-z0-9_-]+$/)));

export function buildProviderAccountUsageOpaqueLocalCredentialRef(params: Readonly<{
  providerId: string;
  kind: string;
  value: string;
}>): string {
  const providerId = ProviderAccountUsageOpaqueRefPartSchema.parse(params.providerId);
  const kind = ProviderAccountUsageOpaqueRefPartSchema.parse(params.kind);
  const value = z.string().check(z.trim(), z.minLength(1), z.maxLength(4096)).parse(params.value);
  const digest = sha256(encoder.encode(JSON.stringify({ providerId, kind, value })));
  return `opaque:${providerId}:${kind}:${encodeBase64(digest, 'base64url')}`;
}

export const ProviderAccountUsageSubjectKindV1Schema = lazyZodSchema(() => z.enum([
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

export const ProviderAccountUsageRecordKeyV1Schema = lazyZodSchema(() => z.strictObject({
  providerId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  accountSubjectId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  subjectKind: ProviderAccountUsageSubjectKindV1Schema,
  quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
  quotaScopeId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));
export type ProviderAccountUsageRecordKeyV1 = z.infer<typeof ProviderAccountUsageRecordKeyV1Schema>;

export const ProviderAccountSubjectRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['providerSubject', 'provisionalLocalSubject']),
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  mergeKey: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));
export type ProviderAccountSubjectRefV1 = z.infer<typeof ProviderAccountSubjectRefV1Schema>;

export const ProviderAccountUsageSourceV1Schema = lazyZodSchema(() => z.enum([
  'runtimeSignal',
  'providerHttp',
  'proxy',
  'connectedServiceProbe',
  'cached',
  'manual',
  'unknown',
]));
export type ProviderAccountUsageSourceV1 = z.infer<typeof ProviderAccountUsageSourceV1Schema>;

export const ProviderAccountUsageConfidenceV1Schema = lazyZodSchema(() => z.enum(['confirmed', 'estimated', 'unknown']));
export type ProviderAccountUsageConfidenceV1 = z.infer<typeof ProviderAccountUsageConfidenceV1Schema>;

export const ProviderAccountUsageStateV1Schema = lazyZodSchema(() => z.enum([
  'not_loaded',
  'loaded_empty',
  'loaded_data',
  'stale_data',
  'error_last_known_good',
]));
export type ProviderAccountUsageStateV1 = z.infer<typeof ProviderAccountUsageStateV1Schema>;

function canonicalRecordKeyJson(key: ProviderAccountUsageRecordKeyV1): string {
  return JSON.stringify({
    providerId: key.providerId,
    accountSubjectId: key.accountSubjectId,
    subjectKind: key.subjectKind,
    quotaScope: key.quotaScope,
    ...(key.quotaScopeId ? { quotaScopeId: key.quotaScopeId } : {}),
  });
}

export function buildProviderAccountUsageRecordId(
  key: ProviderAccountUsageRecordKeyV1,
): ProviderAccountUsageRecordId {
  const parsed = ProviderAccountUsageRecordKeyV1Schema.parse(key);
  const digest = sha256(encoder.encode(canonicalRecordKeyJson(parsed)));
  return ProviderAccountUsageRecordIdSchema.parse(`paug_v1_${encodeBase64(digest, 'base64url')}`);
}

export const ProviderAccountUsageSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  recordId: ProviderAccountUsageRecordIdSchema,
  recordKey: ProviderAccountUsageRecordKeyV1Schema,
  providerId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  accountSubject: ProviderAccountSubjectRefV1Schema,
  observedAtMs: z.number().check(z.int(), z.nonnegative()),
  fetchedAtMs: z.number().check(z.int(), z.nonnegative()),
  staleAfterMs: z.number().check(z.int(), z.minimum(1)),
  source: ProviderAccountUsageSourceV1Schema,
  confidence: ProviderAccountUsageConfidenceV1Schema,
  state: z._default(ProviderAccountUsageStateV1Schema, 'loaded_data'),
  planLabel: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)))),
  accountLabel: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)))),
  subscription: z.optional(ProviderAccountSubscriptionV1Schema),
  recoveryCredits: z.optional(ConnectedServiceQuotaRecoveryCreditsV1Schema),
  recoveryCreditDetails: z.optional(ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema),
  meters: z.array(ConnectedServiceQuotaMeterV1Schema),
  diagnostics: z.optional(z.array(ProviderAccountUsageDiagnosticV1Schema)),
}).check(z.superRefine((snapshot, ctx) => {
  if (snapshot.recordId !== buildProviderAccountUsageRecordId(snapshot.recordKey)) {
    ctx.addIssue({
      code: "custom",
      message: 'Snapshot recordId must match recordKey',
      path: ['recordId'],
    });
  }
  if (snapshot.providerId !== snapshot.recordKey.providerId) {
    ctx.addIssue({
      code: "custom",
      message: 'Snapshot providerId must match recordKey providerId',
      path: ['providerId'],
    });
  }
  if (snapshot.accountSubject.id !== snapshot.recordKey.accountSubjectId) {
    ctx.addIssue({
      code: "custom",
      message: 'Account subject id must match recordKey accountSubjectId',
      path: ['accountSubject', 'id'],
    });
  }
})));
export type ProviderAccountUsageSnapshotV1 = z.infer<typeof ProviderAccountUsageSnapshotV1Schema>;
/** Failure clocks describe a refresh attempt, never a provider observation. */
export function getProviderAccountUsageRefreshErrorAt(
  snapshot: Pick<ProviderAccountUsageSnapshotV1, 'state' | 'diagnostics'>,
): number | undefined {
  if (snapshot.state !== 'error_last_known_good') return undefined;
  return snapshot.diagnostics?.reduce<number | undefined>((latest, diagnostic) =>
    diagnostic.observedAtMs === undefined ? latest
      : Math.max(latest ?? 0, diagnostic.observedAtMs), undefined);
}

/** Typed projection after retained Account content has been opened. */
export const ProviderAccountUsageSnapshotV1StoredSchema = createStoredReadSchema(ProviderAccountUsageSnapshotV1Schema);

/** One material projection for daemon fingerprinting and accepted plain-history coalescing. */
export function serializeProviderAccountUsageSnapshotMaterialV1(snapshot: ProviderAccountUsageSnapshotV1): string {
  const subscription = snapshot.subscription;
  const material = {
    v: snapshot.v, recordKey: snapshot.recordKey, providerId: snapshot.providerId,
    accountSubject: snapshot.accountSubject, staleAfterMs: snapshot.staleAfterMs,
    source: snapshot.source, confidence: snapshot.confidence, state: snapshot.state,
    planLabel: snapshot.planLabel ?? null, accountLabel: snapshot.accountLabel ?? null,
    recoveryCredits: snapshot.recoveryCredits ?? null,
    recoveryCreditDetails: snapshot.recoveryCreditDetails ?? null,
    subscription: subscription ? { ...subscription, observedAtMs: undefined,
      ...(subscription.lastRefreshError ? { lastRefreshError: { ...subscription.lastRefreshError, observedAtMs: undefined } } : {}) } : null,
    // Request ids, response dates and observation clocks change on an unchanged
    // poll. Failure codes/status/retry facts still change material identity.
    refreshDiagnostics: snapshot.diagnostics?.filter(entry => entry.kind === 'provider_http')
      .map(({ observedAtMs: _observedAt, headers: _headers, ...material }) => material) ?? [],
    meters: snapshot.meters,
  };
  return JSON.stringify(material, (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}
