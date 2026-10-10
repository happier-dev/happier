import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { MachineKindFromLegacyProjectionSchema } from '../machines/machineKind.js';
import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBinding.js';
import { SessionViewerProjectionV1Schema } from '../sessions/personal/viewer.js';
import { AutomationRunStateV3Schema } from '../automations/automationRunStateV3.js';
import { AutomationRunStateChangedHostEventV1Schema } from '../plugins/events/hostReferencesV1.js';
import { ExternalSessionTranscriptInvalidationV1Schema } from '../sessions/external/secureRefreshV1.js';
import { ExternalSessionStorageStateV1Schema } from '../sessions/external/operationV1.js';
import { ExecutionRunPublicStateSchema } from '../execution/runs/responseSchemas.js';
import { SessionMessageAttentionImpactSchema } from '../sessions/messages/transcriptRawRecordV1.js';
import { SessionMessageRoleSchema } from '../sessions/messages/sessionMessageRole.js';
import { SessionMessageAccountActorV1Schema } from '../sessions/messages/sessionMessageAccountActorV1.js';
import { SessionInputAdmissionReceiptV1Schema, PendingActivationRequestedEphemeralV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { UsageSourcesInvalidationV1Schema } from '../usage/usageSources.js';
import { SessionMessageDeliveryResolutionV1Schema } from '../sessions/messages/sessionMessageDeliveryResolutionV1.js';
import { SessionTranscriptObservationProvenanceV1Schema } from '../sessions/messages/transcriptObservationV1.js';
import { SessionStoredMessageContentSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { PrimaryTurnStatusV1Schema, SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { TurnIdSchema } from '../sessions/idsV1.js';
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

const TimestampMsSchema = lazyZodSchema(() => z.number().int().min(0));
const Base64Schema = lazyZodSchema(() => z.string());
const SessionMessageRoleMetadataSchema = lazyZodSchema(() => SessionMessageRoleSchema.nullable().optional());
const SessionEncryptionModeSchema = lazyZodSchema(() => z.enum(['e2ee', 'plain']));

const VersionedNullableStringSchema = lazyZodSchema(() => z.object({
  value: z.string().nullable(),
  version: z.number().int(),
}).passthrough());

const VersionedStringSchema = lazyZodSchema(() => z.object({
  value: z.string(),
  version: z.number().int(),
}).passthrough());

export const UpdateBodySchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('new-message'),
    sid: z.string(),
    message: z
      .object({
        id: z.string(),
        seq: z.number().int().min(0),
        content: SessionStoredMessageContentSchema,
        localId: z.string().nullable(),
        sidechainId: z.string().nullable().optional(),
        messageRole: SessionMessageRoleMetadataSchema,
        deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
        attentionImpact: SessionMessageAttentionImpactSchema.optional(),
        createdAt: TimestampMsSchema,
        updatedAt: TimestampMsSchema,
        sourceCreatedAt: TimestampMsSchema.optional(),
        sourceUpdatedAt: TimestampMsSchema.optional(),
        transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
        /**
         * Additive authenticated-reader actor projection. Omitted means an
         * older producer (preserve any known actor); explicit `null` means the
         * current producer evaluated this row and denies Account attribution.
         */
        accountActor: SessionMessageAccountActorV1Schema.nullable().optional(),
        inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.optional(),
      })
      .passthrough(),
  }).passthrough(),
  z.object({
    t: z.literal('message-updated'),
    sid: z.string(),
    message: z
      .object({
        id: z.string(),
        seq: z.number().int().min(0),
        content: SessionStoredMessageContentSchema,
        localId: z.string().nullable(),
        sidechainId: z.string().nullable().optional(),
        messageRole: SessionMessageRoleMetadataSchema,
        deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
        attentionImpact: SessionMessageAttentionImpactSchema.optional(),
        createdAt: TimestampMsSchema,
        updatedAt: TimestampMsSchema,
        sourceCreatedAt: TimestampMsSchema.optional(),
        sourceUpdatedAt: TimestampMsSchema.optional(),
        transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
        /**
         * Additive authenticated-reader actor projection. Omitted means an
         * older producer (preserve any known actor); explicit `null` means the
         * current producer evaluated this row and denies Account attribution.
         */
        accountActor: SessionMessageAccountActorV1Schema.nullable().optional(),
        inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.optional(),
      })
      .passthrough(),
  }).passthrough(),
  z.object({
    t: z.literal('new-session'),
    id: z.string(),
    viewer: SessionViewerProjectionV1Schema.optional(),
    seq: z.number().int().min(0),
    metadata: Base64Schema,
    metadataVersion: z.number().int(),
    metadataLayoutVersion: z.number().int().nonnegative().optional(),
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema.nullable().optional(),
    agentState: Base64Schema.nullable(),
    agentStateVersion: z.number().int(),
    dataEncryptionKey: Base64Schema.nullable(),
    runnerContentKeyBinding: RunnerMachineContentKeyBindingV1Schema.nullable().optional(),
    encryptionMode: SessionEncryptionModeSchema.optional(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    meaningfulActivityAt: TimestampMsSchema.optional(),
    /** Where the Session's transcript lives (an imported external session starts `machine_only`). */
    currentStorageState: ExternalSessionStorageStateV1Schema.optional(),
  }).passthrough(),
  z.object({
    t: z.literal('update-session'),
    id: z.string(),
    metadata: VersionedNullableStringSchema.optional(),
    metadataLayoutVersion: z.number().int().nonnegative().optional(),
    ownerMetadata: z.object({
      value: SessionOwnerMetadataEnvelopeV1Schema,
    }).strict().optional(),
    agentState: VersionedNullableStringSchema.optional(),
    active: z.boolean().optional(),
    activeAt: TimestampMsSchema.optional(),
    lastViewedSessionSeq: z.number().int().min(0).optional(),
    unreadSince: TimestampMsSchema.nullable().optional(),
    viewer: SessionViewerProjectionV1Schema.optional(),
    pendingPermissionRequestCount: z.number().int().min(0).optional(),
    pendingUserActionRequestCount: z.number().int().min(0).optional(),
    pendingRequestObservedAt: TimestampMsSchema.nullable().optional(),
    latestReadyEventSeq: z.number().int().min(0).nullable().optional(),
    latestReadyEventAt: TimestampMsSchema.nullable().optional(),
    latestReadyEventLocalId: z.string().min(1).optional(),
    latestTurnId: TurnIdSchema.nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: TimestampMsSchema.nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    runtimeActivityState: SessionRuntimeActivityStateSchema.optional(),
    runtimeActivityActiveCount: z.number().int().min(0).optional(),
    runtimeActivityObservedAt: TimestampMsSchema.nullable().optional(),
    runtimeActivityRevision: z.number().int().min(0).optional(),
    meaningfulActivityAt: TimestampMsSchema.optional(),
    archivedAt: TimestampMsSchema.nullable().optional(),
  }).passthrough(),
  z.object({
    t: z.literal('pending-changed'),
    sid: z.string(),
    sessionId: z.string().optional(),
    pendingVersion: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    pendingBlockedCount: z.number().int().min(0).optional(),
    recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema.optional(),
    changedByAccountId: z.string().optional(),
    meaningfulActivityAt: TimestampMsSchema.optional(),
    pendingActivationRequestId: z.string().trim().min(1).optional(),
    pendingActivationAuthorization: PendingActivationAuthorizationV1Schema.nullable().optional(),
    managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  }).passthrough(),
  z.object({
    t: z.literal('automation-upsert'),
    automationId: z.string(),
    version: z.number().int().min(0),
    enabled: z.boolean(),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('automation-delete'),
    automationId: z.string(),
    deletedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('automation-run-updated'),
    runId: z.string(),
    // Direct Workflow Runs have no Automation identity. Machine-targeted
    // invalidations preserve that absence instead of fabricating one.
    automationId: z.string().nullable(),
    state: AutomationRunStateV3Schema,
    scheduledAt: TimestampMsSchema,
    startedAt: TimestampMsSchema.nullable().optional(),
    finishedAt: TimestampMsSchema.nullable().optional(),
    updatedAt: TimestampMsSchema,
    machineId: z.string().nullable().optional(),
    // Current producers publish the Run lease generation so a worker can
    // reject a same-machine reclaim. Older supported producers omit it.
    attempt: z.number().int().min(0).optional(),
    /** Exact machine wake for persisted Workflow cancellation custody. */
    workflowControl: z.enum(['cancel_requested', 'review_resolved']).optional(),
    managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  }).passthrough(),
  z.object({
    t: z.literal('automation-run-state-changed'),
    ...AutomationRunStateChangedHostEventV1Schema.shape,
  }).strict().superRefine((value, context) => {
    const { t: _type, ...payload } = value;
    const parsed = AutomationRunStateChangedHostEventV1Schema.safeParse(payload);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: issue.path });
    }
  }),
  z.object({
    t: z.literal('automation-assignment-updated'),
    machineId: z.string(),
    automationId: z.string(),
    enabled: z.boolean(),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('automation-source-status-updated'),
  }).strict(),
  z.object({
    t: z.literal('account-change'),
  }).strict(),
  z.object({
    t: z.literal('delete-session'),
    sid: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('update-account'),
    id: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('account-settings-changed'),
    settingsVersion: z.number().int().min(0),
  }).passthrough(),
  z.object({
    t: z.literal('new-machine'),
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
    access: AccessibleMachineAccessV1Schema.optional(),
    keyBasis: MachineKeyBasisV1Schema.optional(),
    storageMode: z.enum(['plain', 'e2ee']).optional(),
    kind: MachineKindFromLegacyProjectionSchema.optional(),
    machineId: z.string(),
    seq: z.number().int().min(0),
    metadata: Base64Schema,
    metadataVersion: z.number().int(),
    daemonState: Base64Schema.nullable(),
    daemonStateVersion: z.number().int(),
    dataEncryptionKey: Base64Schema.nullable(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('update-machine'),
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)),
    access: AccessibleMachineAccessV1Schema.optional(),
    keyBasis: MachineKeyBasisV1Schema.optional(),
    storageMode: z.enum(['plain', 'e2ee']).optional(),
    dataEncryptionKey: Base64Schema.nullable().optional(),
    machineId: z.string(),
    metadata: VersionedStringSchema.optional(),
    daemonState: VersionedNullableStringSchema.optional(),
    activeAt: TimestampMsSchema.optional(),
    active: z.boolean().optional(),
    revokedAt: TimestampMsSchema.nullable().optional(),
  }).passthrough(),
  z.object({
    t: z.literal('new-artifact'),
    artifactId: z.string(),
    seq: z.number().int().min(0),
    header: Base64Schema,
    headerVersion: z.number().int(),
    body: Base64Schema,
    bodyVersion: z.number().int(),
    dataEncryptionKey: Base64Schema,
    provenance: Base64Schema.nullable().optional(),
    provenanceDataEncryptionKey: Base64Schema.nullable().optional(),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('update-artifact'),
    artifactId: z.string(),
    header: VersionedStringSchema.optional(),
    body: VersionedStringSchema.optional(),
    provenance: Base64Schema.nullable().optional(),
    provenanceDataEncryptionKey: Base64Schema.nullable().optional(),
  }).passthrough(),
  z.object({
    t: z.literal('delete-artifact'),
    artifactId: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('relationship-updated'),
    uid: z.string(),
    status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected']),
    timestamp: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('new-feed-post'),
    id: z.string(),
    body: z.unknown(),
    cursor: z.string(),
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.object({
      key: z.string(),
      value: z.string().nullable(),
      version: z.number().int(),
    }).passthrough()),
  }).passthrough(),
  z.object({
    t: z.literal('session-shared'),
    sessionId: z.string(),
    shareId: z.string(),
    sharedBy: z.object({
      id: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      username: z.string().nullable(),
      avatar: z.unknown().nullable(),
    }).passthrough(),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.boolean().optional(),
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
    encryptedDataKey: Base64Schema.optional(),
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('session-share-updated'),
    sessionId: z.string(),
    shareId: z.string(),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.boolean().optional(),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('session-share-revoked'),
    sessionId: z.string(),
    shareId: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('public-share-created'),
    sessionId: z.string(),
    publicShareId: z.string(),
    token: z.string(),
    expiresAt: TimestampMsSchema.nullable(),
    maxUses: z.number().int().nullable(),
    isConsentRequired: z.boolean(),
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('public-share-updated'),
    sessionId: z.string(),
    publicShareId: z.string(),
    expiresAt: TimestampMsSchema.nullable(),
    maxUses: z.number().int().nullable(),
    isConsentRequired: z.boolean(),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('public-share-deleted'),
    sessionId: z.string(),
  }).passthrough(),
]).superRefine((value, context) => {
  if (value.t !== 'new-session' && value.t !== 'update-session') return;
  if (parseSessionRuntimeActivityProjectionFields(value).kind !== 'invalid') return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Runtime Activity projection fields must form one complete valid tuple',
    path: ['runtimeActivityState'],
  });
}));

