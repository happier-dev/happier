import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MachineKindFromLegacyProjectionSchema } from '../machines/machineKind.js';
import { ManagedMachineRefV1Schema } from '../machines/managed/managedMachineV1.js';
import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBinding.js';
import { SessionViewerProjectionV1Schema } from '../sessions/personal/viewer.js';
import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';
import { AutomationRunStateChangedHostEventV1Schema } from '../plugins/events/hostReferencesV1.js';
import { ExternalSessionTranscriptInvalidationV1Schema } from '../sessions/external/secureRefreshV1.js';
import { ExternalSessionStorageStateV1Schema } from '../sessions/external/operationV1.js';
import { ExecutionRunPublicStateSchema } from '../execution/runs/responseSchemas.js';
import { ExecutionRunMachineActivityEphemeralV1Schema } from '../execution/runs/activityV1.js';
import { SessionMessageRoleSchema } from '../sessions/messages/sessionMessageRole.js';
import { PendingActivationRequestedEphemeralV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { SessionMessageReplyPendingHintV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { UsageSourcesInvalidationV1Schema } from '../usage/usageSources.js';
import { SessionStoredMessageContentSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { PrimaryTurnStatusV1Schema, SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { TurnIdSchema } from '../sessions/idsV1.js';
import { SessionFollowStalledOccurrenceV1Schema } from '../sessions/follow/sessionFollowSourceOccurrenceV1.js';
import {
  ActionOperationRevisionEphemeralV1Schema,
  ActionOperationSnapshotEphemeralV1Schema,
} from '../actions/operations/v1.js';
import {
  parseSessionRuntimeActivityProjectionFields,
  SessionRuntimeActivityStateSchema,
} from '../sessions/runtime/activity/sessionRuntimeActivity.js';
import { SessionOwnerMetadataEnvelopeV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { PendingActivationAuthorizationV1Schema } from '../sessions/pending/pendingActivationAuthorizationV1.js';
import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '../messages/structured/participantMessageV1.js';
import { ActivityMessageReferenceV2Schema } from '../push/activityRemoteAlert.js';
import { MachineKeyBasisV1Schema } from '../machines/machineContentKeyTransitionV1.js';
import { AccessibleMachineAccessV1Schema } from '../machines/machineAccessV1.js';
import { ManagedWakeTargetV1Schema } from '../machines/managed/managedIntentV1.js';
import { DevcontainerChildProjectionV1Schema } from '../machines/managed/devcontainerV1.js';
import { AccountEncryptionCurrentnessResponseSchema } from '../account/encryptionMode.js';
import { SessionMessageV1Schema } from '../sessions/messages/sessionMessagesPageV1.js';
import { SessionMessageObservationFactsV1Schema } from '../sessions/messages/sessionMessageObservationFactsV1.js';

const TimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));
/** Routing hint for private requester custody; it grants no Run-reading authority. */
export const WorkflowRequesterScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('workflow_trigger'),
  id: z.string().check(z.minLength(1)),
}));
export type WorkflowRequesterScopeV1 = z.infer<typeof WorkflowRequesterScopeV1Schema>;
const Base64Schema = lazyZodSchema(() => z.string());
const SessionMessageRoleMetadataSchema = lazyZodSchema(() => z.optional(z.nullable(SessionMessageRoleSchema)));
const SessionEncryptionModeSchema = lazyZodSchema(() => z.enum(['e2ee', 'plain']));

const VersionedNullableStringSchema = lazyZodSchema(() => z.looseObject({
  value: z.nullable(z.string()),
  version: z.number().check(z.int()),
}));

const VersionedStringSchema = lazyZodSchema(() => z.looseObject({
  value: z.string(),
  version: z.number().check(z.int()),
}));

const durableMessageUpdate = <T extends 'new-message' | 'message-updated'>(event: T) => z.discriminatedUnion('delivery', [
  z.strictObject({ t: z.literal(event), sid: z.string(), id: z.optional(z.string()), delivery: z.literal('full'), message: z.extend(SessionMessageV1Schema, {
    localId: z.nullable(z.string()), createdAt: TimestampMsSchema, updatedAt: TimestampMsSchema,
  }) }),
  z.strictObject({ t: z.literal(event), sid: z.string(), id: z.optional(z.string()), delivery: z.literal('hint'), message: SessionMessageObservationFactsV1Schema }),
]);

