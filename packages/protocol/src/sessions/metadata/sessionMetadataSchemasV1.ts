import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { NonBlankOpaqueIdentifierSchema, readNonBlankOpaqueIdentifier } from '../../strings/opaqueIdentifier.js';
import { z } from 'zod/mini';
import { SessionPermissionApprovalReviewerClaimV1Schema } from '../permissions/v1.js';
import { SessionForkFilesNotCopiedV1Schema } from '../creation/sessionSpawnNewResultV1.js';
import { SessionPublisherGenerationV1Schema } from '../control/machineSessionTerminalV1.js';
import { SessionForkVisualCopyV1Schema, SessionForkVisualsV1Schema } from '../board/forkVisualCopies.js';
import { SessionUserActionRequiredOccurrenceV1Schema } from '../userActionRequiredOccurrenceV1.js';
import { SessionDisplayProjectionV1Schema } from './sessionDisplaySchemasV1.js';
export { SessionDisplayProjectionV1Schema, validateSessionDisplayProjectionV1 } from './sessionDisplaySchemasV1.js';
export type { SessionDisplayProjectionV1 } from './sessionDisplaySchemasV1.js';

import type { AccountEncryptionMode } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { readAccountScopedCiphertextKindByte } from '../../crypto/accountScopedCipherEnvelope.js';
import { AgentModelOptionOverrideRuleSchema } from '../../models/descriptor.js';
import { AgentNativeResumeIdentityV1Schema } from '../../agents/nativeResumeIdentityV1.js';
import {
  GENERATED_SESSION_PRESENTATION_COMPAT_V1,
  resolveGeneratedSessionPresentationAgentIdV1,
} from '../../agents/generated/sessionPresentationCompatV1.js';
import {
  ConnectedServiceIdSchema,
  ConnectedServiceBindingsV2IngressSchema,
} from '../../connect/connectedServiceBindings.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../../connect/connectedServiceSchemas.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { PluginAgentSessionCompactionCapabilityV2Schema } from '../../plugins/contributions/agentSessionCapabilities.js';
import {
  SessionAppliedModelV1Schema,
  SessionModelSelectionIntentV1Schema,
} from '../../providers/selection/v1.js';
import { SessionActiveModelSelectionSchema, SessionModelSelectionV2Schema } from '../../providers/selection/v2.js';
import { SessionProviderBindingMetadataV1Schema } from '../../providers/sessions/bindingMetadataV1.js';
import {
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionOperationStateV1Schema,
  projectExternalSessionOperationSharedPresentationV1,
} from '../external/operationV1.js';
import { ExternalAgentObservationSnapshotV1Schema } from '../external/externalAgentObservationV1.js';
import {
  buildLinkedExternalSessionMetadataV1,
  ExternalHistoryImportV1Schema,
  resolveExternalHistoryImportV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
} from '../external/linkedSessionMetadata.js';
import { readRuntimeDescriptorV1 } from './runtimeDescriptorV1.js';
import { SessionDirectoryV1Schema } from './sessionDirectoryV1.js';
import { SessionBotV1Schema, readSessionBotV1 } from '../identity/sessionBotV1.js';
import { SessionVoicePreferenceV1Schema } from '../instructions/sessionVoicePreferenceV1.js';
import { SessionPromptStackV1Schema, SessionDisabledInheritedEntryIdsV1Schema, migrateRetainedSessionWorkContextV1, migrateRetainedSessionMetadataContextV1 } from '../context/sessionContextV1.js';
import { SessionRunnerRuntimeStateV1Schema } from '../control/sessionRunnerRuntimeV1.js';
import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from '../runtime/activity/sessionRuntimeActivity.js';
import { SessionPendingQueueHoldV1Schema } from './sessionPendingQueueHoldV1.js';
import { SessionExplicitStopV1Schema } from './sessionExplicitStopV1.js';
import { ProviderAccountUsageRefsV1Schema } from './providerAccountUsageRefsV1.js';
import { projectRuntimeDescriptorV1ForPredecessor } from './compat/runtimeDescriptorMetadata.js';
import { SessionUsageLimitRecoveryV1Schema } from '../state/valueSchemas/usageLimitRecovery.js';
import { SessionRollbackTargetSchema } from '../rollback.js';
import { parseVoiceAgentRunMetadataV1 } from '../../voice/voiceAgentRunMetadataV1.js';
import { VoiceProviderIdSchema } from '../../voice/realtime/providerSettings.js';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { ContentPublicKeyFingerprintSchema } from '../../machines/identity/contentPublicKeyFingerprint.js';
import { SessionWorkspaceLocationV1Schema } from './sessionWorkspaceLocationV1.js';
import { SessionCreationCorrespondenceV1Schema } from '../creation/sessionCreationCorrespondenceV1.js';
import { SessionAttestedContextV1Schema } from '../creation/sessionAttestedContextV1.js';
import { MachinePoolSelectionOriginV1Schema } from '../../machines/pools/v1.js';
import { DiscussionSelectionSourceV1Schema } from '../../discussions/references.js';
import { SessionActionConfirmationsV1Schema } from './sessionActionConfirmationsV1.js';
import { SessionRolesV1Schema } from '../../prompts/roles/sessionRolesSnapshot.js';
import { PluginUiNewSessionSeedOriginV1Schema } from '../../plugins/ui/newSessionSeedOrigin.js';
import { createSessionTerminalMetadataSchema } from './terminalMetadata.js';
import { SessionGuardStateV1Schema } from '../../machines/guard/sessionGuardStateV1.js';
import { SessionMcpSelectionAuthoringV1Schema, SessionMcpSelectionRestartRequiredAuthoringV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { SessionSkillSelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { CapabilitySelectionApplyAuthoringV1Schema, SessionSkillSelectionRestartRequiredAuthoringV1Schema } from '../../reach/sessionCapabilityMetadataV1.js';
import { SessionCapabilityAgentFactsV1Schema } from '../../reach/capabilityApplyTimingV1.js';
import { SessionOwnerWorkspaceV1Schema, SessionOwnerCursorsV1Schema, SessionSharedAgentPresentationV1Schema, type SessionSharedAgentPresentationV1 } from './sessionMetadataPresentationSchemasV1.js';
export { SessionSharedAgentPresentationV1Schema, type SessionSharedAgentPresentationV1 } from './sessionMetadataPresentationSchemasV1.js';

export const SESSION_METADATA_LAYOUT_VERSION_V1 = 1 as const;
export const SESSION_SHARED_METADATA_VERSION_V1 = 1 as const;
export const SESSION_OWNER_METADATA_VERSION_V1 = 1 as const;
export const SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND =
  'session_owner_metadata' as const;
export const SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND_BYTE_V1 = 26 as const;

const BoundedIdentifierSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const BoundedPresentationTextSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048)));
const TimestampSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const SessionEnvelopeVersionSchema =
  lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const SessionOpaqueCiphertextSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(10_000_000)));
const MAX_PUBLIC_COMPLETED_REQUESTS_V1 = 2_048;

// Proof belongs to the parsed envelope's lifetime, not a process-wide list of
// ciphertext strings. Mutating its c field invalidates this identity proof.
const validatedOwnerMetadataCiphertexts = new WeakMap<object, string>();
let ownerMetadataCiphertextValidationScope: Map<string, boolean> | null = null;

/** Reuse canonical structural validation during one synchronous schema read. */
export function withSessionOwnerMetadataCiphertextValidationReuseV1<T>(
  previousEnvelopes: Iterable<unknown>,
  parse: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  const enclosing = ownerMetadataCiphertextValidationScope;
  const scope = new Map(enclosing);
  for (const envelope of previousEnvelopes) {
    if (envelope === null || typeof envelope !== 'object') continue;
    const ciphertext = validatedOwnerMetadataCiphertexts.get(envelope);
    if (ciphertext !== undefined && 'c' in envelope && envelope.c === ciphertext) scope.set(ciphertext, true);
  }
  ownerMetadataCiphertextValidationScope = scope;
  try {
    return parse();
  } finally {
    ownerMetadataCiphertextValidationScope = enclosing;
  }
}

export const SessionOwnerMetadataCiphertextV1Schema =
  lazyZodSchema(() => SessionOpaqueCiphertextSchema.check(z.refine(isSessionOwnerMetadataCiphertextV1, {
    message: 'Expected canonical Session owner-metadata ciphertext',
  })));
export type SessionOwnerMetadataCiphertextV1 = z.infer<
  typeof SessionOwnerMetadataCiphertextV1Schema
>;

const SessionOwnerMetadataEnvelopeStructureV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: z.lazy(() => SessionOwnerMetadataV1Schema),
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: SessionOpaqueCiphertextSchema,
  }).check(z.refine(envelope => {
    if (!isSessionOwnerMetadataCiphertextV1(envelope.c)) return false;
    validatedOwnerMetadataCiphertexts.set(envelope, envelope.c);
    return true;
  }, { path: ['c'], message: 'Expected canonical Session owner-metadata ciphertext' })),
]));

// Keep the ordinary strict parser and its JSON-schema identity. Only the
// expensive ciphertext check borrows proof from this exact input object;
// object keys, the plain branch and all refinements still run on every read.
function reuseOwnerMetadataCiphertextProof<T extends z.core.$ZodType>(schema: T): T {
  const reader = z.core.clone(schema);
  const run = reader._zod.run;
  reader._zod.run = (payload, context) => withSessionOwnerMetadataCiphertextValidationReuseV1(
    [payload.value], () => ({ result: run(payload, context) }),
  ).result;
  return reader;
}

export const SessionOwnerMetadataEnvelopeV1Schema = lazyZodSchema(() =>
  reuseOwnerMetadataCiphertextProof(SessionOwnerMetadataEnvelopeStructureV1Schema));
defineStoredReadProjection(SessionOwnerMetadataEnvelopeV1Schema, () =>
  reuseOwnerMetadataCiphertextProof(createStoredReadSchema(SessionOwnerMetadataEnvelopeStructureV1Schema)));
export type SessionOwnerMetadataEnvelopeV1 = z.infer<
  typeof SessionOwnerMetadataEnvelopeV1Schema
>;

export type ValidateSessionOwnerMetadataEnvelopeForAccountModeV1Result =
  | Readonly<{
    ok: true;
    envelope: SessionOwnerMetadataEnvelopeV1;
  }>
  | Readonly<{
    ok: false;
    reason: 'invalid_envelope' | 'account_mode_mismatch';
  }>;

export type OpenSessionOwnerMetadataEnvelopeV1Result =
  | Readonly<{
    ok: true;
    ownerMetadata: SessionOwnerMetadataV1;
  }>
  | Readonly<{
    ok: false;
    reason:
      | 'invalid_envelope'
      | 'account_mode_mismatch'
      | 'material_unavailable'
      | 'invalid_ciphertext';
  }>;

export const SessionMetadataEnvelopeTupleV1Schema = lazyZodSchema(() => z.strictObject({
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.strictObject({
    ciphertext: SessionOpaqueCiphertextSchema,
    version: SessionEnvelopeVersionSchema,
  }),
  ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  agentState: z.strictObject({
    ciphertext: z.nullable(SessionOpaqueCiphertextSchema),
    version: SessionEnvelopeVersionSchema,
  }),
}));
export type SessionMetadataEnvelopeTupleV1 = z.infer<
  typeof SessionMetadataEnvelopeTupleV1Schema
>;

const SessionMetadataSharedPatchV1Schema = lazyZodSchema(() => z.strictObject({
  ciphertext: SessionOpaqueCiphertextSchema,
  expectedVersion: SessionEnvelopeVersionSchema,
}));

export const SessionAgentStateActivitySummaryV1Schema = lazyZodSchema(() => z.strictObject({
  pendingPermissionRequestCount: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  pendingUserActionRequestCount: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  pendingRequestNewestCreatedAt: z.nullable(TimestampSchema),
  /** Newly pending main-turn requests, committed with this exact Agent-state revision. */
  newUserActionRequiredOccurrences: z.optional(z.array(SessionUserActionRequiredOccurrenceV1Schema)),
}));

/** Shared host confirmations require approval, independent of the owner's Agent state. */
export const SessionSharedActionConfirmationSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  // This projection is persisted in a Prisma Int (signed 32-bit) column.
  pendingPermissionRequestCount: z.number().check(z.int(), z.nonnegative(), z.maximum(2_147_483_647)),
}));

const SessionMetadataOwnerMigrationPatchBaseV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.literal('owner_migration'),
  activitySummaryV1: z.optional(SessionAgentStateActivitySummaryV1Schema),
  sharedActionConfirmationSummaryV1: z.optional(SessionSharedActionConfirmationSummaryV1Schema),
  source: z.strictObject({
    metadataLayoutVersion: z.literal(0),
    metadata: z.strictObject({
      version: SessionEnvelopeVersionSchema,
      ciphertext: SessionOpaqueCiphertextSchema,
    }),
    ownerMetadata: z.null(),
    agentState: z.strictObject({
      version: SessionEnvelopeVersionSchema,
      ciphertext: z.nullable(SessionOpaqueCiphertextSchema),
    }),
  }),
  target: z.strictObject({
    metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    displayProjectionV1: z.optional(z.nullable(SessionDisplayProjectionV1Schema)),
    sharedMetadata: z.strictObject({
      ciphertext: SessionOpaqueCiphertextSchema,
    }),
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
    agentState: z.strictObject({
      ciphertext: z.nullable(SessionOpaqueCiphertextSchema),
    }),
  }),
}));

export const SessionMetadataOwnerMigrationPatchV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('expectedAccountEncryptionMode', [
    z.extend(SessionMetadataOwnerMigrationPatchBaseV1Schema, {
      expectedAccountEncryptionMode: z.literal('plain'),
      expectedAccountContentPublicKeyFingerprint: z.null(),
    }),
    z.extend(SessionMetadataOwnerMigrationPatchBaseV1Schema, {
      expectedAccountEncryptionMode: z.literal('e2ee'),
      expectedAccountContentPublicKeyFingerprint:
        ContentPublicKeyFingerprintSchema,
    }),
  ]));
export type SessionMetadataOwnerMigrationPatchV1 = z.infer<
  typeof SessionMetadataOwnerMigrationPatchV1Schema
>;

export const SessionMetadataInactiveModelIntentExpectationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('inactive_model_intent'),
}));
export type SessionMetadataInactiveModelIntentExpectationV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentExpectationV1Schema
>;

export const SessionMetadataInactiveModelIntentPatchV1Schema = lazyZodSchema(() => z.strictObject({
  inactiveModelIntent: z.strictObject({
    metadata: SessionMetadataSharedPatchV1Schema,
    sessionExpectation:
      SessionMetadataInactiveModelIntentExpectationV1Schema,
  }),
}));
export type SessionMetadataInactiveModelIntentPatchV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentPatchV1Schema
>;