export type UpdateBody = z.infer<typeof UpdateBodySchema>;

export const UpdateContainerSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  seq: z.number().int().min(0),
  createdAt: TimestampMsSchema,
  body: UpdateBodySchema,
}).passthrough());

export type UpdateContainer = z.infer<typeof UpdateContainerSchema>;

export const TranscriptStreamSegmentEphemeralMessageSchema = lazyZodSchema(() => z.object({
  localId: z.string().min(1),
  sidechainId: z.string().nullable().optional(),
  content: SessionStoredMessageContentSchema,
  messageRole: SessionMessageRoleMetadataSchema,
  /**
   * Live-stream tick this full snapshot corresponds to (per-segment, monotonically increasing
   * across all live emissions). Checkpoint/resync anchor for `transcript-stream-segment-delta`
   * chaining. Optional: absent from older CLIs and stripped by older servers.
   */
  tick: z.number().int().min(0).optional(),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
}).passthrough());

/**
 * Delta form of the live transcript segment stream.
 *
 * `content` is the same stored-message envelope as the snapshot form (encrypted or plain), but the
 * ACP body inside carries ONLY the text appended since the previous live emission for this segment.
 * Receivers reconstruct the accumulated text from per-segment assembly state and MUST drop the
 * delta (and wait for the next full-snapshot checkpoint) on any gap: unknown segment, unexpected
 * `tick`, or `baseLength` mismatch.
 */