export const UpdateBodySchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  durableMessageUpdate('new-message'),
  durableMessageUpdate('message-updated'),
  z.looseObject({
    t: z.literal('new-session'),
    id: z.string(),
    projectKey: z.optional(z.nullable(z.string())),
    viewer: z.optional(SessionViewerProjectionV1Schema),
    seq: z.number().check(z.int(), z.minimum(0)),
    metadata: Base64Schema,
    metadataVersion: z.number().check(z.int()),
    metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    ownerMetadata: z.optional(z.nullable(SessionOwnerMetadataEnvelopeV1Schema)),
    agentState: z.nullable(Base64Schema),
    agentStateVersion: z.number().check(z.int()),
    dataEncryptionKey: z.nullable(Base64Schema),
    runnerContentKeyBinding: z.optional(z.nullable(RunnerMachineContentKeyBindingV1Schema)),
    encryptionMode: z.optional(SessionEncryptionModeSchema),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    meaningfulActivityAt: z.optional(TimestampMsSchema),
    /** Where the Session's transcript lives (an imported external session starts `machine_only`). */
    currentStorageState: z.optional(ExternalSessionStorageStateV1Schema),
  }),
  z.looseObject({
    t: z.literal('update-session'),
    id: z.string(),
    projectKey: z.optional(z.nullable(z.string())),
    metadata: z.optional(VersionedNullableStringSchema),
    metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
    ownerMetadata: z.optional(z.strictObject({
      value: SessionOwnerMetadataEnvelopeV1Schema,
    })),
    agentState: z.optional(VersionedNullableStringSchema),
    active: z.optional(z.boolean()),
    activeAt: z.optional(TimestampMsSchema),
    lastViewedSessionSeq: z.optional(z.number().check(z.int(), z.minimum(0))),
    unreadSince: z.optional(z.nullable(TimestampMsSchema)),
    viewer: z.optional(SessionViewerProjectionV1Schema),
    pendingPermissionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingUserActionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    pendingRequestObservedAt: z.optional(z.nullable(TimestampMsSchema)),
    latestReadyEventSeq: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0)))),
    latestReadyEventAt: z.optional(z.nullable(TimestampMsSchema)),
    latestReadyEventLocalId: z.optional(z.string().check(z.minLength(1))),
    latestTurnId: z.optional(z.nullable(TurnIdSchema)),
    latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
    latestTurnStatusObservedAt: z.optional(z.nullable(TimestampMsSchema)),
    lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    runtimeActivityState: z.optional(SessionRuntimeActivityStateSchema),
    runtimeActivityActiveCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    runtimeActivityObservedAt: z.optional(z.nullable(TimestampMsSchema)),
    runtimeActivityRevision: z.optional(z.number().check(z.int(), z.minimum(0))),
    meaningfulActivityAt: z.optional(TimestampMsSchema),
    archivedAt: z.optional(z.nullable(TimestampMsSchema)),
  }),
  z.looseObject({
    t: z.literal('pending-changed'),
    sid: z.string(),
    sessionId: z.optional(z.string()),
    pendingVersion: z.number().check(z.int(), z.minimum(0)),
    pendingCount: z.number().check(z.int(), z.minimum(0)),
    pendingBlockedCount: z.optional(z.number().check(z.int(), z.minimum(0))),
    recipient: z.optional(ParticipantExecutionRunRecipientRoutingIdentityV1Schema),
    changedByAccountId: z.optional(z.string()),
    meaningfulActivityAt: z.optional(TimestampMsSchema),
    pendingActivationRequestId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    pendingActivationAuthorization: z.optional(z.nullable(PendingActivationAuthorizationV1Schema)),
    managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  }),
  z.looseObject({
    t: z.literal('automation-upsert'),
    automationId: z.string(),
    version: z.number().check(z.int(), z.minimum(0)),
    enabled: z.boolean(),
    updatedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('automation-delete'),
    automationId: z.string(),
    deletedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('automation-run-updated'),
    runId: z.string(),
    // Direct Workflow Runs have no Automation identity. Machine-targeted
    // invalidations preserve that absence instead of fabricating one.
    automationId: z.nullable(z.string()),
    state: AutomationRunStateV3Schema,
    scheduledAt: TimestampMsSchema,
    startedAt: z.optional(z.nullable(TimestampMsSchema)),
    finishedAt: z.optional(z.nullable(TimestampMsSchema)),
    updatedAt: TimestampMsSchema,
    machineId: z.optional(z.nullable(z.string())),
    // Current producers publish the Run lease generation so a worker can
    // reject a same-machine reclaim. Older supported producers omit it.
    attempt: z.optional(z.number().check(z.int(), z.minimum(0))),
    /** Exact machine wake for persisted Workflow cancellation custody. */
    workflowControl: z.optional(z.enum(['cancel_requested', 'review_resolved'])),
    requesterScope: z.optional(WorkflowRequesterScopeV1Schema),
    managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  }),
  z.strictObject({
    t: z.literal('automation-run-state-changed'),
    ...AutomationRunStateChangedHostEventV1Schema.shape,
  }).check(z.superRefine((value, context) => {
    const { t: _type, ...payload } = value;
    const parsed = AutomationRunStateChangedHostEventV1Schema.safeParse(payload);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: issue.path });
    }
  })),
  z.looseObject({
    t: z.literal('automation-assignment-updated'),
    machineId: z.string(),
    automationId: z.string(),
    enabled: z.boolean(),
    updatedAt: TimestampMsSchema,
  }),
  z.strictObject({
    t: z.literal('automation-source-status-updated'),
  }),
  z.strictObject({
    t: z.literal('account-change'),
    // Advisory commit routing only; unknown kinds remain coarse at the reader.
    changeKinds: z.optional(z.array(z.string())),
    entityIds: z.optional(z.array(z.string())),
  }),
  z.looseObject({
    t: z.literal('delete-session'),
    sid: z.string(),
  }),
  z.looseObject({
    t: z.literal('update-account'),
    id: z.string(),
    // Omitted on profile-only updates; null withdraws encryption admission.
    encryptionCurrentness: z.optional(z.nullable(AccountEncryptionCurrentnessResponseSchema)),
    name: z.optional(z.nullable(z.string())),
  }),
  z.looseObject({
    t: z.literal('account-settings-changed'),
    settingsVersion: z.number().check(z.int(), z.minimum(0)),
  }),
  z.looseObject({
    t: z.literal('new-machine'),
    managedMachineRef: z.optional(z.nullable(ManagedMachineRefV1Schema)),
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
    access: z.optional(AccessibleMachineAccessV1Schema),
    keyBasis: z.optional(MachineKeyBasisV1Schema),
    storageMode: z.optional(z.enum(['plain', 'e2ee'])),
    kind: z.optional(MachineKindFromLegacyProjectionSchema),
    machineId: z.string(),
    seq: z.number().check(z.int(), z.minimum(0)),
    metadata: Base64Schema,
    metadataVersion: z.number().check(z.int()),
    daemonState: z.nullable(Base64Schema),
    daemonStateVersion: z.number().check(z.int()),
    dataEncryptionKey: z.nullable(Base64Schema),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('update-machine'),
    managedMachineRef: z.optional(z.nullable(ManagedMachineRefV1Schema)),
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
    access: z.optional(AccessibleMachineAccessV1Schema),
    keyBasis: z.optional(MachineKeyBasisV1Schema),
    storageMode: z.optional(z.enum(['plain', 'e2ee'])),
    dataEncryptionKey: z.optional(z.nullable(Base64Schema)),
    machineId: z.string(),
    metadata: z.optional(VersionedStringSchema),
    daemonState: z.optional(VersionedNullableStringSchema),
    activeAt: z.optional(TimestampMsSchema),
    active: z.optional(z.boolean()),
    revokedAt: z.optional(z.nullable(TimestampMsSchema)),
  }),
  z.looseObject({
    t: z.literal('new-artifact'),
    artifactId: z.string(),
    seq: z.number().check(z.int(), z.minimum(0)),
    header: Base64Schema,
    headerVersion: z.number().check(z.int()),
    body: Base64Schema,
    bodyVersion: z.number().check(z.int()),
    dataEncryptionKey: Base64Schema,
    provenance: z.optional(z.nullable(Base64Schema)),
    provenanceDataEncryptionKey: z.optional(z.nullable(Base64Schema)),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('update-artifact'),
    artifactId: z.string(),
    header: z.optional(VersionedStringSchema),
    body: z.optional(VersionedStringSchema),
    provenance: z.optional(z.nullable(Base64Schema)),
    provenanceDataEncryptionKey: z.optional(z.nullable(Base64Schema)),
  }),
  z.looseObject({
    t: z.literal('delete-artifact'),
    artifactId: z.string(),
  }),
  z.looseObject({
    t: z.literal('relationship-updated'),
    uid: z.string(),
    status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected']),
    timestamp: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('new-feed-post'),
    id: z.string(),
    body: z.unknown(),
    cursor: z.string(),
    createdAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.looseObject({
      key: z.string(),
      value: z.nullable(z.string()),
      version: z.number().check(z.int()),
    })),
  }),
  z.looseObject({
    t: z.literal('session-shared'),
    sessionId: z.string(),
    shareId: z.string(),
    sharedBy: z.looseObject({
      id: z.string(),
      firstName: z.nullable(z.string()),
      lastName: z.nullable(z.string()),
      username: z.nullable(z.string()),
      avatar: z.nullable(z.unknown()),
    }),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.optional(z.boolean()),
    /**
     * Received-only compatibility seam, never emitted by 0.3.
     *
     * The current producer deliberately omits key bytes from this event and the
     * recipient targeted-hydrates the canonical `(Session, Account)` envelope
     * instead. A supported released 0.2 Home still emits this field, so the
     * declaration stays to keep that peer's payload typed rather than falling
     * through as an unvalidated passthrough key. Remove it only once 0.2 leaves
     * the supported set; do not restore a 0.3 writer for it.
     */
    encryptedDataKey: z.optional(Base64Schema),
    createdAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('session-share-updated'),
    sessionId: z.string(),
    shareId: z.string(),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.optional(z.boolean()),
    updatedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('session-share-revoked'),
    sessionId: z.string(),
    shareId: z.string(),
  }),
  z.looseObject({
    t: z.literal('public-share-created'),
    sessionId: z.string(),
    publicShareId: z.string(),
    token: z.string(),
    expiresAt: z.nullable(TimestampMsSchema),
    maxUses: z.nullable(z.number().check(z.int())),
    isConsentRequired: z.boolean(),
    createdAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('public-share-updated'),
    sessionId: z.string(),
    publicShareId: z.string(),
    expiresAt: z.nullable(TimestampMsSchema),
    maxUses: z.nullable(z.number().check(z.int())),
    isConsentRequired: z.boolean(),
    updatedAt: TimestampMsSchema,
  }),
  z.looseObject({
    t: z.literal('public-share-deleted'),
    sessionId: z.string(),
  }),
]).check(z.superRefine((value, context) => {
  if (value.t !== 'new-session' && value.t !== 'update-session') return;
  if (parseSessionRuntimeActivityProjectionFields(value).kind !== 'invalid') return;
  context.addIssue({
    code: "custom",
    message: 'Runtime Activity projection fields must form one complete valid tuple',
    path: ['runtimeActivityState'],
  });
})));