export const SessionMetadataPublisherPreconditionV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: BoundedIdentifierSchema,
  committedFenceMs: TimestampSchema,
  publisherGeneration: SessionPublisherGenerationV1Schema,
}));
export type SessionMetadataPublisherPreconditionV1 = z.infer<
  typeof SessionMetadataPublisherPreconditionV1Schema
>;

export const SessionMetadataOwnerPatchV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.literal('owner'),
  displayProjectionV1: z.optional(z.nullable(SessionDisplayProjectionV1Schema)),
  projectKey: z.optional(NonBlankOpaqueIdentifierSchema),
  activitySummaryV1: z.optional(SessionAgentStateActivitySummaryV1Schema),
  sharedActionConfirmationSummaryV1: z.optional(SessionSharedActionConfirmationSummaryV1Schema),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  publisherPrecondition:
    z.optional(SessionMetadataPublisherPreconditionV1Schema),
  expectedOwnerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  sharedMetadata: SessionMetadataSharedPatchV1Schema,
  ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  agentState: z.strictObject({
    ciphertext: z.nullable(SessionOpaqueCiphertextSchema),
    expectedVersion: SessionEnvelopeVersionSchema,
  }),
}));
export type SessionMetadataOwnerPatchV1 = z.infer<
  typeof SessionMetadataOwnerPatchV1Schema
>;

export const SessionMetadataInactiveModelIntentOwnerPatchV1Schema =
  lazyZodSchema(() => z.extend(z.omit(SessionMetadataOwnerPatchV1Schema, {
    projectKey: true,
    publisherPrecondition: true,
    activitySummaryV1: true,
    sharedActionConfirmationSummaryV1: true,
  }), {
    mode: z.literal('owner_inactive_model_intent'),
    sessionExpectation:
      SessionMetadataInactiveModelIntentExpectationV1Schema,
  }));
export type SessionMetadataInactiveModelIntentOwnerPatchV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentOwnerPatchV1Schema
>;

export const SessionMetadataTuplePatchV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  SessionMetadataOwnerMigrationPatchV1Schema,
  SessionMetadataOwnerPatchV1Schema,
  z.strictObject({
    mode: z.literal('shared_editor'),
    displayProjectionV1: z.optional(z.nullable(z.omit(SessionDisplayProjectionV1Schema, { owner: true }))),
    mutationIntent: z.optional(z.literal('rename_session')),
    sharedActionConfirmationSummaryV1: z.optional(SessionSharedActionConfirmationSummaryV1Schema),
    metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    sharedMetadata: SessionMetadataSharedPatchV1Schema,
  }).check(z.refine(patch => patch.mutationIntent !== 'rename_session' || patch.sharedActionConfirmationSummaryV1 === undefined)),
]));
export type SessionMetadataTuplePatchV1 = z.infer<
  typeof SessionMetadataTuplePatchV1Schema
>;

export const SessionMetadataTuplePatchSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.strictObject({
    version: SessionEnvelopeVersionSchema,
  }),
  agentState: z.optional(z.strictObject({
    version: SessionEnvelopeVersionSchema,
  })),
}));
export type SessionMetadataTuplePatchSuccessV1 = z.infer<
  typeof SessionMetadataTuplePatchSuccessV1Schema
>;

export const SessionMetadataVersionConflictV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('session_metadata_version_conflict'),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.strictObject({
    version: SessionEnvelopeVersionSchema,
  }),
  agentState: z.optional(z.strictObject({
    version: SessionEnvelopeVersionSchema,
  })),
}));
export type SessionMetadataVersionConflictV1 = z.infer<
  typeof SessionMetadataVersionConflictV1Schema
>;

export const SessionMetadataActiveConflictV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.literal('session_active'),
}));
export type SessionMetadataActiveConflictV1 = z.infer<
  typeof SessionMetadataActiveConflictV1Schema
>;

export const SessionMetadataInactiveModelIntentPatchSuccessV1Schema =
  lazyZodSchema(() => z.strictObject({
    success: z.literal(true),
    metadata: z.strictObject({
      version: SessionEnvelopeVersionSchema,
    }),
  }));
export type SessionMetadataInactiveModelIntentPatchSuccessV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentPatchSuccessV1Schema
>;

export const SessionMetadataInactiveModelIntentVersionConflictV1Schema =
  lazyZodSchema(() => z.strictObject({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    metadata: z.strictObject({
      version: SessionEnvelopeVersionSchema,
      value: z.nullable(z.string()),
    }),
  }));
export type SessionMetadataInactiveModelIntentVersionConflictV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentVersionConflictV1Schema
>;

const SessionMetadataSharedRecipientProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  displayProjectionV1: z.optional(z.omit(SessionDisplayProjectionV1Schema, { owner: true })),
  metadata: SessionOpaqueCiphertextSchema,
  metadataVersion: SessionEnvelopeVersionSchema,
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  agentState: z.null(),
  agentStateVersion: SessionEnvelopeVersionSchema,
  projectKey: z.optional(z.nullable(z.string())),
}));

const SessionMetadataOwnerRecipientProjectionV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionMetadataSharedRecipientProjectionV1Schema, {
    displayProjectionV1: z.optional(SessionDisplayProjectionV1Schema),
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
    agentState: z.nullable(SessionOpaqueCiphertextSchema),
    agentStateVersion: SessionEnvelopeVersionSchema,
  })));

/**
 * Layout-v1 recipient wire projection. A shared participant/public recipient
 * receives an explicit null Agent-state tombstone at the authoritative version
 * so an older full-state cache cannot survive the layout boundary. Only the
 * owner branch may carry a non-null full Agent-state ciphertext, and it also
 * requires the owner envelope.
 */
export const SessionMetadataRecipientProjectionV1Schema = lazyZodSchema(() => z.union([
  SessionMetadataOwnerRecipientProjectionV1Schema,
  SessionMetadataSharedRecipientProjectionV1Schema,
]));
export type SessionMetadataRecipientProjectionV1 = z.infer<
  typeof SessionMetadataRecipientProjectionV1Schema
>;

export const SessionSharedSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  text: BoundedPresentationTextSchema,
  updatedAt: TimestampSchema,
}));
export type SessionSharedSummaryV1 = z.infer<
  typeof SessionSharedSummaryV1Schema
>;

export const SessionPublicCompletedRequestV1Schema = lazyZodSchema(() => z.strictObject({
  tool: BoundedIdentifierSchema,
  kind: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema,
  status: z.enum(['canceled', 'denied', 'approved']),
  permissionDecisionClaimV1: z.optional(SessionPermissionApprovalReviewerClaimV1Schema),
}));
export type SessionPublicCompletedRequestV1 = z.infer<
  typeof SessionPublicCompletedRequestV1Schema
>;

export const SessionPublicAgentStateV1Schema = lazyZodSchema(() => z.strictObject({
  completedRequests: z.record(
    z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
    SessionPublicCompletedRequestV1Schema,
  ).check(z.refine((completedRequests) =>
      Object.keys(completedRequests).length <= MAX_PUBLIC_COMPLETED_REQUESTS_V1, { message: 'completedRequests exceeds the v1 projection limit' })),
}));
export type SessionPublicAgentStateV1 = z.infer<
  typeof SessionPublicAgentStateV1Schema
>;

/**
 * A key holder's statement that this Session is shared with these Teams. Sealed inside the
 * Session key's own metadata, it proves key possession: the Home stores it but cannot forge it.
 * The daemon releases the key to a later Team member only on this statement. The per-Session
 * key binds it to the Session; the Home has not assigned the Session id yet at creation.
 */
export const SessionTeamShareStatementV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
}));
export type SessionTeamShareStatementV1 = z.infer<typeof SessionTeamShareStatementV1Schema>;

/** Names one more Team in flat metadata; plain Sessions carry no statement. */
export function addSessionTeamsToShareStatementV1<T extends Readonly<Record<string, unknown>>>(
  metadata: T,
  teamIds: readonly string[],
): T {
  const stated = SessionTeamShareStatementV1Schema.safeParse(metadata.teamShareStatementV1);
  const current = stated.success ? stated.data.teamIds : [];
  const added = teamIds.filter(teamId => !current.includes(teamId));
  if (added.length === 0) return metadata;
  return Object.assign({}, metadata, { teamShareStatementV1: { v: 1, teamIds: [...new Set([...current, ...added])] } });
}

/**
 * The sole recipient-safe Session.metadata envelope. It intentionally has no
 * passthrough behavior: additive fields require an explicit schema/projector
 * decision before they can cross a share boundary.
 */
export const SessionSharedMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(SESSION_SHARED_METADATA_VERSION_V1),
  bot: z.optional(SessionBotV1Schema),
  summary: z.optional(SessionSharedSummaryV1Schema),
  agentPresentation: z.optional(SessionSharedAgentPresentationV1Schema),
  externalSessionOperationPresentationV1:
    z.optional(ExternalSessionOperationSharedPresentationV1Schema),
  publicAgentState: z.optional(SessionPublicAgentStateV1Schema),
  actionConfirmationsV1: z.optional(SessionActionConfirmationsV1Schema),
  forkVisualsV1: z.optional(SessionForkVisualsV1Schema),
  sessionGuardStateV1: z.optional(SessionGuardStateV1Schema),
  teamShareStatementV1: z.optional(SessionTeamShareStatementV1Schema),
}));
export type SessionSharedMetadataV1 = z.infer<
  typeof SessionSharedMetadataV1Schema
>;

/**
 * Whether bytes a served Session key decrypted are this Session's strict layout-1 shared
 * metadata. The Home names both the key and the layout, so this is the only proof that a key
 * it serves for a reseal is this Session's and not another resource's (Saved Secret, Workflow,
 * Machine): their plaintext has no strict shared form. Layout 0 accepts any record, so it proves
 * nothing; `session.access.layout.update` moves a Session to layout 1.
 */
export function readSessionKeyBoundSharedMetadataV1(params: Readonly<{
  metadataLayoutVersion: unknown;
  decryptedMetadata: unknown;
}>): SessionSharedMetadataV1 | null {
  if (params.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;
  const parsed = SessionSharedMetadataV1Schema.safeParse(params.decryptedMetadata);
  return parsed.success ? parsed.data : null;
}

/** Stored reads discard unknown extensions while validating every known field. */
export const StoredSessionSharedMetadataV1Schema = createStoredReadSchema(SessionSharedMetadataV1Schema);
export const StoredSessionOwnerMetadataEnvelopeV1Schema = createStoredReadSchema(SessionOwnerMetadataEnvelopeV1Schema);

const OptionalOwnerStringSchema = lazyZodSchema(() => z.nullable(z.string().check(z.maxLength(100_000))));
const OptionalOwnerIdentifierSchema = lazyZodSchema(() => z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))));
const OptionalOwnerOpaqueIdentifierSchema =
  lazyZodSchema(() => z.nullable(NonBlankOpaqueIdentifierSchema.check(z.maxLength(2_000))));

/** The closed bundled-Agent resume fields emitted by the canonical plugin projection. */
export type SessionNativeVendorResumeIdFieldV1 = NonNullable<
  (typeof GENERATED_SESSION_PRESENTATION_COMPAT_V1)[number]['vendorResumeIdField']
>;

const SESSION_NATIVE_VENDOR_RESUME_ID_FIELDS_V1 = Object.freeze(
  GENERATED_SESSION_PRESENTATION_COMPAT_V1
    .map((entry) => entry.vendorResumeIdField)
    .filter((field): field is SessionNativeVendorResumeIdFieldV1 => field !== null),
);

export const SessionOwnerRuntimeDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  agent: z.record(z.string(), PluginJsonValueV2Schema),
}));
export type SessionOwnerRuntimeDescriptorV1 = z.infer<
  typeof SessionOwnerRuntimeDescriptorV1Schema
>;

function expandOwnerRuntimeDescriptorForLinkedSession(
  value: unknown,
): unknown {
  const ownerDescriptor = SessionOwnerRuntimeDescriptorV1Schema.safeParse(value);
  if (!ownerDescriptor.success) return value;
  return ownerDescriptor.data;
}

function expandOwnerLinkedSessionVariant(
  value: unknown,
  variant: 'externalSessionV1' | 'directSessionV1',
): unknown {
  const record = readRecord(value);
  if (!record) return value;
  const runtimeKey = variant === 'externalSessionV1'
    ? 'runtimeDescriptorV1'
    : 'agentRuntimeDescriptorV1';
  if (record[runtimeKey] === undefined) return value;
  return {
    ...record,
    [runtimeKey]: expandOwnerRuntimeDescriptorForLinkedSession(
      record[runtimeKey],
    ),
  };
}

function createSessionOwnerLinkedSessionVariantSchema(
  variant: 'externalSessionV1' | 'directSessionV1',
  purpose: 'input' | 'stored' = 'input',
) {
  return z.pipe(z.unknown(), z.transform((value, ctx) => {
    const resolved = resolveLinkedExternalSessionMetadataV1({
      [variant]: expandOwnerLinkedSessionVariant(value, variant),
    }, purpose);
    if (!resolved.ok) {
      ctx.issues.push({
        code: 'custom',
        message: `Invalid ${variant} owner metadata: ${resolved.reason}`, input: ctx.value });
      return z.NEVER;
    }

    const normalized = buildLinkedExternalSessionMetadataV1(
      {},
      resolved.linkedSession,
    );
    const projected = variant === 'externalSessionV1'
      ? readRecord(normalized.externalSessionV1)
      : purpose === 'stored'
        ? projectStoredOwnerDirectSessionLink(resolved.linkedSession)
        : readRecord(value);
    if (!projected) {
      ctx.issues.push({
        code: 'custom',
        message: `Missing normalized ${variant} owner metadata`, input: ctx.value });
      return z.NEVER;
    }

    const runtimeKey = variant === 'externalSessionV1'
      ? 'runtimeDescriptorV1'
      : 'agentRuntimeDescriptorV1';
    if (projected[runtimeKey] === undefined) return projected;

    const runtimeDescriptor = normalizeOwnerRuntimeDescriptorV1(
      projected[runtimeKey],
      purpose,
    );
    if (!runtimeDescriptor) {
      ctx.issues.push({
        code: 'custom',
        path: [runtimeKey],
        message: `Invalid ${variant} runtime descriptor`, input: ctx.value });
      return z.NEVER;
    }
    return {
      ...projected,
      [runtimeKey]: runtimeDescriptor,
    };
  }));
}

const SessionOwnerExternalSessionLinkV1Schema =
  lazyZodSchema(() => createSessionOwnerLinkedSessionVariantSchema('externalSessionV1'));

const SessionOwnerDirectSessionLinkV1Schema =
  lazyZodSchema(() => createSessionOwnerLinkedSessionVariantSchema('directSessionV1'));

