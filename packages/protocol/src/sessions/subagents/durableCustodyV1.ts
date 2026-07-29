import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SubagentStatusV1Schema } from './subagentRefV1.js';

export const SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1 = 'session.subagents.durable-custody.v1' as const;
export const MAX_SESSION_SUBAGENT_CUSTODY_RECORDS = 256;
export const MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS = 4_096;
export const MAX_SESSION_SUBAGENT_CUSTODY_RETIRED_GENERATIONS = 4_096;
export const MAX_SESSION_SUBAGENT_CUSTODY_ENCRYPTED_CONTENT_CODE_UNITS = 1_500_000;
export const SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const IndexedKeySchema = z.string().min(1).max(191).refine((value) => value.trim().length > 0, 'must not be blank');
const CustodyKeySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const PublicSubagentIdSchema = z.string().min(1).max(4_096).refine((value) => value.trim().length > 0, 'must not be blank');
const PublicGroupIdSchema = z.string().max(4_096);
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SessionSubagentCustodyContentFingerprintV1Schema = z.union([
  z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
]);
export type SessionSubagentCustodyContentFingerprintV1 = z.infer<typeof SessionSubagentCustodyContentFingerprintV1Schema>;

const SessionSubagentCustodyContentEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('encrypted'),
    c: z.string()
      .min(1)
      .max(MAX_SESSION_SUBAGENT_CUSTODY_ENCRYPTED_CONTENT_CODE_UNITS)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }).strict(),
  z.object({ t: z.literal('plain'), v: AgentRuntimeJsonValueV1Schema }).strict(),
]);
export const SessionSubagentCustodyContentV1Schema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return null;
  return value;
}, SessionSubagentCustodyContentEnvelopeSchema);
export type SessionSubagentCustodyContentV1 = z.infer<typeof SessionSubagentCustodyContentV1Schema>;
export type SessionSubagentCustodyDetailV1 = Extract<SessionSubagentCustodyContentV1, { t: 'plain' }>['v'];

export const SessionSubagentCustodyScopeV1Schema = z.object({
  pluginId: PluginIdSchema,
  contributionId: PluginContributionLocalIdSchema,
  immutableGenerationId: IndexedKeySchema,
}).strict();
export type SessionSubagentCustodyScopeV1 = z.infer<typeof SessionSubagentCustodyScopeV1Schema>;

const SESSION_SUBAGENT_CUSTODY_KEY_DOMAIN_V1 = 'happier:session-subagent-custody-key:v1\0';

export function createSessionSubagentCustodyKeyV1(
  params: SessionSubagentCustodyScopeV1 & Readonly<{ sessionId: string }>,
): `sha256:${string}` {
  const scope = SessionSubagentCustodyScopeV1Schema.parse({
    pluginId: params.pluginId,
    contributionId: params.contributionId,
    immutableGenerationId: params.immutableGenerationId,
  });
  const sessionId = IndexedKeySchema.parse(params.sessionId);
  return `sha256:${bytesToHex(sha256(utf8ToBytes(`${SESSION_SUBAGENT_CUSTODY_KEY_DOMAIN_V1}${JSON.stringify([
    scope.pluginId,
    scope.contributionId,
    scope.immutableGenerationId,
    sessionId,
  ])}`)))}`;
}

const SESSION_SUBAGENT_CUSTODY_DETAIL_DOMAIN_V1 = 'happier:session-subagent-custody-detail:v1\0';
const SESSION_SUBAGENT_CUSTODY_ENCRYPTED_FINGERPRINT_DOMAIN_V1 =
  'happier:session-subagent-custody-encrypted-fingerprint:v1\0';

function canonicalizeDetail(value: SessionSubagentCustodyDetailV1): SessionSubagentCustodyDetailV1 {
  if (Array.isArray(value)) return value.map(canonicalizeDetail);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalizeDetail(child)]),
    );
  }
  return value;
}

export function serializeSessionSubagentCustodyDetailV1(value: SessionSubagentCustodyDetailV1): string {
  const parsed = AgentRuntimeJsonValueV1Schema.parse(value);
  return `${SESSION_SUBAGENT_CUSTODY_DETAIL_DOMAIN_V1}${JSON.stringify(canonicalizeDetail(parsed))}`;
}