export type UpdateBody = z.infer<typeof UpdateBodySchema>;

export const UpdateContainerSchema = lazyZodSchema(() => z.looseObject({
  id: z.string(),
  seq: z.number().check(z.int(), z.minimum(0)),
  createdAt: TimestampMsSchema,
  body: UpdateBodySchema,
}));

export type UpdateContainer = z.infer<typeof UpdateContainerSchema>;

export const TranscriptStreamSegmentEphemeralMessageSchema = lazyZodSchema(() => z.looseObject({
  localId: z.string().check(z.minLength(1)),
  sidechainId: z.optional(z.nullable(z.string())),
  content: SessionStoredMessageContentSchema,
  messageRole: SessionMessageRoleMetadataSchema,
  /**
   * Live-stream tick this full snapshot corresponds to (per-segment, monotonically increasing
   * across all live emissions). Checkpoint/resync anchor for `transcript-stream-segment-delta`
   * chaining. Optional: absent from older CLIs and stripped by older servers.
   */
  tick: z.optional(z.number().check(z.int(), z.minimum(0))),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
}));

/**
 * Delta form of the live transcript segment stream.
 *
 * `content` is the same stored-message envelope as the snapshot form (encrypted or plain), but the
 * ACP body inside carries ONLY the text appended since the previous live emission for this segment.
 * Receivers reconstruct the accumulated text from per-segment assembly state and MUST drop the
 * delta (and wait for the next full-snapshot checkpoint) on any gap: unknown segment, unexpected
 * `tick`, or `baseLength` mismatch.
 */