// Released direct links keep their vocabulary, but only the reconciled known
// link facts acquire authority. Native descriptor/source data stays owner-owned.
function projectStoredOwnerDirectSessionLink(
  link: Parameters<typeof buildLinkedExternalSessionMetadataV1>[1],
): Record<string, unknown> {
  const { agentId, runtimeDescriptorV1, qualifiedIdentity: _qualifiedIdentity,
    linkData: _linkData, ...known } = link;
  return {
    ...known,
    providerId: agentId,
    ...(runtimeDescriptorV1 === undefined ? {} : {
      agentRuntimeDescriptorV1: projectRuntimeDescriptorV1ForPredecessor(runtimeDescriptorV1),
    }),
  };
}

defineStoredReadProjection(SessionOwnerExternalSessionLinkV1Schema, () =>
  createSessionOwnerLinkedSessionVariantSchema('externalSessionV1', 'stored'));
defineStoredReadProjection(SessionOwnerDirectSessionLinkV1Schema, () =>
  createSessionOwnerLinkedSessionVariantSchema('directSessionV1', 'stored'));

function createSessionOwnerCompatibilityLinkedSessionVariantSchema(
  variant: 'externalSessionV1' | 'directSessionV1',
  purpose: 'input' | 'stored' = 'input',
) {
  return z.pipe(z.unknown(), z.transform((value, context) => {
    const resolved = resolveLinkedExternalSessionMetadataV1({
      [variant]: expandOwnerLinkedSessionVariant(value, variant),
    }, purpose);
    if (!resolved.ok) {
      context.issues.push({
        code: 'custom',
        message: `Invalid ${variant} compatibility metadata: ${resolved.reason}`, input: context.value });
      return z.NEVER;
    }
    const normalized = buildLinkedExternalSessionMetadataV1(
      {},
      resolved.linkedSession,
    );
    const projected = variant === 'externalSessionV1'
      ? normalized.externalSessionV1
      : purpose === 'stored'
        ? projectStoredOwnerDirectSessionLink(resolved.linkedSession)
        : value;
    if (projected === undefined) {
      context.issues.push({
        code: 'custom',
        message: `Missing normalized ${variant} compatibility metadata`, input: context.value });
      return z.NEVER;
    }
    return projected;
  }));
}

const SessionOwnerCompatibilityExternalSessionLinkV1Schema =
  lazyZodSchema(() => createSessionOwnerCompatibilityLinkedSessionVariantSchema(
    'externalSessionV1',
  ));
const SessionOwnerCompatibilityDirectSessionLinkV1Schema =
  lazyZodSchema(() => createSessionOwnerCompatibilityLinkedSessionVariantSchema(
    'directSessionV1',
  ));

defineStoredReadProjection(SessionOwnerCompatibilityExternalSessionLinkV1Schema, () =>
  createSessionOwnerCompatibilityLinkedSessionVariantSchema('externalSessionV1', 'stored'));
defineStoredReadProjection(SessionOwnerCompatibilityDirectSessionLinkV1Schema, () =>
  createSessionOwnerCompatibilityLinkedSessionVariantSchema('directSessionV1', 'stored'));

const SessionOwnerNativeSessionV1Schema = lazyZodSchema(() => z.strictObject({
  runtimeDescriptorV1: z.optional(SessionOwnerRuntimeDescriptorV1Schema),
  nativeResumeIdentityV1: z.optional(AgentNativeResumeIdentityV1Schema),
  // Object.fromEntries loses literal keys; this mapping contains exactly the generated closed set.
  ...(Object.fromEntries(SESSION_NATIVE_VENDOR_RESUME_ID_FIELDS_V1.map((field) => [
    field,
    z.optional(OptionalOwnerOpaqueIdentifierSchema),
  ])) as {
    [Field in SessionNativeVendorResumeIdFieldV1]: z.ZodMiniOptional<typeof OptionalOwnerOpaqueIdentifierSchema>;
  }),
  claudeTranscriptPath: z.optional(OptionalOwnerStringSchema),
  claudeLastCheckpointId: z.optional(OptionalOwnerIdentifierSchema),
  claudeLastAssistantUuid: z.optional(OptionalOwnerIdentifierSchema),
  opencodeBackendMode: z.optional(z.enum(['server', 'acp'])),
  opencodeServerBaseUrl: z.optional(OptionalOwnerStringSchema),
  opencodeServerBaseUrlExplicit: z.optional(z.literal(true)),
  auggieAllowIndexing: z.optional(z.boolean()),
  piSessionFile: z.optional(OptionalOwnerStringSchema),
  providerSessionInfoV1: z.optional(z.strictObject({
    v: z.literal(1),
    provider: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    sessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(1_024)),
    observedAt: TimestampSchema,
    title: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)))),
    updatedAt: z.optional(z.nullable(z.string().check(z.iso.datetime({ offset: true }), z.maxLength(64)))),
  })),
  tag: z.optional(OptionalOwnerIdentifierSchema),
  externalSessionV1: z.optional(SessionOwnerExternalSessionLinkV1Schema),
  directSessionV1: z.optional(SessionOwnerDirectSessionLinkV1Schema),
}).check(z.superRefine((value, context) => {
  if (
    value.externalSessionV1 === undefined
    || value.directSessionV1 === undefined
  ) {
    return;
  }
  const resolved = resolveLinkedExternalSessionMetadataV1({
    externalSessionV1: expandOwnerLinkedSessionVariant(
      value.externalSessionV1,
      'externalSessionV1',
    ),
    directSessionV1: expandOwnerLinkedSessionVariant(
      value.directSessionV1,
      'directSessionV1',
    ),
  });
  if (resolved.ok) return;
  context.addIssue({
    code: 'custom',
    path: ['externalSessionV1'],
    message: `Conflicting linked-session owner metadata: ${resolved.reason}`,
  });
  context.addIssue({
    code: 'custom',
    path: ['directSessionV1'],
    message: `Conflicting linked-session owner metadata: ${resolved.reason}`,
  });
})));

// Stable cli-v0.2.1 and preview cli-v0.2.2 flattened metadata exposed this
// Codex selector directly. Current owner envelopes are Agent-neutral and carry
// it only in runtimeDescriptorV1. Retain the old field solely in the local
// compatibility view until those readers and their stored flat rows are no
// longer supported.
const SessionOwnerCompatibilityNativeSessionV1Schema =
  lazyZodSchema(() => z.safeExtend(SessionOwnerNativeSessionV1Schema, {
    codexBackendMode: z.optional(z.enum(['mcp', 'acp', 'appServer'])),
  }));

const SessionOwnerSlashCommandDetailV1Schema = lazyZodSchema(() => z.strictObject({
  command: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
}));

const SessionOwnerScalarValueV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.maxLength(20_000)),
  z.number(),
  z.boolean(),
  z.null(),
]));

const SessionOwnerTerminalV1Schema = lazyZodSchema(() => createSessionTerminalMetadataSchema(z, 'owner'));

const SessionOwnerModeCatalogItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
}));
export const SessionOwnerModeCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  currentModeId: BoundedIdentifierSchema,
  availableModes: z.array(SessionOwnerModeCatalogItemV1Schema).check(z.maxLength(2_048)),
}));

/** Mode availability and accepted current selection are orthogonal native facts. */
export const SessionOwnerModeCatalogV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionOwnerModeCatalogV1Schema, {
  v: z.literal(2),
  currentModeId: z.nullable(BoundedIdentifierSchema),
})));
export type SessionOwnerModeCatalogV2 = z.infer<typeof SessionOwnerModeCatalogV2Schema>;

/** Unknown inventory cannot refuse a native mode; accepted current facts may outlive selectable membership. */
export function isSessionModeSelectionUnavailable(
  modeId: string | null | undefined,
  catalog: Readonly<{
    availableModes: readonly Readonly<{ id: string }>[] | null;
    currentModeId?: string | null;
  }>,
): boolean {
  return Boolean(modeId)
    && catalog.availableModes !== null
    && catalog.currentModeId !== modeId
    && !catalog.availableModes.some((mode) => mode.id === modeId);
}

export function readSessionModesMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): SessionOwnerModeCatalogV2 | null {
  if (!metadata) return null;
  if ('sessionModesV2' in metadata) {
    const parsed = createStoredReadSchema(SessionOwnerModeCatalogV2Schema).safeParse(metadata.sessionModesV2);
    return parsed.success ? parsed.data : null;
  }
  const parsed = createStoredReadSchema(SessionOwnerModeCatalogV1Schema).safeParse(normalizeAgentVocabularyRecord(metadata.sessionModesV1 ?? metadata.acpSessionModesV1, 'provider'));
  return parsed.success ? { ...parsed.data, v: 2 } : null;
}

export function projectSessionModesV1Compatibility(state: SessionOwnerModeCatalogV2): z.infer<typeof SessionOwnerModeCatalogV1Schema> | undefined {
  return state.currentModeId === null ? undefined : { ...state, v: 1, currentModeId: state.currentModeId };
}

const SessionOwnerCatalogValueOptionV1Schema = lazyZodSchema(() => z.strictObject({
  value: SessionOwnerScalarValueV1Schema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
}));
const SessionOwnerModelOptionV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
  category: z.optional(z.string().check(z.maxLength(2_000))),
  type: BoundedIdentifierSchema,
  currentValue: SessionOwnerScalarValueV1Schema,
  options: z.optional(z.array(SessionOwnerCatalogValueOptionV1Schema).check(z.maxLength(2_048))),
  // Producer-declared; see AgentModelOptionOverrideRule. These envelopes are strict, so an
  // undeclared field would reject the WHOLE owner metadata rather than drop the rule.
  overridesWhenOn: z.optional(AgentModelOptionOverrideRuleSchema),
}));
const SessionOwnerModelCatalogItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
  contextWindowTokens: z.optional(z.number().check(z.int(), z.positive())),
  extendedContextModelId: z.optional(BoundedIdentifierSchema),
  modelOptions: z.optional(z.array(SessionOwnerModelOptionV1Schema).check(z.maxLength(2_048))),
}));
const SessionOwnerModelCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  currentModelId: BoundedIdentifierSchema,
  availableModels: z.array(SessionOwnerModelCatalogItemV1Schema).check(z.maxLength(2_048)),
  // Optional for mixed-version producer compatibility. Absence is valid and
  // does not authorize owner-migration or backfill.
  activeSelectionV1: z.optional(SessionActiveModelSelectionSchema),
}));

const SessionOwnerConfigOptionGroupV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  options: z.array(SessionOwnerCatalogValueOptionV1Schema).check(z.maxLength(2_048)),
}));
const SessionOwnerConfigOptionV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  description: z.optional(z.string().check(z.maxLength(20_000))),
  category: z.optional(z.string().check(z.maxLength(2_000))),
  type: BoundedIdentifierSchema,
  currentValue: SessionOwnerScalarValueV1Schema,
  options: z.optional(z.array(SessionOwnerCatalogValueOptionV1Schema).check(z.maxLength(2_048))),
  groups: z.optional(z.array(SessionOwnerConfigOptionGroupV1Schema).check(z.maxLength(2_048))),
  // Producer-declared; see AgentModelOptionOverrideRule. These envelopes are strict, so an
  // undeclared field would reject the WHOLE owner metadata rather than drop the rule.
  overridesWhenOn: z.optional(AgentModelOptionOverrideRuleSchema),
}));
const SessionOwnerConfigCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  configOptions: z.array(SessionOwnerConfigOptionV1Schema).check(z.maxLength(2_048)),
}));

const SessionOwnerModeOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  updatedAt: z.number(),
  modeId: z.nullable(z.string().check(z.maxLength(20_000))),
}));
const SessionOwnerConfigOverridesV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  updatedAt: z.number(),
  overrides: z.record(
    z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
    z.strictObject({
      updatedAt: z.number(),
      value: SessionOwnerScalarValueV1Schema,
    }),
  ),
}));

const SessionOwnerAgentRuntimeFacetsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  transcriptSource: z.optional(z.strictObject({
    supported: z.literal(true),
    followLeaseSupported: z.optional(z.literal(true)),
  })),
}));

const SessionOwnerCapabilitySupportV1Schema = lazyZodSchema(() => z.strictObject({
  supported: z.boolean(),
}));
const SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema = lazyZodSchema(() => z.enum([
  'supported',
  'experimental',
  'unsupported',
]));
const SessionOwnerAgentRuntimeCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  capabilitySelection: z.optional(SessionCapabilityAgentFactsV1Schema),
  localControl: z.optional(z.nullable(z.strictObject({
    supported: z.boolean(),
    topology: z.optional(z.enum(['exclusive', 'shared'])),
    attachStrategy: z.optional(z.enum([
      'terminal_host',
      'provider_attach',
      'unsupported',
    ])),
    remoteWritable: z.optional(z.boolean()),
  }))),
  sessionStorage: z.optional(z.nullable(z.strictObject({
    direct: z.boolean(),
    persisted: z.boolean(),
  }))),
  sessionCapabilities: z.optional(z.nullable(z.strictObject({
    sessionListing: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
    sessionFork: z.strictObject({
      conversation: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
      fromMessage: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
      protocol: z.optional(z.literal('acp')),
    }),
    sessionRollback: z.strictObject({
      conversation: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
    }),
    usageReporting: z.optional(SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema),
    compaction: z.optional(z.nullable(PluginAgentSessionCompactionCapabilityV2Schema)),
  }))),
  tools: z.optional(z.nullable(z.strictObject({
    delivery: z.enum([
      'native_mcp',
      'native_extension',
      'shell_bridge',
      'unsupported',
    ]),
    support: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
  }))),
  handoff: z.optional(z.nullable(z.strictObject({
    vendorStateTransfer: SessionOwnerAgentRuntimeCapabilitySupportLevelV1Schema,
    requiresExplicitSessionId: z.optional(z.boolean()),
  }))),
  executionRun: z.optional(z.nullable(z.strictObject({
    supported: z.boolean(),
    structuredOutputRecovery: z.optional(z.strictObject({
      plan: z.optional(z.enum(['loose-sections', 'none'])),
      delegate: z.optional(z.enum([
        'loose-deliverables',
        'loose-deliverables-with-single-fallback',
        'none',
      ])),
    })),
  }))),
  backend: z.optional(z.strictObject({
    executionRun: z.strictObject({
      supported: z.boolean(),
      structuredOutputRecovery: z.optional(z.strictObject({
        plan: z.optional(z.enum(['loose-sections', 'none'])),
        delegate: z.optional(z.enum([
          'loose-deliverables',
          'loose-deliverables-with-single-fallback',
          'none',
        ])),
      })),
    }),
    session: z.strictObject({
      media: z.strictObject({
        acceptsImageInput: SessionOwnerCapabilitySupportV1Schema,
        emitsSessionMedia: z.strictObject({
          supported: z.boolean(),
          mediaKinds: z.optional(z.array(z.literal('image'))),
          sources: z.optional(z.array(z.enum([
            'provider-generated',
            'tool-output',
            'acp-content',
            'mcp-content',
          ]))),
          storage: z.optional(z.literal('session-media-file')),
        }),
        nativeImageGeneration: z.strictObject({
          supported: z.boolean(),
          mediaKinds: z.optional(z.array(z.literal('image'))),
          streamingPartials: z.optional(z.boolean()),
        }),
      }),
      contextCompaction: z.strictObject({
        events: z.strictObject({
          supported: z.boolean(),
          phases: z.optional(z.array(z.enum([
            'started',
            'progress',
            'completed',
            'failed',
            'cancelled',
          ]))),
          tokenCounts: z.optional(z.boolean()),
          progress: z.optional(z.boolean()),
        }),
        manualTrigger: z.strictObject({
          supported: z.boolean(),
          transport: z.optional(z.enum(['native-runtime-hook', 'raw-provider-command'])),
          acceptsInstructions: z.optional(z.boolean()),
        }),
        transcriptInference: SessionOwnerCapabilitySupportV1Schema,
      }),
    }),
  })),
}));