export const TranscriptStreamSegmentDeltaEphemeralMessageSchema = lazyZodSchema(() => z.object({
  localId: z.string().min(1),
  sidechainId: z.string().nullable().optional(),
  content: SessionStoredMessageContentSchema,
  messageRole: SessionMessageRoleMetadataSchema,
  /** Per-segment live emission sequence (1-based, includes snapshot emissions). */
  tick: z.number().int().min(1),
  /** Accumulated text length (UTF-16 code units) BEFORE applying this delta. */
  baseLength: z.number().int().min(0),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
}).passthrough());

/** A committed, content-free recipient fact; never persisted or replayed as history. */
const SessionPersonalEventEphemeralBaseV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('session-personal-event'),
  sessionId: z.string().min(1),
  eventId: z.string().min(1),
}).strict());

export const SessionPersonalEventEphemeralV1Schema = lazyZodSchema(() => z.discriminatedUnion('event', [
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.literal('directly_shared') }).strict(),
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.literal('assigned'), assignmentAutoFollowed: z.boolean().optional() }).strict(),
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.literal('source_unavailable') }).strict(),
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.enum(['failed', 'cancelled']), turnId: TurnIdSchema }).strict(),
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.literal('human_message'), message: ActivityMessageReferenceV2Schema, sourceAccountId: z.string().min(1) }).strict(),
  SessionPersonalEventEphemeralBaseV1Schema.extend({ event: z.literal('message'), message: ActivityMessageReferenceV2Schema }).strict(),
]));