export const TranscriptStreamSegmentDeltaEphemeralMessageSchema = lazyZodSchema(() => z.looseObject({
  localId: z.string().check(z.minLength(1)),
  sidechainId: z.optional(z.nullable(z.string())),
  content: SessionStoredMessageContentSchema,
  messageRole: SessionMessageRoleMetadataSchema,
  /** Per-segment live emission sequence (1-based, includes snapshot emissions). */
  tick: z.number().check(z.int(), z.minimum(1)),
  /** Accumulated text length (UTF-16 code units) BEFORE applying this delta. */
  baseLength: z.number().check(z.int(), z.minimum(0)),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
}));

/** A committed, content-free recipient fact; never persisted or replayed as history. */
const SessionPersonalEventEphemeralBaseV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('session-personal-event'),
  sessionId: z.string().check(z.minLength(1)),
  eventId: z.string().check(z.minLength(1)),
}));

export const SessionPersonalEventEphemeralV1Schema = lazyZodSchema(() => z.discriminatedUnion('event', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.literal('directly_shared') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.literal('assigned'), assignmentAutoFollowed: z.optional(z.boolean()) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.literal('source_unavailable'),
    stalledOccurrence: z.optional(SessionFollowStalledOccurrenceV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.enum(['failed', 'cancelled']), turnId: TurnIdSchema })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.literal('human_message'), message: ActivityMessageReferenceV2Schema, sourceAccountId: z.string().check(z.minLength(1)) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPersonalEventEphemeralBaseV1Schema, { event: z.literal('message'), message: ActivityMessageReferenceV2Schema,
    followEvent: z.optional(z.strictObject({ kind: z.enum(['goal_changed', 'update_posted']) })),
  })),
]));

