import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, ProviderAccountUsageHistoryCursorV1Schema, ProviderAccountUsageHistoryWitnessV1Schema } from './providerAccountUsagePrimitives.js';
import { QualifiedConnectedServiceUsageSourceV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { ProviderAccountUsagePaceV1Schema, ProviderAccountUsageUnusedCapacityV1Schema, ProviderAccountUsageEarlierWindowCurvesV1Schema, ProviderAccountUsagePaceWindowV1Schema } from './deriveProviderAccountUsagePace.js';
import { UsagePacingTargetsV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import { PendingResetStartReadinessV1Schema } from '../sessions/pending/pendingResetStartReadinessV1.js';
import { PendingResetStartsReadResultV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import { ProviderAccountUsagePageProjectionDemandV1Schema, ProviderAccountUsagePageProjectionCoverageV1Schema, PackedProviderAccountUsagePageProjectionV1Schema } from './providerAccountUsagePageProjection.js';

// New operation envelopes and their nested range/cursor identities are closed.
// pageSize is caller-selected paging, with no retention horizon or invented cap.
export const ProviderAccountUsageHistoryRangeV1Schema = lazyZodSchema(() => z.strictObject({
  startAtMs: z.number().check(z.int(), z.nonnegative()),
  endAtMs: z.number().check(z.int(), z.nonnegative()),
}).check(z.refine(range => range.endAtMs > range.startAtMs, { message: 'History range must have a positive duration' })));
export const ProviderAccountUsageHistoryRequestV1Schema = lazyZodSchema(() => z.strictObject({
  range: ProviderAccountUsageHistoryRangeV1Schema,
  pageSize: z.number().check(z.int(), z.positive()),
  cursor: z.optional(ProviderAccountUsageHistoryCursorV1Schema),
}));
export const QualifiedProviderAccountUsageHistoryRequestV4Schema = lazyZodSchema(() => z.union([
  z.strictObject({ recordId: ProviderAccountUsageRecordIdSchema, history: ProviderAccountUsageHistoryRequestV1Schema }),
  z.strictObject({ recordId: ProviderAccountUsageRecordIdSchema, witness: ProviderAccountUsageHistoryWitnessV1Schema }),
  z.strictObject({ recordId: ProviderAccountUsageRecordIdSchema, projection: ProviderAccountUsagePageProjectionDemandV1Schema,
    heldProjection: z.optional(ProviderAccountUsagePageProjectionCoverageV1Schema) }),
]));
export const QualifiedProviderAccountUsageHistoryResponseV4Schema = lazyZodSchema(() => z.strictObject({
  entries: z.array(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()), record: QualifiedProviderAccountUsageRecordResponseV4Schema })),
  nextCursor: z.nullable(ProviderAccountUsageHistoryCursorV1Schema),
}));
export const OpenedProviderAccountUsageHistoryPageV1Schema = lazyZodSchema(() => z.strictObject({
  entries: z.array(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()), snapshot: ProviderAccountUsageSnapshotV1Schema })),
  nextCursor: z.nullable(ProviderAccountUsageHistoryCursorV1Schema),
}));
export const ConnectedServiceQuotaGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  history: z.optional(ProviderAccountUsageHistoryRequestV1Schema),
  projection: z.optional(ProviderAccountUsagePageProjectionDemandV1Schema),
}).check(z.refine(value => !(value.history && value.projection), { message: 'Choose exact history or the page projection' })));
export const ProviderAccountUsageWaitingWorkV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), entries: z.array(z.strictObject({ sessionId: z.string().check(z.minLength(1)), localId: z.string().check(z.minLength(1)), recordId: ProviderAccountUsageRecordIdSchema, meterId: z.string().check(z.minLength(1)), readiness: PendingResetStartReadinessV1Schema })), unboundEntries: PendingResetStartsReadResultV1Schema.shape.unboundEntries }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['unsupported', 'authority_unavailable', 'read_failed']) }),
]));
export const ConnectedServiceQuotaGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  current: z.nullable(ProviderAccountUsageSnapshotV1Schema),
  history: z.optional(OpenedProviderAccountUsageHistoryPageV1Schema),
  pageProjection: z.optional(PackedProviderAccountUsagePageProjectionV1Schema),
  /** Page facts, derived at B before crossing the Resource boundary. Exact history stays at B. */
  pageFacts: z.optional(z.strictObject({
    historyStatus: z.enum(['complete', 'partial']),
    earlierCurves: z.array(z.strictObject({ meterId: z.string().check(z.minLength(1)), value: ProviderAccountUsageEarlierWindowCurvesV1Schema })),
    resetWitness: z.nullable(OpenedProviderAccountUsageHistoryPageV1Schema.shape.entries._zod.def.element),
    witnessedResets: z.array(ProviderAccountUsagePaceWindowV1Schema),
  })),
  pace: z.array(z.strictObject({ meterId: z.string().check(z.minLength(1)), value: ProviderAccountUsagePaceV1Schema })),
  unusedCapacity: z.optional(ProviderAccountUsageUnusedCapacityV1Schema),
  targets: UsagePacingTargetsV1Schema,
  waitingWork: ProviderAccountUsageWaitingWorkV1Schema,
}));

export type ProviderAccountUsageHistoryRequestV1 = z.infer<typeof ProviderAccountUsageHistoryRequestV1Schema>;
export type ProviderAccountUsageHistoryWitnessV1 = z.infer<typeof ProviderAccountUsageHistoryWitnessV1Schema>;
export type ConnectedServiceQuotaGetInputV1 = z.infer<typeof ConnectedServiceQuotaGetInputV1Schema>;
export type ConnectedServiceQuotaGetResultV1 = z.infer<typeof ConnectedServiceQuotaGetResultV1Schema>;
export type ProviderAccountUsageWaitingWorkV1 = z.infer<typeof ProviderAccountUsageWaitingWorkV1Schema>;
