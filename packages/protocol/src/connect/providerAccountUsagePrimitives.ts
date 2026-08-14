import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { encodeBase64 } from '../crypto/base64.js';
import {
  ProviderAccountUsageQuotaScopeV1Schema,
} from './providerAccountUsageQuotaScopeV1.js';
import {
  ConnectedServiceQuotaMeterV1Schema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
} from './connectedServiceSchemas.js';
import {
  containsUnsafeDiagnosticText,
  isUnsafeDiagnosticHeaderName,
} from './diagnosticPrivacy.js';

export {
  ProviderAccountUsageQuotaScopeV1Schema,
  type ProviderAccountUsageQuotaScopeV1,
} from './providerAccountUsageQuotaScopeV1.js';

const encoder = new TextEncoder();

export const ProviderAccountUsageRecordIdSchema = z.string().regex(/^paug_v1_[A-Za-z0-9_-]{8,}$/);
export type ProviderAccountUsageRecordId = z.infer<typeof ProviderAccountUsageRecordIdSchema>;

const PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH = 102;
const ProviderAccountUsageOpaqueRefPartSchema = z.string()
  .trim()
  .min(1)
  .max(PROVIDER_ACCOUNT_USAGE_OPAQUE_REF_PART_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

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

export const ProviderAccountUsageSubjectKindV1Schema = z.enum([
  'account',
  'workspace',
  'organization',
  'tenant',
  'subscription',
  'project',
  'modelFamily',
  'unknown',
]);
export type ProviderAccountUsageSubjectKindV1 = z.infer<typeof ProviderAccountUsageSubjectKindV1Schema>;

export const ProviderAccountUsageRecordKeyV1Schema = z.object({
  providerId: z.string().trim().min(1).max(128),
  accountSubjectId: z.string().trim().min(1).max(512),
  subjectKind: ProviderAccountUsageSubjectKindV1Schema,
  quotaScope: ProviderAccountUsageQuotaScopeV1Schema,
  quotaScopeId: z.string().trim().min(1).max(256).optional(),
}).strict();
export type ProviderAccountUsageRecordKeyV1 = z.infer<typeof ProviderAccountUsageRecordKeyV1Schema>;

export const ProviderAccountSubjectRefV1Schema = z.object({
  kind: z.enum(['providerSubject', 'provisionalLocalSubject']),
  id: z.string().trim().min(1).max(512),
  mergeKey: z.string().trim().min(1).max(512).optional(),
}).strict();
export type ProviderAccountSubjectRefV1 = z.infer<typeof ProviderAccountSubjectRefV1Schema>;

export const ProviderAccountUsageSourceV1Schema = z.enum([
  'runtimeSignal',
  'providerHttp',
  'proxy',
  'connectedServiceProbe',
  'cached',
  'manual',
  'unknown',
]);
export type ProviderAccountUsageSourceV1 = z.infer<typeof ProviderAccountUsageSourceV1Schema>;

export const ProviderAccountUsageConfidenceV1Schema = z.enum(['confirmed', 'estimated', 'unknown']);
export type ProviderAccountUsageConfidenceV1 = z.infer<typeof ProviderAccountUsageConfidenceV1Schema>;

export const ProviderAccountUsageStateV1Schema = z.enum([
  'not_loaded',
  'loaded_empty',
  'loaded_data',
  'stale_data',
  'error_last_known_good',
]);
export type ProviderAccountUsageStateV1 = z.infer<typeof ProviderAccountUsageStateV1Schema>;

const ProviderAccountUsageDiagnosticV1Schema = z.object({
  kind: z.enum(['unavailable', 'provider_http', 'runtime_signal', 'projection', 'validation', 'storage', 'unknown']),
  code: z.string().trim().min(1).max(128).optional(),
  message: z.string().trim().min(1).max(512).optional(),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  observedAtMs: z.number().int().nonnegative().optional(),
}).strict().superRefine((diagnostic, ctx) => {
  if (diagnostic.headers) {
    for (const [headerName, headerValue] of Object.entries(diagnostic.headers)) {
      if (isUnsafeDiagnosticHeaderName(headerName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unsafe provider account usage diagnostic header',
          path: ['headers', headerName],
        });
      }
      if (containsUnsafeDiagnosticText(headerValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unsafe provider account usage diagnostic header',
          path: ['headers', headerName],
        });
      }
    }
  }
  if (containsUnsafeDiagnosticText(diagnostic.code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsafe provider account usage diagnostic code',
      path: ['code'],
    });
  }
  if (containsUnsafeDiagnosticText(diagnostic.message)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsafe provider account usage diagnostic message',
      path: ['message'],
    });
  }
});
export type ProviderAccountUsageDiagnosticV1 = z.infer<typeof ProviderAccountUsageDiagnosticV1Schema>;

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

export const ProviderAccountUsageSnapshotV1Schema = z.object({
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
});
export type ProviderAccountUsageSnapshotV1 = z.infer<typeof ProviderAccountUsageSnapshotV1Schema>;
