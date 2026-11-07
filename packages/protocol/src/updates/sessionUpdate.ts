import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionViewerProjectionV1Schema } from '../sessions/personal/viewer.js';
import { PrimaryTurnStatusV1Schema, SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { TurnIdSchema } from '../sessions/idsV1.js';
import { SessionRuntimeActivityStateSchema } from '../sessions/runtime/activity/sessionRuntimeActivity.js';
import { SessionOwnerMetadataEnvelopeV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';

const timestamp = () => z.number().check(z.int(), z.nonnegative());
const versionedDocument = () => z.looseObject({ value: z.nullable(z.string()), version: z.number().check(z.int()) });

/** Metadata omission is independent of the full Agent-state request/control document. */
export const SessionUpdateBodySchema = lazyZodSchema(() => {
  const full = z.looseObject({
    t: z.literal('update-session'),
    id: z.string(),
    projectKey: z.optional(z.nullable(z.string())),
    metadata: z.optional(versionedDocument()),
    metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    ownerMetadata: z.optional(z.strictObject({ value: SessionOwnerMetadataEnvelopeV1Schema })),
    agentState: z.optional(versionedDocument()),
    active: z.optional(z.boolean()),
    activeAt: z.optional(timestamp()),
    lastViewedSessionSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
    unreadSince: z.optional(z.nullable(timestamp())),
    viewer: z.optional(SessionViewerProjectionV1Schema),
    pendingPermissionRequestCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingUserActionRequestCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    pendingRequestObservedAt: z.optional(z.nullable(timestamp())),
    latestReadyEventSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    latestReadyEventAt: z.optional(z.nullable(timestamp())),
    latestReadyEventLocalId: z.optional(z.string().check(z.minLength(1))),
    latestTurnId: z.optional(z.nullable(TurnIdSchema)),
    latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
    latestTurnStatusObservedAt: z.optional(z.nullable(timestamp())),
    lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    runtimeActivityState: z.optional(SessionRuntimeActivityStateSchema),
    runtimeActivityActiveCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    runtimeActivityObservedAt: z.optional(z.nullable(timestamp())),
    runtimeActivityRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
    meaningfulActivityAt: z.optional(timestamp()),
    archivedAt: z.optional(z.nullable(timestamp())),
  });
  return z.discriminatedUnion('metadataDocument', [
    z.extend(full, { metadataDocument: z.optional(z.undefined()) }),
    z.extend(full, {
      metadataDocument: z.literal('omitted'),
      metadataVersion: z.number().check(z.int(), z.nonnegative()),
      metadataLayoutVersion: z.number().check(z.int(), z.nonnegative()),
      metadata: z.optional(z.never()),
      ownerMetadata: z.optional(z.never()),
    }),
  ]);
});