const SessionOwnerRollbackRangesV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  updatedAt: z.number(),
  ranges: z.array(z.strictObject({
    target: SessionRollbackTargetSchema,
    startSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    endSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    rolledBackAt: z.number(),
  }).check(z.refine((value) => value.endSeqInclusive >= value.startSeqInclusive, { path: ['endSeqInclusive'], message: 'Invalid rollback range' }))).check(z.maxLength(20_000)),
}));

const SessionOwnerRuntimeV1Schema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  externalSessionOperationV1: z.optional(ExternalSessionOperationStateV1Schema),
  terminal: z.optional(SessionOwnerTerminalV1Schema),
  tools: z.optional(z.array(z.string().check(z.maxLength(2_000))).check(z.maxLength(4_096))),
  slashCommands: z.optional(z.array(z.string().check(z.maxLength(2_000))).check(z.maxLength(4_096))),
  slashCommandDetails: z.optional(z.array(SessionOwnerSlashCommandDetailV1Schema).check(z.maxLength(4_096))),
  permissionMode: z.optional(BoundedIdentifierSchema),
  approvalReviewerEnabled: z.optional(z.boolean()),
  permissionModeUpdatedAt: z.optional(TimestampSchema),
  hostPid: z.optional(z.number().check(z.int(), z.nonnegative())),
  hostProcessStartTimeMs: z.optional(TimestampSchema),
  hostProcessInstanceFingerprint: z.optional(OptionalOwnerStringSchema),
  startedFromDaemon: z.optional(z.boolean()),
  startedBy: z.optional(z.enum(['daemon', 'terminal'])),
  sessionLogPath: z.optional(OptionalOwnerStringSchema),
  lifecycleState: z.optional(z.string().check(z.maxLength(2_000))),
  lifecycleStateSince: z.optional(TimestampSchema),
  archivedBy: z.optional(z.string().check(z.maxLength(2_000))),
  archiveReason: z.optional(z.string().check(z.maxLength(20_000))),
  sessionUsageLimitRecoveryV1: z.optional(SessionUsageLimitRecoveryV1Schema),
  sessionRunnerRuntimeV1: z.optional(SessionRunnerRuntimeStateV1Schema),
  sessionPendingQueueHoldV1: z.optional(SessionPendingQueueHoldV1Schema),
  sessionExplicitStopV1: z.optional(SessionExplicitStopV1Schema),
  providerBindingV1: z.optional(SessionProviderBindingMetadataV1Schema),
  modelSelectionIntentV1: z.optional(SessionModelSelectionIntentV1Schema),
  modelSelectionIntentV2: z.optional(SessionModelSelectionV2Schema),
  sessionAppliedModelV1: z.optional(SessionAppliedModelV1Schema),
  externalAgentObservationV1: z.optional(ExternalAgentObservationSnapshotV1Schema),
  acpSessionModesV1: z.optional(SessionOwnerModeCatalogV1Schema),
  sessionModesV1: z.optional(SessionOwnerModeCatalogV1Schema),
  sessionModesV2: z.optional(SessionOwnerModeCatalogV2Schema),
  acpSessionModelsV1: z.optional(SessionOwnerModelCatalogV1Schema),
  sessionModelsV1: z.optional(SessionOwnerModelCatalogV1Schema),
  acpConfigOptionsV1: z.optional(SessionOwnerConfigCatalogV1Schema),
  sessionConfigOptionsV1: z.optional(SessionOwnerConfigCatalogV1Schema),
  modelOverrideV1: z.optional(z.strictObject({
    v: z.literal(1),
    updatedAt: z.number(),
    modelId: z.nullable(z.string().check(z.maxLength(20_000))),
  })),
  acpSessionModeOverrideV1: z.optional(SessionOwnerModeOverrideV1Schema),
  sessionModeOverrideV1: z.optional(SessionOwnerModeOverrideV1Schema),
  acpConfigOptionOverridesV1: z.optional(SessionOwnerConfigOverridesV1Schema),
  sessionConfigOptionOverridesV1: z.optional(SessionOwnerConfigOverridesV1Schema),
  acpConfiguredBackendV1: z.optional(z.strictObject({
    v: z.literal(1),
    updatedAt: z.number(),
    backendId: BoundedIdentifierSchema,
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  })),
  agentRuntimeCapabilitiesV1: z.optional(SessionOwnerAgentRuntimeCapabilitiesV1Schema),
  agentRuntimeFacetsV1: z.optional(SessionOwnerAgentRuntimeFacetsV1Schema),
  mcpSelectionV1: z.optional(SessionMcpSelectionAuthoringV1Schema),
  mcpSelectionRestartRequiredV1: z.optional(SessionMcpSelectionRestartRequiredAuthoringV1Schema),
  skillSelectionV1: z.optional(SessionSkillSelectionAuthoringV1Schema),
  skillSelectionRestartRequiredV1: z.optional(SessionSkillSelectionRestartRequiredAuthoringV1Schema),
  capabilitySelectionApplyV1: z.optional(CapabilitySelectionApplyAuthoringV1Schema),
  runtimeActivity: z.optional(z.union([
    SessionRuntimeActivitySnapshotSchema,
    SessionRuntimeActivityProjectionSchema,
  ])),
}));

const SessionOwnerConnectedServicesV1Schema = lazyZodSchema(() => z.strictObject({
  connectedServices: z.optional(ConnectedServiceBindingsV2IngressSchema),
  connectedServicesUpdatedAt: z.optional(TimestampSchema),
  connectedServiceMaterializationIdentityV1: z.optional(z.strictObject({
    v: z.literal(1),
    id: z.string().check(z.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
    createdAt: TimestampSchema,
    source: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
  })),
  providerAccountUsageRefsV1: z.optional(ProviderAccountUsageRefsV1Schema),
  connectedServicePendingAuthGroupGenerationsV1: z.optional(z.strictObject({
    v: z.literal(1),
    entries: z.array(z.strictObject({
      kind: z.literal('provider_adopted_generation'),
      providerAdoptedTarget: z.strictObject({
        serviceId: ConnectedServiceIdSchema,
        groupId: BoundedIdentifierSchema,
        profileId: BoundedIdentifierSchema,
        generation: z.number().check(z.int(), z.nonnegative()),
        credentialRevision: z.nullable(ConnectedServiceCredentialRevisionV1Schema),
        proof: z.strictObject({
          status: z.literal('verified'),
          source: BoundedIdentifierSchema,
          providerAccountId: z.optional(OptionalOwnerIdentifierSchema),
          activeAccountId: z.optional(OptionalOwnerIdentifierSchema),
          sharedAuthSurfaceId: z.optional(OptionalOwnerIdentifierSchema),
          credentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
        }).check(z.refine((proof) =>
            proof.providerAccountId !== undefined
            || proof.activeAccountId !== undefined
            || proof.sharedAuthSurfaceId !== undefined
            || proof.credentialRevision !== undefined, { message: 'Generation proof requires an exact identity' })),
      }),
      proofStrength: z.literal('exact'),
      updatedAtMs: TimestampSchema,
    })).check(z.maxLength(20_000)),
  })),
  claudeSubscriptionAccessTokenRefreshV1: z.optional(z.strictObject({
    v: z.literal(1),
    mode: z.enum(['daemon_callback', 'unavailable']),
  })),
  connectedServiceAccessTokenRefreshV1: z.optional(z.strictObject({
    v: z.literal(1),
    mode: z.enum(['daemon_callback', 'unavailable']),
    serviceIds: z.array(ConnectedServiceIdSchema).check(z.maxLength(64)),
  })),
}));

const SessionOwnerHistoryV1Schema = lazyZodSchema(() => z.strictObject({
  externalHistoryImportV1: z.optional(ExternalHistoryImportV1Schema),
  acpHistoryImportV1: z.optional(z.strictObject({
    v: z.literal(1),
    agentId: BoundedIdentifierSchema,
    remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(20_000)),
    importedAt: TimestampSchema,
    lastImportedFingerprint: z.optional(z.string().check(z.maxLength(20_000))),
  })),
  sessionRollbackRangesV1: z.optional(SessionOwnerRollbackRangesV1Schema),
  forkV1: z.optional(z.strictObject({
    v: z.literal(1),
    parentSessionId: BoundedIdentifierSchema,
    parentCutoffSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    createdAtMs: TimestampSchema,
    strategy: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    requestId: z.optional(OptionalOwnerIdentifierSchema),
    filesNotCopied: z.optional(SessionForkFilesNotCopiedV1Schema),
    visualCopies: z.optional(z.array(SessionForkVisualCopyV1Schema)),
    agentHint: z.optional(z.strictObject({
      agentId: z.optional(BoundedIdentifierSchema),
      backendMode: z.optional(BoundedIdentifierSchema),
      agentSessionId: z.optional(OptionalOwnerOpaqueIdentifierSchema),
    })),
  })),
  replaySeedV1: z.optional(z.strictObject({
    v: z.literal(1),
    seedText: z.string(),
    sourceSessionId: BoundedIdentifierSchema,
    sourceCutoffSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    createdAtMs: TimestampSchema,
    appliedToLocalId: z.optional(OptionalOwnerIdentifierSchema),
    appliedAtMs: z.optional(TimestampSchema),
    // The Pending row whose provider prompt this seed was composed into, recorded before
    // dispatch. Retirement is a separate write that can fail, so this association is what lets
    // the incumbent durable accepted-delivery status decide the seed's fate after a restart.
    dispatchedToLocalId: z.optional(OptionalOwnerIdentifierSchema),
  })),
  forkInitialPromptV1: z.optional(z.strictObject({
    v: z.literal(1),
    text: z.string().check(z.maxLength(1_000_000)),
    createdAtMs: TimestampSchema,
    sourceMessageId: z.optional(OptionalOwnerIdentifierSchema),
    appliedAtMs: z.optional(TimestampSchema),
  })),
  sessionInitialPromptV1: z.optional(z.strictObject({
    v: z.literal(1),
    text: z.string().check(z.maxLength(1_000_000)),
    mode: z.enum(['replace', 'append']),
    createdAtMs: TimestampSchema,
    sourceMessageIds: z.optional(z.array(BoundedIdentifierSchema).check(z.maxLength(20_000))),
    sourceSessionId: z.optional(OptionalOwnerIdentifierSchema),
    source: z.optional(z.omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true })),
  })),
  sessionMediaContinuityV1: z.optional(z.strictObject({
    v: z.literal(1),
    sourceSessionId: BoundedIdentifierSchema,
    sourceCutoffSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    referencedWorkspacePaths: z.array(z.string().check(z.maxLength(100_000))).check(z.maxLength(20_000)),
  })),
}));

const SessionOwnerWorkStateItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdentifierSchema,
  kind: z.enum(['goal', 'task', 'todo']),
  origin: z.enum(['vendor', 'happier', 'derived']),
  status: z.enum(['pending', 'active', 'paused', 'blocked', 'complete', 'cancelled', 'unknown']),
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(4_000)),
  summary: z.optional(z.string().check(z.trim(), z.maxLength(8_000))),
  backendId: z.optional(BoundedIdentifierSchema),
  agentId: z.optional(BoundedIdentifierSchema),
  vendorRef: z.optional(BoundedIdentifierSchema),
  order: z.optional(z.number().check(z.int(), z.nonnegative())),
  parentId: z.optional(BoundedIdentifierSchema),
  priority: z.optional(z.string().check(z.maxLength(256))),
  progress: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
  statusReason: z.optional(z.enum(['blocked', 'usageLimited', 'budgetLimited', 'interrupted'])),
  goalCapabilities: z.optional(z.strictObject({
    canEdit: z.optional(z.boolean()),
    canStop: z.optional(z.boolean()),
    canClear: z.optional(z.boolean()),
  })),
  tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
  tokensUsed: z.optional(z.number().check(z.int(), z.nonnegative())),
  timeUsedSeconds: z.optional(z.number().check(z.nonnegative())),
  createdAt: z.optional(TimestampSchema),
  startedAt: z.optional(TimestampSchema),
  completedAt: z.optional(TimestampSchema),
  updatedAt: TimestampSchema,
  providerData: z.optional(PluginJsonValueV2Schema),
}));

const SessionOwnerWorkStateTruncationV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum(['item_limit', 'provider_limit']),
  omittedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  sourceReason: z.optional(z.enum(['providerLimit', 'byteLimit'])),
}));

const SessionOwnerWorkStateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  backendId: BoundedIdentifierSchema,
  agentId: z.optional(BoundedIdentifierSchema),
  updatedAt: TimestampSchema,
  items: z.array(SessionOwnerWorkStateItemV1Schema).check(z.maxLength(20_000)),
  primaryItemId: z.optional(OptionalOwnerIdentifierSchema),
  sourceTruncations: z.optional(z.record(z.string().check(z.minLength(1)), SessionOwnerWorkStateTruncationV1Schema)),
  truncated: z.optional(SessionOwnerWorkStateTruncationV1Schema),
}));