export type SessionPersonalEventEphemeralV1 = z.infer<typeof SessionPersonalEventEphemeralV1Schema>;

export const EphemeralUpdateSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  PendingActivationRequestedEphemeralV1Schema,
  // Hottest live event first: delta ticks stream at the live cadence (~25Hz per active segment).
  z.object({
    type: z.literal('transcript-stream-segment-delta'),
    sessionId: z.string(),
    message: TranscriptStreamSegmentDeltaEphemeralMessageSchema,
  }).passthrough(),
  z.object({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    thinking: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('execution-run-updated'),
    sessionId: z.string(),
    run: ExecutionRunPublicStateSchema,
  }).passthrough(),
  z.object({
    type: z.literal('transcript-stream-segment'),
    sessionId: z.string(),
    message: TranscriptStreamSegmentEphemeralMessageSchema,
  }).passthrough(),
  ExternalSessionTranscriptInvalidationV1Schema,
  UsageSourcesInvalidationV1Schema,
  z.object({
    type: z.literal('machine-activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    type: z.literal('usage'),
    // Native Account accounting has no Happier Session; it wakes Account readers.
    id: z.string().nullable(),
    key: z.string(),
    tokens: z.record(z.string(), z.number()),
    cost: z.record(z.string(), z.number()),
    timestamp: TimestampMsSchema,
  }).passthrough(),
  /**
   * Content-free invalidation to a Team credential resource's usage readers after a
   * new immutable usage fact commits. Readers re-query the authorized usage projection.
   */
  z.object({
    type: z.literal('team-credential-usage-changed'),
    resourceId: z.string().min(1),
  }).passthrough(),
  z.object({
    type: z.literal('machine-status'),
    machineId: z.string(),
    online: z.boolean(),
    timestamp: TimestampMsSchema,
  }).passthrough(),
  ActionOperationSnapshotEphemeralV1Schema,
  ActionOperationRevisionEphemeralV1Schema,
  SessionPersonalEventEphemeralV1Schema,
]));

