import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionEffectiveAccessV1Schema } from '../access/sessionEffectiveAccessV1.js';
import { V2SessionRecordSchema, V2SessionListRowSchema } from '../control/contract.js';
import { SessionListMetadataUpgradeRequiredCountSchema } from '../control/listResult.js';
import { SessionViewerProjectionV1Schema } from '../personal/viewer.js';
import { SessionListUnavailableQueryV1Schema } from './query.js';

export { SessionListMetadataUpgradeRequiredCountSchema } from '../control/listResult.js';

/**
 * Canonical record contract for current Session projections.
 *
 * The additive V2 record remains tolerant of responsibility omission for
 * released producers. A negotiated current operation is different: it must
 * carry the complete responsibility pair so omission cannot be mistaken for
 * an authoritative unassigned value.
 */
export const SessionCurrentProjectionRecordV1Schema = lazyZodSchema(() => z.safeExtend(V2SessionRecordSchema, {
  effectiveAccess: SessionEffectiveAccessV1Schema,
  responsibleAccountId: z.nullable(z.string().check(z.minLength(1))),
  responsibleAccount: V2SessionRecordSchema.shape.responsibleAccount._zod.def.innerType,
}));

export type SessionCurrentProjectionRecordV1 = Readonly<z.infer<typeof SessionCurrentProjectionRecordV1Schema>>;

/** Full shared documents for the same proved runtime corpus as the compact list. */
export const SessionRuntimeManagedSubtreeSnapshotRecordV1Schema = lazyZodSchema(() => z.safeExtend(SessionCurrentProjectionRecordV1Schema, {
  agentState: z.null(),
  viewer: z.optional(z.never()),
  ownerMetadata: z.optional(z.never()),
  lastViewedSessionSeq: z.optional(z.never()),
  unreadSince: z.optional(z.never()),
  receivedRuleCount: z.optional(z.never()),
}).check(z.refine(row => row.effectiveAccess.level === 'view', {
  message: 'Runtime subtree snapshots retain shared View authority',
})));
export type SessionRuntimeManagedSubtreeSnapshotRecordV1 = Readonly<z.infer<typeof SessionRuntimeManagedSubtreeSnapshotRecordV1Schema>>;

export const SessionCurrentListProjectionRecordV1Schema = lazyZodSchema(() => z.safeExtend(V2SessionListRowSchema, {
  effectiveAccess: SessionEffectiveAccessV1Schema,
  responsibleAccountId: z.nullable(z.string().check(z.minLength(1))),
  responsibleAccount: V2SessionRecordSchema.shape.responsibleAccount._zod.def.innerType,
}));

/**
 * Closed V1 response envelope for filtered listing. Session rows retain the
 * established V2 projection policy; pagination authority stays explicit at
 * this boundary so consumers cannot lose either independent continuation.
 */
export const SessionListQueryResponseV1Schema = lazyZodSchema(() => z.strictObject({
  sessions: z.array(z.safeExtend(SessionCurrentListProjectionRecordV1Schema, {
    viewer: SessionViewerProjectionV1Schema,
  })),
  nextCursor: z.nullable(z.string()),
  hasNext: z.boolean(),
  attentionNextCursor: z.nullable(z.string()),
  attentionHasNext: z.boolean(),
  metadataUpgradeRequiredCount: z.optional(SessionListMetadataUpgradeRequiredCountSchema),
  membershipUnavailableReason: z.optional(SessionListUnavailableQueryV1Schema.shape.reason),
}));

export type SessionListQueryResponseV1 = Readonly<z.infer<typeof SessionListQueryResponseV1Schema>>;

/** The same query envelope for a proved runtime subtree, without Account-private projections. */
export const SessionRuntimeManagedSubtreeListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionListQueryResponseV1Schema.shape,
  sessions: z.array(z.safeExtend(SessionCurrentListProjectionRecordV1Schema, {
    metadataAudience: z.literal('shared'),
    agentStateDocument: z.literal('redacted'),
    viewer: z.optional(z.never()),
    ownerMetadata: z.optional(z.never()),
    lastViewedSessionSeq: z.optional(z.never()),
    unreadSince: z.optional(z.never()),
    receivedRuleCount: z.optional(z.never()),
  })),
}));
export type SessionRuntimeManagedSubtreeListResponseV1 = Readonly<z.infer<typeof SessionRuntimeManagedSubtreeListResponseV1Schema>>;