const SessionOwnerWorkflowRunHeadlineV1Schema = lazyZodSchema(() => z.strictObject({
  runId: BoundedIdentifierSchema,
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(4_000)),
  status: z.enum(['active', 'complete', 'failed', 'stopped', 'blocked', 'cancelled', 'unknown']),
  statusReason: z.optional(z.literal('interrupted')),
  workflowToolUseId: z.optional(BoundedIdentifierSchema),
  updatedAt: TimestampSchema,
  recordRevision: z.string().check(z.trim(), z.regex(/^\d+$/)),
  recordUpdatedAt: TimestampSchema,
  totalAgents: z.number().check(z.int(), z.nonnegative()),
  completedAgents: z.number().check(z.int(), z.nonnegative()),
  failedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
  blockedAgents: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

/**
 * Owner-envelope mirror of `SessionAgentActivityEntryV1`.
 *
 * A bounded, `.strict()` restatement in the same style as `SessionOwnerWorkflowRunHeadlineV1Schema`
 * above: the envelope's job is to cap what an owner-scoped metadata blob may carry, which the
 * domain schema (strip-by-default, deliberately unbounded on counts) does not do. It is a boundary
 * bound, not a second decision about what an entry means —
 * `agentActivityHeadlineMetadataKey.test.ts` round-trips a builder-produced headline through here so
 * the mirror cannot drift away from the vocabulary it bounds.
 */
const SessionOwnerAgentActivityEntryV1Schema = lazyZodSchema(() => z.strictObject({
  entryId: BoundedIdentifierSchema,
  kind: z.enum(['workflow_run', 'workflow_agent']),
  title: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)),
  status: z.enum([
    'queued',
    'starting',
    'running',
    'waiting',
    'blocked',
    'succeeded',
    'failed',
    'timedOut',
    'cancelled',
    'unknown',
  ]),
  startedAt: z.optional(TimestampSchema),
  updatedAt: TimestampSchema,
  sidechainId: z.optional(BoundedIdentifierSchema),
  runId: z.optional(BoundedIdentifierSchema),
  parentId: z.optional(BoundedIdentifierSchema),
  recordRevision: z.optional(BoundedIdentifierSchema),
}));

const SessionOwnerWorkV1Schema = lazyZodSchema(() => z.strictObject({
  // Authored explanation; lifecycle and item outcome classifications remain runtime-owned.
  statusReason: z.optional(z.string()),
  bot: z.optional(SessionBotV1Schema),
  createdAsBot: z.optional(z.literal(true)),
  memoryEnabled: z.optional(z.boolean()),
  voicePreference: z.optional(SessionVoicePreferenceV1Schema),
  promptStack: z.optional(SessionPromptStackV1Schema),
  disabledInheritedEntryIds: z.optional(SessionDisabledInheritedEntryIdsV1Schema),
  viewPreferences: z.optional(z.strictObject({ showToolCalls: z.optional(z.boolean()) })),
  sessionRolesV1: z.optional(SessionRolesV1Schema),
  authoringOriginV1: z.optional(PluginUiNewSessionSeedOriginV1Schema),
  sessionWorkStateV1: z.optional(SessionOwnerWorkStateV1Schema),
  sessionWorkflowActivityHeadlineV1: z.optional(z.strictObject({
    v: z.literal(1),
    backendId: BoundedIdentifierSchema,
    agentId: z.optional(BoundedIdentifierSchema),
    updatedAt: TimestampSchema,
    primaryRunId: z.optional(OptionalOwnerIdentifierSchema),
    activeRuns: z.array(SessionOwnerWorkflowRunHeadlineV1Schema).check(z.maxLength(20_000)),
    recentRuns: z.optional(z.array(SessionOwnerWorkflowRunHeadlineV1Schema).check(z.maxLength(20_000))),
    truncated: z.optional(z.strictObject({
      reason: z.literal('run_limit'),
      omittedCount: z.number().check(z.int(), z.nonnegative()),
    })),
  })),
  sessionAgentActivityHeadlineV1: z.optional(z.strictObject({
    v: z.literal(1),
    backendId: BoundedIdentifierSchema,
    agentId: z.optional(BoundedIdentifierSchema),
    updatedAt: TimestampSchema,
    primaryEntryId: z.optional(OptionalOwnerIdentifierSchema),
    // Active work is NEVER bounded by the producer; this cap is only an envelope-size guard, and it
    // is deliberately the same 20_000 the workflow key already uses so neither key is the one that
    // silently truncates a roster first.
    activeEntries: z.array(SessionOwnerAgentActivityEntryV1Schema).check(z.maxLength(20_000)),
    recentEntries: z.optional(z.array(SessionOwnerAgentActivityEntryV1Schema).check(z.maxLength(20_000))),
    truncated: z.optional(z.strictObject({
      reason: z.literal('entry_limit'),
      omittedCount: z.number().check(z.int(), z.nonnegative()),
    })),
  })),
}));

// Runtime headlines retain their incumbent flat domain projection. Private work
// facts stay under work so every registered field shares the same conversion.
const SessionOwnerPrivateWorkV1Schema = lazyZodSchema(() => z.omit(SessionOwnerWorkV1Schema, {
  bot: true, createdAsBot: true, sessionWorkStateV1: true,
  sessionWorkflowActivityHeadlineV1: true, sessionAgentActivityHeadlineV1: true,
}));
const SessionOwnerCompatibilityFlatWorkShapeV1 = lazyZodSchema(() => z.pick(SessionOwnerWorkV1Schema, {
  bot: true, createdAsBot: true, sessionWorkStateV1: true,
  sessionWorkflowActivityHeadlineV1: true, sessionAgentActivityHeadlineV1: true,
})).shape;

const SessionOwnerBackendTargetV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('builtInAgent'),
    agentId: BoundedIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal('configuredAcpBackend'),
    backendId: BoundedIdentifierSchema,
  }),
]));
const SessionOwnerBackendTargetV2Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('backend'),
  backendId: BoundedIdentifierSchema,
  configuredBackendId: z.optional(BoundedIdentifierSchema),
  sourceKind: z.optional(z.enum(['built_in', 'configured'])),
}));
const SessionOwnerResumeHandleV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider_session.v1'),
    backendTarget: SessionOwnerBackendTargetV2Schema,
    providerSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(20_000)),
  }),
  z.strictObject({
    kind: z.literal('voice_agent_sessions.v1'),
    backendTarget: SessionOwnerBackendTargetV2Schema,
    chatProviderSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(20_000)),
    commitProviderSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(20_000)),
  }),
]));

const SessionOwnerSystemV1Schema = lazyZodSchema(() => z.strictObject({
  attestedContext: z.optional(SessionAttestedContextV1Schema),
  sessionCreationCorrespondenceV1: z.optional(SessionCreationCorrespondenceV1Schema),
  placementOrigin: z.optional(MachinePoolSelectionOriginV1Schema),
  systemSessionV1: z.optional(z.strictObject({
    v: z.literal(1),
    key: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
    hidden: z.optional(z.boolean()),
  })),
  voiceAgentRunV1: z.optional(z.strictObject({
    v: z.literal(1),
    runId: BoundedIdentifierSchema,
    backendId: BoundedIdentifierSchema,
    backendTarget: z.optional(SessionOwnerBackendTargetV1Schema),
    resumeHandle: z.nullable(SessionOwnerResumeHandleV1Schema),
    updatedAtMs: TimestampSchema,
    transcriptContractVersion: z.number().check(z.int(), z.nonnegative()),
    welcomedEpoch: z.optional(z.number().check(z.int(), z.nonnegative())),
  })),
  voiceConversationScopeV1: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ v: z.literal(1), kind: z.literal('voice_home') }),
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('session_root'),
      sessionRootId: BoundedIdentifierSchema,
    }),
  ])),
  voiceConversationBindingV1: z.optional(z.strictObject({
    v: z.literal(1),
    adapterId: BoundedIdentifierSchema,
    controlSessionId: BoundedIdentifierSchema,
    transcriptMode: z.enum(['native_session', 'synthetic']),
    targetSessionId: OptionalOwnerIdentifierSchema,
    targetServerId: z.optional(OptionalOwnerIdentifierSchema),
    updatedAt: z.number(),
  })),
  voiceAgentStartupInstructionsV1:
    z.optional(AgentSessionStartupInstructionsMarkerV1Schema),
  voiceProviderConversationsV1: z.optional(z.strictObject({
    v: z.literal(1),
    providers: z.record(VoiceProviderIdSchema, z.strictObject({
      conversationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
      updatedAt: z.number().check(z.nonnegative()),
    })),
  })),
}));

const SessionOwnerHandoffV1Schema = lazyZodSchema(() => z.strictObject({
  handoffV1: z.optional(z.strictObject({
    v: z.literal(1),
    sourceMachineId: BoundedIdentifierSchema,
    targetMachineId: BoundedIdentifierSchema,
    agentId: BoundedIdentifierSchema,
    sessionStorageBefore: z.enum(['direct', 'persisted']),
    sessionStorageAfter: z.enum(['direct', 'persisted']),
    transportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
    completedAtMs: TimestampSchema,
    sourceWorkspaceRootPath: z.optional(OptionalOwnerStringSchema),
    targetWorkspaceRootPath: z.optional(OptionalOwnerStringSchema),
  })),
  acpTransportV1: z.optional(z.strictObject({
    v: z.literal(1),
    agentId: BoundedIdentifierSchema,
  })),
}));

/**
 * Strict plaintext inside the account/domain encrypted owner ciphertext.
 * Categories are deliberately disjoint; there is no raw metadata carrier.
 */
export const SessionOwnerMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(SESSION_OWNER_METADATA_VERSION_V1),
  workspace: z.optional(SessionOwnerWorkspaceV1Schema),
  nativeSession: z.optional(SessionOwnerNativeSessionV1Schema),
  runtime: z.optional(SessionOwnerRuntimeV1Schema),
  connectedServices: z.optional(SessionOwnerConnectedServicesV1Schema),
  history: z.optional(SessionOwnerHistoryV1Schema),
  handoff: z.optional(SessionOwnerHandoffV1Schema),
  cursors: z.optional(SessionOwnerCursorsV1Schema),
  work: z.optional(SessionOwnerWorkV1Schema),
  system: z.optional(SessionOwnerSystemV1Schema),
}));
export type SessionOwnerMetadataV1 = z.infer<
  typeof SessionOwnerMetadataV1Schema
>;

const {
  runtimeActivity: _sessionOwnerRuntimeActivity,
  ...SessionOwnerCompatibilityRuntimeShapeV1
} = SessionOwnerRuntimeV1Schema.shape;

const SessionOwnerCompatibilityRuntimeDescriptorV1Schema =
  SessionOwnerRuntimeDescriptorV1Schema;

/**
 * Local-only compatibility metadata consumed by current owner workflows.
 * This schema is intentionally separate from both encrypted envelope schemas:
 * Its current-domain shape must never be serialized back as shared metadata.
 * Role snapshots retain their canonical nested `work.sessionRolesV1` owner;
 * incumbent work-state and headline fields remain flat.
 */
export const SessionOwnerCompatibilityViewV1Schema = lazyZodSchema(() => z.strictObject({
  sessionGuardStateV1: z.optional(SessionGuardStateV1Schema),
  teamShareStatementV1: z.optional(SessionTeamShareStatementV1Schema),
  summary: z.optional(SessionSharedSummaryV1Schema),
  agentPresentation: z.optional(SessionSharedAgentPresentationV1Schema),
  externalSessionOperationPresentationV1:
    z.optional(ExternalSessionOperationSharedPresentationV1Schema),
  actionConfirmationsV1: z.optional(SessionActionConfirmationsV1Schema),
  ...SessionOwnerWorkspaceV1Schema.shape,
  path: z.string().check(z.maxLength(100_000)),
  host: z.string().check(z.maxLength(100_000)),
  homeDir: z.string().check(z.maxLength(100_000)),
  happyHomeDir: z.string().check(z.maxLength(100_000)),
  happyLibDir: z.string().check(z.maxLength(100_000)),
  happyToolsDir: z.string().check(z.maxLength(100_000)),
  ...SessionOwnerCompatibilityNativeSessionV1Schema.shape,
  externalSessionV1:
    z.optional(SessionOwnerCompatibilityExternalSessionLinkV1Schema),
  directSessionV1:
    z.optional(SessionOwnerCompatibilityDirectSessionLinkV1Schema),
  runtimeDescriptorV1:
    z.optional(SessionOwnerCompatibilityRuntimeDescriptorV1Schema),
  ...SessionOwnerCompatibilityRuntimeShapeV1,
  runtimeActivityState:
    z.optional(SessionRuntimeActivityProjectionSchema.shape.state),
  runtimeActivityActiveCount:
    z.optional(SessionRuntimeActivityProjectionSchema.shape.activeCount),
  runtimeActivityObservedAt:
    z.optional(SessionRuntimeActivityProjectionSchema.shape.observedAt),
  runtimeActivityRevision:
    z.optional(SessionRuntimeActivityProjectionSchema.shape.revision),
  ...SessionOwnerConnectedServicesV1Schema.shape,
  ...SessionOwnerHistoryV1Schema.shape,
  ...SessionOwnerHandoffV1Schema.shape,
  ...SessionOwnerCursorsV1Schema.shape,
  ...SessionOwnerCompatibilityFlatWorkShapeV1,
  work: z.optional(SessionOwnerPrivateWorkV1Schema),
  ...SessionOwnerSystemV1Schema.shape,
}).check(z.superRefine((value, context) => {
  if (
    value.externalSessionV1 === undefined
    || value.directSessionV1 === undefined
  ) {
    return;
  }
  const resolved = resolveLinkedExternalSessionMetadataV1(value);
  if (resolved.ok) return;
  context.addIssue({
    code: 'custom',
    path: ['externalSessionV1'],
    message: `Conflicting linked-session compatibility metadata: ${resolved.reason}`,
  });
  context.addIssue({
    code: 'custom',
    path: ['directSessionV1'],
    message: `Conflicting linked-session compatibility metadata: ${resolved.reason}`,
  });
})));
export type SessionOwnerCompatibilityViewV1 = z.infer<
  typeof SessionOwnerCompatibilityViewV1Schema
>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function readRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

const PREDECESSOR_PROVIDER_ALIAS_METADATA_KEYS = [
  'acpHistoryImportV1',
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
] as const;
const PREDECESSOR_MODEL_CATALOG_METADATA_KEYS = new Set<string>([
  'acpSessionModelsV1',
  'sessionModelsV1',
]);

function projectPositiveModelWindowHints(
  record: UnknownRecord,
): UnknownRecord {
  if (!Array.isArray(record.availableModels)) return record;
  let changed = false;
  const availableModels = record.availableModels.map((value) => {
    const model = readRecord(value);
    if (!model || model.contextWindowTokens === undefined) return value;
    if (
      typeof model.contextWindowTokens === 'number'
      && Number.isInteger(model.contextWindowTokens)
      && model.contextWindowTokens > 0
    ) {
      return value;
    }
    const { contextWindowTokens: _invalidWindowHint, ...rest } = model;
    changed = true;
    return rest;
  });
  return changed ? { ...record, availableModels } : record;
}