export type SessionPersonalEventEphemeralV1 = z.infer<typeof SessionPersonalEventEphemeralV1Schema>;

export const EphemeralUpdateSchema = lazyZodSchema(() => z.union([z.discriminatedUnion('type', [
  SessionMessageReplyPendingHintV1Schema,
  PendingActivationRequestedEphemeralV1Schema,
  // Hottest live event first: delta ticks stream at the live cadence (~25Hz per active segment).
  z.looseObject({
    type: z.literal('transcript-stream-segment-delta'),
    sessionId: z.string(),
    message: TranscriptStreamSegmentDeltaEphemeralMessageSchema,
  }),
  z.looseObject({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    thinking: z.optional(z.boolean()),
  }),
  z.looseObject({
    type: z.literal('execution-run-updated'),
    sessionId: z.string(),
    run: ExecutionRunPublicStateSchema,
  }).check(z.refine(value => value.machineId === undefined && value.runId === undefined)),
  z.looseObject({
    type: z.literal('transcript-stream-segment'),
    sessionId: z.string(),
    message: TranscriptStreamSegmentEphemeralMessageSchema,
  }),
  ExternalSessionTranscriptInvalidationV1Schema,
  UsageSourcesInvalidationV1Schema,
  z.looseObject({
    type: z.literal('machine-activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    /** Admitted daemon socket connection; ordinary heartbeats omit this hint. */
    reconnected: z.optional(z.literal(true)),
  }),
  z.looseObject({
    /** Canonical live inventory facts changed; no counts or work identities cross this wake. */
    type: z.literal('machine-work-summary-changed'),
    machineId: z.string(),
  }),
  z.looseObject({
    type: z.literal('usage'),
    // Native Account accounting has no Happier Session; it wakes Account readers.
    id: z.nullable(z.string()),
    key: z.string(),
    tokens: z.record(z.string(), z.number()),
    cost: z.record(z.string(), z.number()),
    timestamp: TimestampMsSchema,
    /** Captured request source; a wake hint, never permission to read that connection. */
    providerConnectionId: z.optional(z.string().check(z.minLength(1))),
    machineId: z.optional(z.string().check(z.minLength(1))),
    /** Advisory accounting read scope; null/absent remains Account-wide, never read authority. */
    accountingChange: z.optional(z.strictObject({
      sessionId: z.nullable(z.string().check(z.minLength(1))),
      observedFromMs: z.optional(TimestampMsSchema),
    })),
  }),
  /**
   * Content-free invalidation to a Team credential resource's usage readers after a
   * new immutable usage fact commits. Readers re-query the authorized usage projection.
   */
  z.looseObject({
    type: z.literal('team-credential-usage-changed'),
    resourceId: z.string().check(z.minLength(1)),
  }),
  z.looseObject({
    type: z.literal('machine-status'),
    machineId: z.string(),
    online: z.boolean(),
    timestamp: TimestampMsSchema,
  }),
  ActionOperationSnapshotEphemeralV1Schema,
  ActionOperationRevisionEphemeralV1Schema,
  SessionPersonalEventEphemeralV1Schema,
]), ExecutionRunMachineActivityEphemeralV1Schema]));

export type EphemeralUpdate = z.infer<typeof EphemeralUpdateSchema>;

// Broadcast-safe events (cursorless).
//
// These are intended for cases where a single identical payload can be emitted to a shared room (e.g. `session:${sessionId}`)
// without carrying per-account cursors or recipient-specific secrets.
//
// Important: clients must treat these as optional hints/optimizations only, never as the sole source of truth.
export const SessionBroadcastBodySchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.looseObject({
    t: z.literal('session-changed'),
    sessionId: z.string(),
  }),
]));

