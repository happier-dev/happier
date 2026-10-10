import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, ProviderAccountUsageHistoryCursorV1Schema, ProviderAccountUsageHistoryWitnessV1Schema } from './providerAccountUsagePrimitives.js';
import { QualifiedConnectedServiceUsageSourceV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { ProviderAccountUsagePaceV1Schema, ProviderAccountUsageUnusedCapacityV1Schema } from './deriveProviderAccountUsagePace.js';
import { UsagePacingTargetsV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import { PendingResetStartReadinessV1Schema } from '../sessions/pending/pendingResetStartReadinessV1.js';

// New operation envelopes and their nested range/cursor identities are closed.
// pageSize is caller-selected paging, with no retention horizon or invented cap.
export const ProviderAccountUsageHistoryRangeV1Schema = lazyZodSchema(() => z.object({
  startAtMs: z.number().int().nonnegative(),
  endAtMs: z.number().int().nonnegative(),
}).strict().refine(range => range.endAtMs > range.startAtMs, { message: 'History range must have a positive duration' }));
export const ProviderAccountUsageHistoryRequestV1Schema = lazyZodSchema(() => z.object({
  range: ProviderAccountUsageHistoryRangeV1Schema,
  pageSize: z.number().int().positive(),
  cursor: ProviderAccountUsageHistoryCursorV1Schema.optional(),
}).strict());
export const QualifiedProviderAccountUsageHistoryRequestV4Schema = lazyZodSchema(() => z.union([
  z.object({ recordId: ProviderAccountUsageRecordIdSchema, history: ProviderAccountUsageHistoryRequestV1Schema }).strict(),
  z.object({ recordId: ProviderAccountUsageRecordIdSchema, witness: ProviderAccountUsageHistoryWitnessV1Schema }).strict(),
]));
export const QualifiedProviderAccountUsageHistoryResponseV4Schema = lazyZodSchema(() => z.object({
  entries: z.array(z.object({ id: z.string().min(1), observedAtMs: z.number().int().nonnegative(), record: QualifiedProviderAccountUsageRecordResponseV4Schema }).strict()),
  nextCursor: ProviderAccountUsageHistoryCursorV1Schema.nullable(),
}).strict());
export const OpenedProviderAccountUsageHistoryPageV1Schema = lazyZodSchema(() => z.object({
  entries: z.array(z.object({ id: z.string().min(1), observedAtMs: z.number().int().nonnegative(), snapshot: ProviderAccountUsageSnapshotV1Schema }).strict()),
  nextCursor: ProviderAccountUsageHistoryCursorV1Schema.nullable(),
}).strict());
export const ConnectedServiceQuotaGetInputV1Schema = lazyZodSchema(() => z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  history: ProviderAccountUsageHistoryRequestV1Schema.optional(),
}).strict());
export const ProviderAccountUsageWaitingWorkV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), entries: z.array(z.object({ sessionId: z.string().min(1), localId: z.string().min(1), recordId: ProviderAccountUsageRecordIdSchema, meterId: z.string().min(1), readiness: PendingResetStartReadinessV1Schema }).strict()) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['unsupported', 'authority_unavailable', 'read_failed']) }).strict(),
]));
export const ConnectedServiceQuotaGetResultV1Schema = lazyZodSchema(() => z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  current: ProviderAccountUsageSnapshotV1Schema.nullable(),
  history: OpenedProviderAccountUsageHistoryPageV1Schema.optional(),
  pace: z.array(z.object({ meterId: z.string().min(1), value: ProviderAccountUsagePaceV1Schema }).strict()),
  unusedCapacity: ProviderAccountUsageUnusedCapacityV1Schema.optional(),
  targets: UsagePacingTargetsV1Schema,
  waitingWork: ProviderAccountUsageWaitingWorkV1Schema,
}).strict());

export type ProviderAccountUsageHistoryRequestV1 = z.infer<typeof ProviderAccountUsageHistoryRequestV1Schema>;
export type ProviderAccountUsageHistoryWitnessV1 = z.infer<typeof ProviderAccountUsageHistoryWitnessV1Schema>;
export type ConnectedServiceQuotaGetInputV1 = z.infer<typeof ConnectedServiceQuotaGetInputV1Schema>;
export type ConnectedServiceQuotaGetResultV1 = z.infer<typeof ConnectedServiceQuotaGetResultV1Schema>;
export type ProviderAccountUsageWaitingWorkV1 = z.infer<typeof ProviderAccountUsageWaitingWorkV1Schema>;