/**
 * Projects canonical flat Session metadata into the narrow dual-key wire shape
 * required by the prospective predecessor's metadata reader. Current Dev
 * readers immediately normalize these aliases back to the sole `agentId`
 * authority; the aliases are never admitted into owner metadata.
 *
 * Remove this projection only after the prospective predecessor no longer
 * requires `provider`/`providerId` and no supported mixed-version or rollback
 * direction can reach that reader.
 */
export function projectSessionMetadataAgentVocabularyWriteCompatibilityV1<T>(
  metadata: T,
): T {
  const record = readRecord(metadata);
  if (!record) return metadata;

  let next: Record<string, unknown> | null = null;
  const ensureNext = () => {
    next ??= { ...record };
    return next;
  };

  for (const key of PREDECESSOR_PROVIDER_ALIAS_METADATA_KEYS) {
    const value = readRecord((next ?? record)[key]);
    if (!value) continue;
    const agentId = typeof value.agentId === 'string'
      ? value.agentId.trim()
      : '';
    if (!agentId) continue;
    const withCompatibleWindow = PREDECESSOR_MODEL_CATALOG_METADATA_KEYS.has(key)
      ? projectPositiveModelWindowHints(value)
      : value;
    ensureNext()[key] = {
      ...withCompatibleWindow,
      provider: agentId,
    };
  }

  const handoff = readRecord((next ?? record).handoffV1);
  if (handoff) {
    const agentId = typeof handoff.agentId === 'string'
      ? handoff.agentId.trim()
      : '';
    if (agentId) {
      ensureNext().handoffV1 = {
        ...handoff,
        providerId: agentId,
      };
    }
  }

  if (record.runtimeDescriptorV1 !== undefined) {
    ensureNext().agentRuntimeDescriptorV1 =
      projectRuntimeDescriptorV1ForPredecessor(record.runtimeDescriptorV1);
  }

  const fork = readRecord((next ?? record).forkV1);
  const agentHint = readRecord(fork?.agentHint);
  if (fork && agentHint) {
    ensureNext().forkV1 = {
      ...fork,
      providerHint: {
        ...(typeof agentHint.agentId === 'string'
          ? { providerId: agentHint.agentId }
          : {}),
        ...(typeof agentHint.backendMode === 'string'
          ? { backendMode: agentHint.backendMode }
          : {}),
        ...(typeof agentHint.agentSessionId === 'string'
          ? { vendorSessionId: agentHint.agentSessionId }
          : {}),
      },
    };
  }

  return (next ?? metadata) as T;
}

function projectSummary(metadata: UnknownRecord): SessionSharedSummaryV1 | null {
  const parsed = createStoredReadSchema(SessionSharedSummaryV1Schema).safeParse(metadata.summary);
  return parsed.success ? parsed.data : null;
}

function projectAgentPresentation(
  metadata: UnknownRecord,
): SessionSharedAgentPresentationV1 | null {
  const explicit = createStoredReadSchema(SessionSharedAgentPresentationV1Schema).safeParse(
    metadata.agentPresentation,
  );
  if (explicit.success) return explicit.data;

  const runtimeDescriptor = readRecord(metadata.runtimeDescriptorV1);
  const legacyRuntimeDescriptor = readRecord(metadata.agentRuntimeDescriptorV1);
  const externalSession = readRecord(metadata.externalSessionV1);
  const directSession = readRecord(metadata.directSessionV1);
  const parsed = SessionSharedAgentPresentationV1Schema.safeParse({
    agentId:
      runtimeDescriptor?.agentId
      ?? legacyRuntimeDescriptor?.agentId
      ?? legacyRuntimeDescriptor?.providerId
      ?? externalSession?.agentId
      ?? directSession?.providerId
      ?? resolveGeneratedSessionPresentationAgentIdV1(metadata),
  });
  return parsed.success ? parsed.data : null;
}