export type SessionBroadcastBody = z.infer<typeof SessionBroadcastBodySchema>;

export const SessionBroadcastContainerSchema = lazyZodSchema(() => z.looseObject({
  id: z.string(),
  createdAt: TimestampMsSchema,
  body: SessionBroadcastBodySchema,
}));

export type SessionBroadcastContainer = z.infer<typeof SessionBroadcastContainerSchema>;

export const MessageAckResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    id: z.string(),
    seq: z.number().check(z.int(), z.minimum(0)),
    localId: z.nullable(z.string()),
    /**
     * Whether the server actually created a new transcript row.
     *
     * - true: new message created + broadcast emitted (subject to sender-skip rules).
     * - false: idempotent duplicate (sessionId, localId) already existed; no broadcast is emitted.
     *
     * Optional for backward compatibility with older servers.
     */
    didWrite: z.optional(z.boolean()),
    didUpdate: z.optional(z.boolean()),
  }),
  z.looseObject({
    ok: z.literal(false),
    error: z.string(),
  }),
]));

export type MessageAckResponse = z.infer<typeof MessageAckResponseSchema>;

export const SessionEndAckResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    applied: z.boolean(),
    active: z.optional(z.literal(false)),
    activeAt: z.optional(TimestampMsSchema),
    latestTurnId: z.optional(z.nullable(TurnIdSchema)),
    latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
    latestTurnStatusObservedAt: z.optional(z.nullable(TimestampMsSchema)),
    lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    projection: z.optional(z.looseObject({
      active: z.optional(z.literal(false)),
      activeAt: z.optional(TimestampMsSchema),
      latestTurnId: z.optional(z.nullable(TurnIdSchema)),
      latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
      latestTurnStatusObservedAt: z.optional(z.nullable(TimestampMsSchema)),
      lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    })),
  }),
  z.looseObject({
    ok: z.literal(false),
    error: z.string(),
  }),
]));

export type SessionEndAckResponse = z.infer<typeof SessionEndAckResponseSchema>;

export const UpdateMetadataAckResponseSchema = lazyZodSchema(() => z.discriminatedUnion('result', [
  z.looseObject({
    result: z.literal('success'),
    version: z.number().check(z.int()),
    metadata: z.string(),
  }),
  z.looseObject({
    result: z.literal('version-mismatch'),
    version: z.number().check(z.int()),
    metadata: z.string(),
  }),
  z.looseObject({
    result: z.literal('forbidden'),
  }),
  z.looseObject({
    result: z.literal('metadata_privacy_upgrade_required'),
  }),
  z.looseObject({
    result: z.literal('error'),
  }),
]));

export type UpdateMetadataAckResponse = z.infer<typeof UpdateMetadataAckResponseSchema>;

export const UpdateStateAckResponseSchema = lazyZodSchema(() => z.discriminatedUnion('result', [
  z.looseObject({
    result: z.literal('success'),
    version: z.number().check(z.int()),
    agentState: z.nullable(z.string()),
  }),
  z.looseObject({
    result: z.literal('version-mismatch'),
    version: z.number().check(z.int()),
    agentState: z.nullable(z.string()),
  }),
  z.looseObject({
    result: z.literal('forbidden'),
  }),
  z.looseObject({
    result: z.literal('metadata_privacy_upgrade_required'),
  }),
  z.looseObject({
    result: z.literal('error'),
  }),
]));

export type UpdateStateAckResponse = z.infer<typeof UpdateStateAckResponseSchema>;