export function createSessionSubagentCustodyPlainContentFingerprintV1(
  value: SessionSubagentCustodyDetailV1,
): SessionSubagentCustodyContentFingerprintV1 {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(serializeSessionSubagentCustodyDetailV1(value))))}`;
}

export function serializeSessionSubagentCustodyEncryptedFingerprintInputV1(params: Readonly<{
  sessionId: string;
  custodyKey: string;
  detail: SessionSubagentCustodyDetailV1;
}>): string {
  const sessionId = IndexedKeySchema.parse(params.sessionId);
  const custodyKey = CustodyKeySchema.parse(params.custodyKey);
  const detail = serializeSessionSubagentCustodyDetailV1(params.detail);
  return `${SESSION_SUBAGENT_CUSTODY_ENCRYPTED_FINGERPRINT_DOMAIN_V1}${JSON.stringify([
    sessionId,
    custodyKey,
    detail,
  ])}`;
}

export const SessionSubagentCustodyRecordV1Schema = z.object({
  subagentId: PublicSubagentIdSchema,
  groupId: PublicGroupIdSchema.nullable(),
  status: SubagentStatusV1Schema,
  revision: RevisionSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type SessionSubagentCustodyRecordV1 = z.infer<typeof SessionSubagentCustodyRecordV1Schema>;

export const SessionSubagentCustodyMutationRequestV1Schema = z.object({
  operationId: IndexedKeySchema,
  scope: SessionSubagentCustodyScopeV1Schema,
  custodyKey: CustodyKeySchema,
  subagentId: PublicSubagentIdSchema,
  groupId: PublicGroupIdSchema.nullable(),
  expectedRevision: RevisionSchema.nullable(),
  status: SubagentStatusV1Schema,
  contentFingerprint: SessionSubagentCustodyContentFingerprintV1Schema,
  content: SessionSubagentCustodyContentV1Schema,
}).strict().superRefine((value, context) => {
  const expectedPrefix = value.content.t === 'plain' ? 'sha256:' : 'hmac-sha256:';
  if (!value.contentFingerprint.startsWith(expectedPrefix)) {
    context.addIssue({
      code: 'custom',
      path: ['contentFingerprint'],
      message: 'Content fingerprint algorithm must match the content envelope',
    });
  }
});
export type SessionSubagentCustodyMutationRequestV1 = z.infer<typeof SessionSubagentCustodyMutationRequestV1Schema>;

export const SessionSubagentCustodyMutationResponseV1Schema = z.object({
  record: SessionSubagentCustodyRecordV1Schema,
  replayed: z.boolean(),
}).strict();
export type SessionSubagentCustodyMutationResponseV1 = z.infer<typeof SessionSubagentCustodyMutationResponseV1Schema>;

export const SessionSubagentCustodyListQueryV1Schema = z.object({
  pluginId: PluginIdSchema,
  contributionId: PluginContributionLocalIdSchema,
  immutableGenerationId: IndexedKeySchema,
  custodyKey: CustodyKeySchema,
}).strict();
export type SessionSubagentCustodyListQueryV1 = z.infer<typeof SessionSubagentCustodyListQueryV1Schema>;

export const SessionSubagentCustodyPageV1Schema = z.object({
  records: z.array(SessionSubagentCustodyRecordV1Schema).max(MAX_SESSION_SUBAGENT_CUSTODY_RECORDS),
}).strict();
export type SessionSubagentCustodyPageV1 = z.infer<typeof SessionSubagentCustodyPageV1Schema>;

export const SessionSubagentCustodyRetirementRequestV1Schema = z.object({
  pluginId: PluginIdSchema,
  immutableGenerationId: IndexedKeySchema,
}).strict();
export type SessionSubagentCustodyRetirementRequestV1 = z.infer<typeof SessionSubagentCustodyRetirementRequestV1Schema>;

export const SessionSubagentCustodyRetirementResponseV1Schema = z.object({
  retired: z.literal(true),
}).strict();
export type SessionSubagentCustodyRetirementResponseV1 = z.infer<typeof SessionSubagentCustodyRetirementResponseV1Schema>;

export const SessionSubagentCustodyCapabilityV1Schema = z.object({
  capability: z.literal(SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1),
  maxRecords: z.literal(MAX_SESSION_SUBAGENT_CUSTODY_RECORDS),
  maxReceipts: z.literal(MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS),
  receiptRetentionMs: z.literal(SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS),
}).strict();
export type SessionSubagentCustodyCapabilityV1 = z.infer<typeof SessionSubagentCustodyCapabilityV1Schema>;

export function isSessionSubagentStatusTransitionAllowed(current: string, next: string): boolean {
  const terminalStatuses = new Set(['completed', 'failed', 'aborted']);
  return !terminalStatuses.has(current) || current === next;
}