function projectOperationPresentation(metadata: UnknownRecord) {
  const ownerState = createStoredReadSchema(ExternalSessionOperationStateV1Schema).safeParse(
    metadata[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
  );
  if (ownerState.success) {
    return projectExternalSessionOperationSharedPresentationV1(
      ownerState.data.progress,
    );
  }
  const presentation =
    createStoredReadSchema(ExternalSessionOperationSharedPresentationV1Schema).safeParse(
      metadata[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
    );
  return presentation.success ? presentation.data : null;
}

function projectPublicAgentState(
  agentStateInput: unknown,
): SessionPublicAgentStateV1 | null {
  const agentState = readRecord(agentStateInput);
  const completedRequests = readRecord(agentState?.completedRequests);
  if (!completedRequests) return null;

  const projectedEntries: Array<[string, SessionPublicCompletedRequestV1]> = [];
  for (const [requestId, requestInput] of Object.entries(completedRequests)) {
    if (projectedEntries.length >= MAX_PUBLIC_COMPLETED_REQUESTS_V1) break;
    const request = readRecord(requestInput);
    if (!request) continue;
    const reviewerClaim = request.status === 'approved'
      ? createStoredReadSchema(SessionPermissionApprovalReviewerClaimV1Schema).safeParse(request.permissionDecisionClaimV1)
      : null;
    const parsed = SessionPublicCompletedRequestV1Schema.safeParse({
      tool: request.tool,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      createdAt: request.createdAt,
      completedAt: request.completedAt,
      status: request.status,
      ...(reviewerClaim?.success ? { permissionDecisionClaimV1: reviewerClaim.data } : {}),
    });
    if (!parsed.success || requestId.trim().length === 0 || requestId.length > 512) {
      continue;
    }
    projectedEntries.push([requestId, parsed.data]);
  }
  if (projectedEntries.length === 0) return null;
  return SessionPublicAgentStateV1Schema.parse({
    completedRequests: Object.fromEntries(projectedEntries),
  });
}

/**
 * The sole legacy/current input projector into the recipient-safe envelope.
 * Unknown, malformed, and owner-authority facts are dropped by construction.
 */
export function projectSessionSharedMetadataV1(params: Readonly<{
  metadata: unknown;
  agentState?: unknown;
}>): SessionSharedMetadataV1 {
  const metadata = readRecord(params.metadata) ?? {};
  const bot = readSessionBotV1(metadata.bot);
  const summary = projectSummary(metadata);
  const agentPresentation = projectAgentPresentation(metadata);
  const externalSessionOperationPresentationV1 =
    projectOperationPresentation(metadata);
  const publicAgentState = projectPublicAgentState(params.agentState);
  const sessionGuardStateV1 = createStoredReadSchema(SessionGuardStateV1Schema).safeParse(metadata.sessionGuardStateV1);
  const teamShareStatementV1 = SessionTeamShareStatementV1Schema.safeParse(metadata.teamShareStatementV1);
  const actionConfirmationsV1 = createStoredReadSchema(SessionActionConfirmationsV1Schema).safeParse(
    metadata.actionConfirmationsV1,
  );
  const fork = readRecord(metadata.forkV1);
  const forkVisualsV1 = createStoredReadSchema(SessionForkVisualsV1Schema).safeParse(
    fork?.visualCopies === undefined ? metadata.forkVisualsV1 : { v: 1, copies: fork.visualCopies },
  );

  return SessionSharedMetadataV1Schema.parse({
    v: SESSION_SHARED_METADATA_VERSION_V1,
    ...(bot ? { bot } : {}),
    ...(summary ? { summary } : {}),
    ...(agentPresentation ? { agentPresentation } : {}),
    ...(externalSessionOperationPresentationV1
      ? { externalSessionOperationPresentationV1 }
      : {}),
    ...(publicAgentState ? { publicAgentState } : {}),
    ...(actionConfirmationsV1.success
      ? { actionConfirmationsV1: actionConfirmationsV1.data }
      : {}),
    ...(forkVisualsV1.success ? { forkVisualsV1: forkVisualsV1.data } : {}),
    ...(sessionGuardStateV1.success ? { sessionGuardStateV1: sessionGuardStateV1.data } : {}),
    ...(teamShareStatementV1.success ? { teamShareStatementV1: teamShareStatementV1.data } : {}),
  });
}

/**
 * Strict, pure owner-only adapter into the current flattened metadata model.
 * The public native Agent-state projection is deliberately excluded because
 * the owner already reads full Agent state. Action confirmations are retained:
 * a restricted runtime writes those through shared Session-DEK custody and
 * therefore they do not also exist in the owner's private AgentState.
 */
export function projectSessionOwnerCompatibilityViewV1(
  params: Readonly<{
    sharedMetadata: unknown;
    ownerMetadata: unknown;
  }>,
): SessionOwnerCompatibilityViewV1 {
  const sharedMetadata = StoredSessionSharedMetadataV1Schema.parse(
    params.sharedMetadata,
  );
  const ownerMetadata = createStoredReadSchema(SessionOwnerMetadataV1Schema).parse(
    migrateRetainedSessionMetadataContextV1(params.ownerMetadata),
  );
  const descriptor = ownerMetadata.nativeSession?.runtimeDescriptorV1;
  const runtimeDescriptorV1 = descriptor;
  const {
    runtimeDescriptorV1: _ownerRuntimeDescriptorV1,
    externalSessionV1: _ownerExternalSessionV1,
    directSessionV1: _ownerDirectSessionV1,
    ...nativeSession
  } = ownerMetadata.nativeSession ?? {};
  const linkedSessionResolution = (
    _ownerExternalSessionV1 === undefined && _ownerDirectSessionV1 === undefined
  )
    ? null
    : resolveLinkedExternalSessionMetadataV1({
        ...(_ownerExternalSessionV1 === undefined
          ? {}
          : { externalSessionV1: expandOwnerLinkedSessionVariant(
              _ownerExternalSessionV1,
              'externalSessionV1',
            ) }),
        ...(_ownerDirectSessionV1 === undefined
          ? {}
          : { directSessionV1: expandOwnerLinkedSessionVariant(
              _ownerDirectSessionV1,
              'directSessionV1',
            ) }),
      }, 'stored');
  if (linkedSessionResolution && !linkedSessionResolution.ok) {
    throw new Error(
      `Invalid linked-session owner metadata: ${linkedSessionResolution.reason}`,
    );
  }
  const normalizedLinkedSession = linkedSessionResolution
    ? buildLinkedExternalSessionMetadataV1(
        {},
        linkedSessionResolution.linkedSession,
      )
    : {};
  const {
    runtimeActivity,
    ...runtime
  } = ownerMetadata.runtime ?? {};
  const { bot, createdAsBot, sessionWorkStateV1, sessionWorkflowActivityHeadlineV1,
    sessionAgentActivityHeadlineV1, ...privateWork } = ownerMetadata.work ?? {};

  const canonical = SessionOwnerCompatibilityViewV1Schema.parse({
    ...(sharedMetadata.sessionGuardStateV1 ? { sessionGuardStateV1: sharedMetadata.sessionGuardStateV1 } : {}),
    ...(sharedMetadata.teamShareStatementV1 ? { teamShareStatementV1: sharedMetadata.teamShareStatementV1 } : {}),
    ...(sharedMetadata.summary
      ? { summary: sharedMetadata.summary }
      : {}),
    ...(sharedMetadata.agentPresentation
      ? { agentPresentation: sharedMetadata.agentPresentation }
      : {}),
    ...(sharedMetadata.externalSessionOperationPresentationV1
      ? {
          externalSessionOperationPresentationV1:
            sharedMetadata.externalSessionOperationPresentationV1,
        }
      : {}),
    ...(sharedMetadata.actionConfirmationsV1
      ? { actionConfirmationsV1: sharedMetadata.actionConfirmationsV1 }
      : {}),
    ...(ownerMetadata.workspace ?? {}),
    path: ownerMetadata.workspace?.path ?? '',
    host: ownerMetadata.workspace?.host ?? '',
    homeDir: ownerMetadata.workspace?.homeDir ?? '',
    happyHomeDir: ownerMetadata.workspace?.happyHomeDir ?? '',
    happyLibDir: ownerMetadata.workspace?.happyLibDir ?? '',
    happyToolsDir: ownerMetadata.workspace?.happyToolsDir ?? '',
    ...nativeSession,
    ...normalizedLinkedSession,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...runtime,
    ...(runtimeActivity
      ? {
          runtimeActivityState: runtimeActivity.state,
          runtimeActivityActiveCount: runtimeActivity.activeCount,
          ...('observedAt' in runtimeActivity
            ? { runtimeActivityObservedAt: runtimeActivity.observedAt }
            : {}),
          ...('revision' in runtimeActivity
            ? { runtimeActivityRevision: runtimeActivity.revision }
            : {}),
        }
      : {}),
    ...(ownerMetadata.connectedServices ?? {}),
    ...(ownerMetadata.history ?? {}),
    ...(ownerMetadata.handoff ?? {}),
    ...(ownerMetadata.cursors ?? {}),
    ...(bot ? { bot } : {}),
    ...(createdAsBot ? { createdAsBot } : {}),
    ...(sessionWorkStateV1 ? { sessionWorkStateV1 } : {}),
    ...(sessionWorkflowActivityHeadlineV1 ? { sessionWorkflowActivityHeadlineV1 } : {}),
    ...(sessionAgentActivityHeadlineV1 ? { sessionAgentActivityHeadlineV1 } : {}),
    ...(Object.keys(privateWork).length > 0 ? { work: privateWork } : {}),
    ...(ownerMetadata.system ?? {}),
  });
  return projectSessionMetadataAgentVocabularyWriteCompatibilityV1(canonical);
}

const SHARED_ONLY_METADATA_KEYS = new Set([
  'summary',
  'agentPresentation',
  'sessionGuardStateV1',
  'teamShareStatementV1',
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  'actionConfirmationsV1',
]);
const WORKSPACE_OWNER_KEYS = [
  'path',
  'host',
  'version',
  'name',
  'os',
  'machineId',
  'profileId',
  'homeDir',
  'happyHomeDir',
  'happyLibDir',
  'happyToolsDir',
  'flavor',
  'projectId',
  'workspaceId',
  'workspaceLocationId',
  'workspaceCheckoutId',
  'branch',
  'sessionWorkspaceLocationV1',
  'sessionDirectoryV1',
] as const;
const NATIVE_SESSION_SCALAR_OWNER_KEYS = [
  'nativeResumeIdentityV1',
  ...SESSION_NATIVE_VENDOR_RESUME_ID_FIELDS_V1,
  'claudeTranscriptPath',
  'claudeLastCheckpointId',
  'claudeLastAssistantUuid',
  'opencodeBackendMode',
  'opencodeServerBaseUrl',
  'opencodeServerBaseUrlExplicit',
  'auggieAllowIndexing',
  'tag',
  'piSessionFile',
  'providerSessionInfoV1',
] as const;

/**
 * The native-session facts an Agent itself owns and may contribute to session
 * metadata: resume identity, backend mode, and endpoint facts.
 *
 * `tag` is excluded because it is the host's identity/custody key, not an Agent
 * fact. Every other owner group (workspace, runtime, connected services,
 * history, handoff, cursors, work, system) is host-owned as a whole, so an
 * Agent-authored payload is projected through THIS list rather than through the
 * full owner allow-list, which would let a contribution write host state.
 */
export const AGENT_OWNED_SESSION_METADATA_KEYS_V1: readonly string[] =
  Object.freeze(
    NATIVE_SESSION_SCALAR_OWNER_KEYS.filter((key) => key !== 'tag'),
  );

const RELEASED_NATIVE_SESSION_COMPATIBILITY_KEYS = [
  'codexBackendMode',
] as const;

const RUNTIME_OWNER_KEYS = [
  'allowedTools',
  'unlistedTools',
  'workspaceWrites',
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  'terminal',
  'tools',
  'slashCommands',
  'slashCommandDetails',
  'permissionMode',
  'approvalReviewerEnabled',
  'permissionModeUpdatedAt',
  'hostPid',
  'hostProcessStartTimeMs',
  'hostProcessInstanceFingerprint',
  'startedFromDaemon',
  'startedBy',
  'sessionLogPath',
  'lifecycleState',
  'lifecycleStateSince',
  'archivedBy',
  'archiveReason',
  'sessionUsageLimitRecoveryV1',
  'sessionRunnerRuntimeV1',
  'sessionPendingQueueHoldV1',
  'sessionExplicitStopV1',
  'providerBindingV1',
  'modelSelectionIntentV1',
  'modelSelectionIntentV2',
  'sessionAppliedModelV1',
  'externalAgentObservationV1',
  'runtimeActivityState',
  'runtimeActivityActiveCount',
  'runtimeActivityObservedAt',
  'runtimeActivityRevision',
  'acpSessionModesV1',
  'sessionModesV1',
  'sessionModesV2',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
  'modelOverrideV1',
  'acpSessionModeOverrideV1',
  'sessionModeOverrideV1',
  'acpConfigOptionOverridesV1',
  'sessionConfigOptionOverridesV1',
  'acpConfiguredBackendV1',
  'agentRuntimeCapabilitiesV1',
  'agentRuntimeFacetsV1',
  'mcpSelectionV1',
  'mcpSelectionRestartRequiredV1',
  'skillSelectionV1',
  'skillSelectionRestartRequiredV1',
  'capabilitySelectionApplyV1',
] as const;
const CONNECTED_SERVICE_OWNER_KEYS = [
  'connectedServices',
  'connectedServicesUpdatedAt',
  'connectedServiceMaterializationIdentityV1',
  'providerAccountUsageRefsV1',
  'connectedServicePendingAuthGroupGenerationsV1',
  'claudeSubscriptionAccessTokenRefreshV1',
  'connectedServiceAccessTokenRefreshV1',
] as const;
const HISTORY_OWNER_KEYS = [
  'externalHistoryImportV1',
  'acpHistoryImportV1',
  'sessionRollbackRangesV1',
  'forkV1',
  'replaySeedV1',
  'forkInitialPromptV1',
  'sessionInitialPromptV1',
  'sessionMediaContinuityV1',
] as const;
const WORK_OWNER_KEYS = [
  'bot',
  'createdAsBot',
  'sessionWorkStateV1',
  'sessionWorkflowActivityHeadlineV1',
  'sessionAgentActivityHeadlineV1',
  'sessionGoalV1',
  'codexGoalV1',
] as const;
const SYSTEM_OWNER_KEYS = [
  'attestedContext',
  'sessionCreationCorrespondenceV1',
  'placementOrigin',
  'systemSessionV1',
  'hiddenSystemSession',
  'voiceAgentRunV1',
  'voiceConversationScopeV1',
  'voiceConversationBindingV1',
  'voiceAgentStartupInstructionsV1',
  'voiceProviderConversationsV1',
] as const;
const HANDOFF_OWNER_KEYS = ['handoffV1', 'acpTransportV1'] as const;
const CURSOR_OWNER_KEYS = [
  'externalSessionAttentionV1',
  'readStateV1',
  'discardedCommittedMessageLocalIds',
  'locallyConsumedUserMessageSeqsV1',
] as const;

const REMOVAL_ONLY_OWNER_KEYS = new Set([
  'runtimeActivitySourceClass',
]);

function copyPresentKeys(
  source: UnknownRecord,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}

function hasOnlyKeys(record: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function normalizeOwnerRuntimeDescriptorV1(
  input: unknown,
  purpose: 'input' | 'stored' = 'input',
): SessionOwnerRuntimeDescriptorV1 | null {
  const descriptor = readRuntimeDescriptorV1(input);
  if (!descriptor) return null;
  const parsed = (purpose === 'stored'
    ? createStoredReadSchema(SessionOwnerRuntimeDescriptorV1Schema)
    : SessionOwnerRuntimeDescriptorV1Schema).safeParse(descriptor);
  return parsed.success ? parsed.data : null;
}

function normalizeLinkedSessionVariants(
  metadata: UnknownRecord,
  purpose: 'input' | 'stored' = 'input',
): Readonly<{
  externalSessionV1?: z.infer<typeof SessionOwnerExternalSessionLinkV1Schema>;
}> | null {
  const hasExternalSession = metadata.externalSessionV1 !== undefined;
  const hasDirectSession = metadata.directSessionV1 !== undefined;
  if (!hasExternalSession && !hasDirectSession) return {};

  // Link reconciliation belongs to linkedSessionMetadata. Resolve the complete
  // persisted pair once so two individually valid but conflicting variants
  // cannot be projected into an owner envelope. Current owner writes always
  // project through externalSessionV1; directSessionV1 is ingress only for
  // released persisted rows.
  const resolved = resolveLinkedExternalSessionMetadataV1(metadata, purpose);
  if (!resolved.ok) return null;
  const normalized = buildLinkedExternalSessionMetadataV1(
    {},
    resolved.linkedSession,
  );
  const externalSessionV1 = (purpose === 'stored'
    ? createStoredReadSchema(SessionOwnerExternalSessionLinkV1Schema)
    : SessionOwnerExternalSessionLinkV1Schema).safeParse(
    normalized.externalSessionV1,
  );
  if (!externalSessionV1.success) return null;

  return {
    externalSessionV1: externalSessionV1.data,
  };
}

function normalizeAgentVocabularyRecord(
  input: unknown,
  legacyKey: 'providerId' | 'provider',
): Record<string, unknown> | null {
  const record = readRecord(input);
  if (!record) return null;
  const canonicalAgentId = typeof record.agentId === 'string'
    ? record.agentId.trim()
    : '';
  const legacyAgentId = typeof record[legacyKey] === 'string'
    ? String(record[legacyKey]).trim()
    : '';
  if (
    (!canonicalAgentId && !legacyAgentId)
    || (canonicalAgentId && legacyAgentId && canonicalAgentId !== legacyAgentId)
  ) {
    return null;
  }
  const { [legacyKey]: _legacyAgentId, ...rest } = record;
  return {
    ...rest,
    agentId: canonicalAgentId || legacyAgentId,
  };
}

function normalizeForkAgentVocabularyRecord(
  input: unknown,
): Record<string, unknown> | null {
  const record = readRecord(input);
  if (!record) return null;
  const canonicalHint = readRecord(record.agentHint);
  const predecessorHint = readRecord(record.providerHint);
  if (!canonicalHint && !predecessorHint) return { ...record };

  const canonicalAgentId = typeof canonicalHint?.agentId === 'string'
    ? canonicalHint.agentId.trim()
    : '';
  const predecessorAgentId = typeof predecessorHint?.providerId === 'string'
    ? predecessorHint.providerId.trim()
    : '';
  const canonicalSessionId =
    readNonBlankOpaqueIdentifier(canonicalHint?.agentSessionId) ?? '';
  const predecessorSessionId =
    readNonBlankOpaqueIdentifier(predecessorHint?.vendorSessionId) ?? '';
  const canonicalBackendMode = typeof canonicalHint?.backendMode === 'string'
    ? canonicalHint.backendMode.trim()
    : '';
  const predecessorBackendMode =
    typeof predecessorHint?.backendMode === 'string'
      ? predecessorHint.backendMode.trim()
      : '';
  if (
    (canonicalAgentId && predecessorAgentId
      && canonicalAgentId !== predecessorAgentId)
    || (canonicalSessionId && predecessorSessionId
      && canonicalSessionId !== predecessorSessionId)
    || (canonicalBackendMode && predecessorBackendMode
      && canonicalBackendMode !== predecessorBackendMode)
  ) {
    return null;
  }

  const { providerHint: _providerHint, ...rest } = record;
  return {
    ...rest,
    agentHint: {
      ...(canonicalAgentId || predecessorAgentId
        ? { agentId: canonicalAgentId || predecessorAgentId }
        : {}),
      ...(canonicalBackendMode || predecessorBackendMode
        ? { backendMode: canonicalBackendMode || predecessorBackendMode }
        : {}),
      ...(canonicalSessionId || predecessorSessionId
        ? { agentSessionId: canonicalSessionId || predecessorSessionId }
        : {}),
    },
  };
}

const SESSION_CATALOG_METADATA_KEYS = [
  'acpSessionModesV1',
  'sessionModesV1',
  'sessionModesV2',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
] as const;

export type CreateSessionOwnerMetadataV1Result =
  | Readonly<{ ok: true; ownerMetadata: SessionOwnerMetadataV1 }>
  | Readonly<{
      ok: false;
      error: 'unsupported_owner_metadata';
      unsupportedFields: readonly string[];
    }>;

function buildReleasedCodexRuntimeDescriptorV1(
  metadata: UnknownRecord,
): SessionOwnerRuntimeDescriptorV1 | null {
  if (!Object.hasOwn(metadata, 'codexBackendMode')) return null;
  const releasedMode = typeof metadata.codexBackendMode === 'string'
    ? metadata.codexBackendMode.trim()
    : '';
  const backendMode = releasedMode === 'mcp'
    ? 'appServer'
    : releasedMode === 'mcp_resume'
      ? 'acp'
      : releasedMode;
  if (backendMode !== 'appServer' && backendMode !== 'acp') return null;
  return normalizeOwnerRuntimeDescriptorV1({
    v: 1,
    agentId: 'codex',
    agent: {
      backendMode,
      ...(readNonBlankOpaqueIdentifier(metadata.codexSessionId)
        ? { providerSessionId: metadata.codexSessionId as string }
        : {}),
    },
  });
}

export function createSessionOwnerMetadataV1(params: Readonly<{
  metadata: unknown;
}>, purpose: 'input' | 'stored' = 'input'): CreateSessionOwnerMetadataV1Result {
  const storedRead = purpose === 'stored';
  const metadata = readRecord(params.metadata);
  if (!metadata) {
    return {
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['$'],
    };
  }

  const supportedKeys = new Set<string>([
    ...SHARED_ONLY_METADATA_KEYS,
    ...WORKSPACE_OWNER_KEYS,
    ...NATIVE_SESSION_SCALAR_OWNER_KEYS,
    ...RELEASED_NATIVE_SESSION_COMPATIBILITY_KEYS,
    ...RUNTIME_OWNER_KEYS,
    ...CONNECTED_SERVICE_OWNER_KEYS,
    ...HISTORY_OWNER_KEYS,
    ...HANDOFF_OWNER_KEYS,
    ...CURSOR_OWNER_KEYS,
    ...WORK_OWNER_KEYS,
    ...SYSTEM_OWNER_KEYS,
    ...REMOVAL_ONLY_OWNER_KEYS,
    'runtimeDescriptorV1',
    'agentRuntimeDescriptorV1',
    'externalSessionV1',
    'directSessionV1',
    'directSessionAttentionV1',
    'work',
  ]);
  const unsupportedFields = storedRead ? [] : Object.keys(metadata)
    .filter((key) => !supportedKeys.has(key));

  const hasReleasedCodexBackendMode = Object.hasOwn(metadata, 'codexBackendMode');
  const releasedCodexRuntimeDescriptorV1 = buildReleasedCodexRuntimeDescriptorV1(metadata);
  if (hasReleasedCodexBackendMode && !releasedCodexRuntimeDescriptorV1) {
    unsupportedFields.push('codexBackendMode');
  }
  const explicitRuntimeDescriptorInput = metadata.runtimeDescriptorV1
    ?? metadata.agentRuntimeDescriptorV1;
  const runtimeDescriptorInput = explicitRuntimeDescriptorInput
    ?? releasedCodexRuntimeDescriptorV1
    ?? undefined;
  const runtimeDescriptorV1 = runtimeDescriptorInput === undefined
    ? undefined
    : normalizeOwnerRuntimeDescriptorV1(runtimeDescriptorInput, purpose);
  if (runtimeDescriptorInput !== undefined && !runtimeDescriptorV1) {
    unsupportedFields.push(
      metadata.runtimeDescriptorV1 !== undefined
        ? 'runtimeDescriptorV1'
        : metadata.agentRuntimeDescriptorV1 !== undefined
          ? 'agentRuntimeDescriptorV1'
          : 'codexBackendMode',
    );
  }
  if (
    runtimeDescriptorV1
    && releasedCodexRuntimeDescriptorV1
    && (
      runtimeDescriptorV1.agentId !== releasedCodexRuntimeDescriptorV1.agentId
      || runtimeDescriptorV1.agent.backendMode
        !== releasedCodexRuntimeDescriptorV1.agent.backendMode
    )
  ) {
    unsupportedFields.push('codexBackendMode');
  }
  const linkedSessionVariants = normalizeLinkedSessionVariants(metadata, purpose);
  if (!linkedSessionVariants) {
    if (metadata.externalSessionV1 !== undefined) {
      unsupportedFields.push('externalSessionV1');
    }
    if (metadata.directSessionV1 !== undefined) {
      unsupportedFields.push('directSessionV1');
    }
  }

  const workspaceInput = copyPresentKeys(metadata, WORKSPACE_OWNER_KEYS);
  const nativeSessionInput = {
    ...copyPresentKeys(metadata, NATIVE_SESSION_SCALAR_OWNER_KEYS),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...linkedSessionVariants,
  };
  const runtimeInput = copyPresentKeys(metadata, RUNTIME_OWNER_KEYS);
  for (const key of SESSION_CATALOG_METADATA_KEYS) {
    if (metadata[key] === undefined) continue;
    const normalized = normalizeAgentVocabularyRecord(
      metadata[key],
      'provider',
    );
    if (normalized) runtimeInput[key] = normalized;
    else unsupportedFields.push(key);
  }
  const runtimeActivityFields = [
    'runtimeActivityState',
    'runtimeActivityActiveCount',
    'runtimeActivityObservedAt',
    'runtimeActivityRevision',
  ] as const;
  const presentRuntimeActivityFields = runtimeActivityFields.filter((key) =>
    Object.hasOwn(runtimeInput, key));
  if (presentRuntimeActivityFields.length > 0) {
    const hasProjection = presentRuntimeActivityFields.some((key) =>
      key === 'runtimeActivityObservedAt' || key === 'runtimeActivityRevision');
    const activityInput = hasProjection
      ? {
          state: runtimeInput.runtimeActivityState,
          activeCount: runtimeInput.runtimeActivityActiveCount,
          observedAt: runtimeInput.runtimeActivityObservedAt,
          revision: runtimeInput.runtimeActivityRevision,
        }
      : {
          state: runtimeInput.runtimeActivityState,
          activeCount: runtimeInput.runtimeActivityActiveCount,
        };
    const activitySchema = hasProjection
      ? SessionRuntimeActivityProjectionSchema
      : SessionRuntimeActivitySnapshotSchema;
    const activity = activitySchema.safeParse(activityInput);
    if (activity.success) {
      runtimeInput.runtimeActivity = activity.data;
    } else {
      unsupportedFields.push(...presentRuntimeActivityFields);
    }
    for (const key of runtimeActivityFields) delete runtimeInput[key];
  }
  const connectedServicesInput = copyPresentKeys(
    metadata,
    CONNECTED_SERVICE_OWNER_KEYS,
  );
  if (
    connectedServicesInput.connectedServiceMaterializationIdentityV1
    && typeof connectedServicesInput.connectedServiceMaterializationIdentityV1 === 'object'
  ) {
    const identity = {
      ...(connectedServicesInput.connectedServiceMaterializationIdentityV1 as Record<string, unknown>),
    };
    if (!Object.hasOwn(identity, 'createdAt') && typeof identity.createdAtMs === 'number') {
      identity.createdAt = identity.createdAtMs;
      delete identity.createdAtMs;
    }
    connectedServicesInput.connectedServiceMaterializationIdentityV1 = identity;
  }
  const historyInput = copyPresentKeys(metadata, HISTORY_OWNER_KEYS);
  if (metadata.externalHistoryImportV1 !== undefined) {
    const resolution = resolveExternalHistoryImportV1FromMetadata({
      externalHistoryImportV1: metadata.externalHistoryImportV1,
    }, purpose);
    if (resolution.state === 'valid') {
      historyInput.externalHistoryImportV1 = resolution.historyImport;
    } else {
      unsupportedFields.push('externalHistoryImportV1');
    }
  }
  if (metadata.acpHistoryImportV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.acpHistoryImportV1,
      'provider',
    );
    if (normalized) historyInput.acpHistoryImportV1 = normalized;
    else unsupportedFields.push('acpHistoryImportV1');
  }
  if (metadata.forkV1 !== undefined) {
    const normalized = normalizeForkAgentVocabularyRecord(metadata.forkV1);
    if (normalized) historyInput.forkV1 = normalized;
    else unsupportedFields.push('forkV1');
  }
  const handoffInput = copyPresentKeys(metadata, HANDOFF_OWNER_KEYS);
  if (metadata.handoffV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.handoffV1,
      'providerId',
    );
    if (normalized) handoffInput.handoffV1 = normalized;
    else unsupportedFields.push('handoffV1');
  }
  if (metadata.acpTransportV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.acpTransportV1,
      'provider',
    );
    if (normalized) handoffInput.acpTransportV1 = normalized;
    else unsupportedFields.push('acpTransportV1');
  }
  const cursorsInput = copyPresentKeys(metadata, CURSOR_OWNER_KEYS);
  if (metadata.directSessionAttentionV1 !== undefined) {
    if (metadata.externalSessionAttentionV1 !== undefined) {
      unsupportedFields.push('directSessionAttentionV1');
    } else {
      cursorsInput.externalSessionAttentionV1 =
        metadata.directSessionAttentionV1;
    }
  }
  const workInput = copyPresentKeys(metadata, [
    'bot',
    'createdAsBot',
    'sessionWorkStateV1',
    'sessionWorkflowActivityHeadlineV1',
    'sessionAgentActivityHeadlineV1',
  ]);
  if (Object.hasOwn(metadata, 'work')) {
    try {
      const roleWork = (storedRead ? createStoredReadSchema(SessionOwnerPrivateWorkV1Schema) : SessionOwnerPrivateWorkV1Schema)
        .safeParse(migrateRetainedSessionWorkContextV1(metadata.work));
      if (roleWork.success) {
        Object.assign(workInput, roleWork.data);
      } else {
        unsupportedFields.push(...roleWork.error.issues.map((issue) =>
          `work.${issue.path.join('.') || '$'}`));
      }
    } catch {
      unsupportedFields.push('work.sessionRolesV1.memoryDocRef');
    }
  }
  const legacyGoalInput = metadata.sessionGoalV1 ?? metadata.codexGoalV1;
  if (legacyGoalInput !== undefined) {
    if (metadata.sessionWorkStateV1 !== undefined) {
      // The canonical state already owns the same facts; remove the legacy alias.
    } else {
      const legacyGoalSchema = z.strictObject({
        objective: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4_000))),
        title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4_000))),
        status: z.optional(z.enum([
          'pending',
          'active',
          'paused',
          'blocked',
          'complete',
          'cancelled',
          'unknown',
        ])),
        statusReason: z.optional(z.enum([
          'blocked',
          'usageLimited',
          'budgetLimited',
          'interrupted',
        ])),
        createdAt: z.optional(TimestampSchema),
        startedAt: z.optional(TimestampSchema),
        completedAt: z.optional(TimestampSchema),
        updatedAt: z.optional(TimestampSchema),
        tokenBudget: z.optional(z.nullable(z.number().check(z.positive()))),
        tokensUsed: z.optional(z.number().check(z.int(), z.nonnegative())),
        timeUsedSeconds: z.optional(z.number().check(z.nonnegative())),
      });
      const legacyGoal = (storedRead ? createStoredReadSchema(legacyGoalSchema) : legacyGoalSchema).safeParse(legacyGoalInput);
      const title = legacyGoal.success
        ? legacyGoal.data.objective ?? legacyGoal.data.title
        : undefined;
      if (!legacyGoal.success || !title) {
        unsupportedFields.push(
          metadata.sessionGoalV1 !== undefined ? 'sessionGoalV1' : 'codexGoalV1',
        );
      } else {
        const updatedAt = legacyGoal.data.updatedAt ?? 0;
        const backendId =
          runtimeDescriptorV1?.agentId
          ?? resolveGeneratedSessionPresentationAgentIdV1(metadata)
          ?? 'codex';
        workInput.sessionWorkStateV1 = {
          v: 1,
          backendId,
          agentId: runtimeDescriptorV1?.agentId,
          updatedAt,
          primaryItemId: 'goal:legacy',
          items: [{
            id: 'goal:legacy',
            kind: 'goal',
            origin: 'vendor',
            status: legacyGoal.data.status ?? 'active',
            title,
            updatedAt,
            ...(legacyGoal.data.statusReason
              ? { statusReason: legacyGoal.data.statusReason }
              : {}),
            ...(legacyGoal.data.createdAt !== undefined
              ? { createdAt: legacyGoal.data.createdAt }
              : {}),
            ...(legacyGoal.data.startedAt !== undefined
              ? { startedAt: legacyGoal.data.startedAt }
              : {}),
            ...(legacyGoal.data.completedAt !== undefined
              ? { completedAt: legacyGoal.data.completedAt }
              : {}),
            ...(legacyGoal.data.tokenBudget !== undefined
              ? { tokenBudget: legacyGoal.data.tokenBudget }
              : {}),
            ...(legacyGoal.data.tokensUsed !== undefined
              ? { tokensUsed: legacyGoal.data.tokensUsed }
              : {}),
            ...(legacyGoal.data.timeUsedSeconds !== undefined
              ? { timeUsedSeconds: legacyGoal.data.timeUsedSeconds }
              : {}),
          }],
        };
      }
    }
  }
  const systemInput = copyPresentKeys(metadata, SYSTEM_OWNER_KEYS);
  delete systemInput.hiddenSystemSession;
  if (
    metadata.hiddenSystemSession !== undefined
    && metadata.systemSessionV1 === undefined
  ) {
    if (typeof metadata.hiddenSystemSession !== 'boolean') {
      unsupportedFields.push('hiddenSystemSession');
    } else if (metadata.hiddenSystemSession) {
      systemInput.systemSessionV1 = {
        v: 1,
        key: 'legacy-hidden-system-session',
        hidden: true,
      };
    }
  }
  if (metadata.voiceAgentRunV1 !== undefined) {
    const voiceAgentRun = readRecord(metadata.voiceAgentRunV1);
    const allowedVoiceAgentRunKeys = new Set([
      'v',
      'runId',
      'backendId',
      'backendTarget',
      'resumeHandle',
      'updatedAtMs',
      'transcriptContractVersion',
      'welcomedEpoch',
      'streamId',
    ]);
    if (!voiceAgentRun || !hasOnlyKeys(voiceAgentRun, allowedVoiceAgentRunKeys)) {
      unsupportedFields.push('voiceAgentRunV1');
    } else {
      const canonicalVoiceAgentRun =
        parseVoiceAgentRunMetadataV1(voiceAgentRun);
      if (!canonicalVoiceAgentRun) {
        unsupportedFields.push('voiceAgentRunV1');
      } else {
        const resumeHandle = canonicalVoiceAgentRun.resumeHandle;
        const strictResumeHandle = resumeHandle === null
          ? null
          : SessionOwnerResumeHandleV1Schema.safeParse(
              resumeHandle.kind === 'provider_session.v1'
                ? {
                    kind: resumeHandle.kind,
                    backendTarget: resumeHandle.backendTarget,
                    providerSessionId: resumeHandle.providerSessionId,
                  }
                : resumeHandle.kind === 'voice_agent_sessions.v1'
                  ? {
                      kind: resumeHandle.kind,
                      backendTarget: resumeHandle.backendTarget,
                      chatProviderSessionId: resumeHandle.chatProviderSessionId,
                      commitProviderSessionId: resumeHandle.commitProviderSessionId,
                    }
                  : null,
            );
        systemInput.voiceAgentRunV1 = {
          ...canonicalVoiceAgentRun,
          resumeHandle: strictResumeHandle === null
            ? null
            : strictResumeHandle.success
              ? strictResumeHandle.data
              : null,
        };
      }
    }
  }

  const categoryInputs = [
    ['workspace', SessionOwnerWorkspaceV1Schema, workspaceInput],
    ['nativeSession', SessionOwnerNativeSessionV1Schema, nativeSessionInput],
    ['runtime', SessionOwnerRuntimeV1Schema, runtimeInput],
    ['connectedServices', SessionOwnerConnectedServicesV1Schema, connectedServicesInput],
    ['history', SessionOwnerHistoryV1Schema, historyInput],
    ['handoff', SessionOwnerHandoffV1Schema, handoffInput],
    ['cursors', SessionOwnerCursorsV1Schema, cursorsInput],
    ['work', SessionOwnerWorkV1Schema, workInput],
    ['system', SessionOwnerSystemV1Schema, systemInput],
  ] as const;
  const ownerMetadata: Record<string, unknown> = {
    v: SESSION_OWNER_METADATA_VERSION_V1,
  };
  for (const [category, schema, input] of categoryInputs) {
    if (Object.keys(input).length === 0) continue;
    const parsed = (storedRead ? createStoredReadSchema(schema) : schema).safeParse(input);
    if (!parsed.success) {
      unsupportedFields.push(
        ...parsed.error.issues.map((issue) =>
          `${category}.${issue.path.join('.') || '$'}`),
      );
      continue;
    }
    ownerMetadata[category] = parsed.data;
  }

  const deduplicatedUnsupportedFields = [...new Set(unsupportedFields)].sort();
  if (deduplicatedUnsupportedFields.length > 0) {
    return {
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: deduplicatedUnsupportedFields,
    };
  }
  return {
    ok: true,
    ownerMetadata: SessionOwnerMetadataV1Schema.parse(ownerMetadata),
  };
}