export type EphemeralUpdate = z.infer<typeof EphemeralUpdateSchema>;

// Broadcast-safe events (cursorless).
//
// These are intended for cases where a single identical payload can be emitted to a shared room (e.g. `session:${sessionId}`)
// without carrying per-account cursors or recipient-specific secrets.
//
// Important: clients must treat these as optional hints/optimizations only, never as the sole source of truth.
export const SessionBroadcastBodySchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('session-changed'),
    sessionId: z.string(),
  }).passthrough(),
]));

export type SessionBroadcastBody = z.infer<typeof SessionBroadcastBodySchema>;

export const SessionBroadcastContainerSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  createdAt: TimestampMsSchema,
  body: SessionBroadcastBodySchema,
}).passthrough());

export type SessionBroadcastContainer = z.infer<typeof SessionBroadcastContainerSchema>;

export const MessageAckResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    id: z.string(),
    seq: z.number().int().min(0),
    localId: z.string().nullable(),
    /**
     * Whether the server actually created a new transcript row.
     *
     * - true: new message created + broadcast emitted (subject to sender-skip rules).
     * - false: idempotent duplicate (sessionId, localId) already existed; no broadcast is emitted.
     *
     * Optional for backward compatibility with older servers.
     */
    didWrite: z.boolean().optional(),
    didUpdate: z.boolean().optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }).passthrough(),
]));

export type MessageAckResponse = z.infer<typeof MessageAckResponseSchema>;

export const SessionEndAckResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    applied: z.boolean(),
    active: z.literal(false).optional(),
    activeAt: TimestampMsSchema.optional(),
    latestTurnId: TurnIdSchema.nullable().optional(),
    latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
    latestTurnStatusObservedAt: TimestampMsSchema.nullable().optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    projection: z.object({
      active: z.literal(false).optional(),
      activeAt: TimestampMsSchema.optional(),
      latestTurnId: TurnIdSchema.nullable().optional(),
      latestTurnStatus: PrimaryTurnStatusV1Schema.nullable().optional(),
      latestTurnStatusObservedAt: TimestampMsSchema.nullable().optional(),
      lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }).passthrough(),
]));

export type SessionEndAckResponse = z.infer<typeof SessionEndAckResponseSchema>;

export const UpdateMetadataAckResponseSchema = lazyZodSchema(() => z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    version: z.number().int(),
    metadata: z.string(),
  }).passthrough(),
  z.object({
    result: z.literal('version-mismatch'),
    version: z.number().int(),
    metadata: z.string(),
  }).passthrough(),
  z.object({
    result: z.literal('forbidden'),
  }).passthrough(),
  z.object({
    result: z.literal('metadata_privacy_upgrade_required'),
  }).passthrough(),
  z.object({
    result: z.literal('error'),
  }).passthrough(),
]));

export type UpdateMetadataAckResponse = z.infer<typeof UpdateMetadataAckResponseSchema>;

export const UpdateStateAckResponseSchema = lazyZodSchema(() => z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    version: z.number().int(),
    agentState: z.string().nullable(),
  }).passthrough(),
  z.object({
    result: z.literal('version-mismatch'),
    version: z.number().int(),
    agentState: z.string().nullable(),
  }).passthrough(),
  z.object({
    result: z.literal('forbidden'),
  }).passthrough(),
  z.object({
    result: z.literal('metadata_privacy_upgrade_required'),
  }).passthrough(),
  z.object({
    result: z.literal('error'),
  }).passthrough(),
]));

export type UpdateStateAckResponse = z.infer<typeof UpdateStateAckResponseSchema>;