/** Null clears the Session choice; absence preserves the permission owner's Account-default fallback. */
export function writeSessionApprovalReviewerOverrideV1<T extends Record<string, unknown>>(
  metadata: T,
  enabled: boolean | null,
): T {
  if (enabled !== null) {
    return metadata.approvalReviewerEnabled === enabled ? metadata : { ...metadata, approvalReviewerEnabled: enabled };
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, 'approvalReviewerEnabled')) return metadata;
  const next = { ...metadata };
  delete next.approvalReviewerEnabled;
  return next;
}

export function createPlainSessionOwnerMetadataEnvelopeV1(
  ownerMetadata: SessionOwnerMetadataV1,
): SessionOwnerMetadataEnvelopeV1 {
  return SessionOwnerMetadataEnvelopeV1Schema.parse({
    t: 'plain',
    v: ownerMetadata,
  });
}

export function encodeSessionOwnerMetadataEnvelopeV1(
  envelope: SessionOwnerMetadataEnvelopeV1,
): string {
  return JSON.stringify(SessionOwnerMetadataEnvelopeV1Schema.parse(envelope));
}

export function parseSessionOwnerMetadataEnvelopeV1(
  encoded: string,
): SessionOwnerMetadataEnvelopeV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  try {
    const envelope = readRecord(value);
    const normalized = envelope?.t === 'plain' ? { ...envelope, v: migrateRetainedSessionMetadataContextV1(envelope.v) } : value;
    const parsed = createStoredReadSchema(SessionOwnerMetadataEnvelopeV1Schema).safeParse(normalized);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function validateSessionOwnerMetadataEnvelopeForAccountModeV1(
  params: Readonly<{
    accountMode: AccountEncryptionMode;
    envelope: unknown;
  }>,
): ValidateSessionOwnerMetadataEnvelopeForAccountModeV1Result {
  if (params.accountMode !== 'plain' && params.accountMode !== 'e2ee') {
    return { ok: false, reason: 'account_mode_mismatch' };
  }
  const parsed = SessionOwnerMetadataEnvelopeV1Schema.safeParse(
    params.envelope,
  );
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  const expectedKind = params.accountMode === 'plain'
    ? 'plain'
    : 'encrypted';
  if (parsed.data.t !== expectedKind) {
    return { ok: false, reason: 'account_mode_mismatch' };
  }
  return { ok: true, envelope: parsed.data };
}

export function isSessionOwnerMetadataCiphertextV1(
  ciphertext: string,
): boolean {
  if (typeof ciphertext !== 'string') return false;
  const retained = ownerMetadataCiphertextValidationScope?.get(ciphertext);
  if (retained !== undefined) return retained;
  const valid = readAccountScopedCiphertextKindByte(ciphertext, 'canonical') === SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND_BYTE_V1;
  ownerMetadataCiphertextValidationScope?.set(ciphertext, valid);
  return valid;
}
