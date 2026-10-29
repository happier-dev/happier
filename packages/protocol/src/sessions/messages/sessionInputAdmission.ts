import * as zMini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { z } from 'zod/mini';
import { CallerInputConstraintsV1Schema } from '../../auth/callerInputConstraintsV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { ActionRequestAttributionV1Schema } from '../../actions/actionRequestAttributionV1.js';
import { isRunFollowOriginalV1, SessionFollowInputV1Schema, SessionFollowReceiptDeliveryV1Schema } from '../follow/sessionFollowInputV1.js';
import { DiscussionAddressingV1Schema } from '../../discussions/references.js';
import { SessionFollowSourceOccurrenceWitnessesV1Schema, SessionFollowRelationWitnessesV1Schema } from '../follow/sessionFollowSourceOccurrenceV1.js';
import { NextTurnFileReviewNoteV1Schema } from '../../messages/structured/fileReviewNoteV1.js';

import {
  assertNonEscalatingPermissionMode,
  resolveEffectivePermissionMode,
} from '../../actions/permissionPrivilege.js';
import type { ActionSurfaces } from '../../actions/metadata.js';
import { encodeBase64 } from '../../crypto/base64.js';
import { readConversationTurnOriginV1FromMessageMeta } from '../../messages/structured/conversationTurnOriginV1.js';
import { SubagentLaunchV1Schema } from '../../messages/structured/subagentLaunchV1.js';
import { SubagentCommandV1Schema } from '../../messages/structured/subagentCommandV1.js';
import { ParticipantRecipientRoutingIdentityV1Schema } from '../../messages/structured/participantMessageV1.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { SessionMessageRefV1Schema } from './sessionMessageRefV1.js';
import { SessionMessageReplyResolvedOutcomeV1Schema } from './sessionMessageReplyV1.js';
import { SessionWorkDepthV1Schema } from '../creation/sessionCreateOriginV1.js';
import {
  SessionMutationEqualityBase64UrlSha256V1Schema,
  SessionMutationEqualityEvidenceV1Schema,
  serializeCanonicalJsonForSessionMutationEqualityV1,
} from '../mutations/sessionMutationEqualityV1.js';
import { PendingLocalIdSchema, readPendingLocalId } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema, type PendingRequestedActionV1 } from '../pending/pendingRequestedActionV1.js';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, RawIngressStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { asProtocolZod, projectZodProtocolSchema } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { withSessionTargetFanoutResultV1 } from '../../actions/sessionTargetV1.js';
import { preservedBoundedNfcString } from '../../strings/preservedBoundedNfcString.js';
import { WorkflowInvocationRecordIdSchema } from '../../workflows/workflowIdsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from './sessionInputAuthoringV1.js';
import { SessionInputAdmissionRejectionCodeV1Schema } from './sessionInputAdmissionRejectionV1.js';
import { SessionInputForgeEvidenceV1Schema } from './sessionInputForgeEvidenceV1.js';
export {
  SESSION_INPUT_ADMISSION_REJECTION_CODES_V1,
  SessionInputAdmissionRejectionCodeV1Schema,
} from './sessionInputAdmissionRejectionV1.js';
export type { SessionInputAdmissionRejectionCodeV1 } from './sessionInputAdmissionRejectionV1.js';
export {
  PluginSessionInputAttachmentV1Schema,
  PluginSessionInputAttachmentsV1Schema,
  hasSessionInputContentV1,
  requireSessionInputContent,
} from './sessionInputAuthoringV1.js';
export type { PluginSessionInputAttachmentV1 } from './sessionInputAuthoringV1.js';

export const SESSION_MESSAGE_PROVENANCE_META_KEY = 'happierProvenanceV1' as const;
export type { SessionInputResultV1, SessionInputUsageV1, SessionInputResultGetResultV1 } from './sessionInputResultV1.js';
export { SessionInputRefusalDispositionV1Schema } from './sessionInputResultV1.js';
export type { SessionInputRefusalDispositionV1 } from './sessionInputResultV1.js';
export const SESSION_INPUT_REQUEST_META_KEY = 'happierInputRequestV1' as const;
export const SESSION_INPUT_AUTHORITY_META_KEY = 'happierInputAuthorityV1' as const;

const UTF8_ENCODER = new TextEncoder();
const MAX_PROVENANCE_BYTES = 4 * 1024;
const PLUGIN_SESSION_INPUT_LOCAL_ID_DOMAIN_V1 = 'happier.session-input.local-id.v1';
const WORKFLOW_SESSION_INPUT_LOCAL_ID_DOMAIN_V2 = 'happier.workflow-session-input.local-id.v2';

/**
 * Canonical bytes shared by trusted host/server equality code. This is a
 * serializer only: plugins never supply a digest, HMAC, or encryption nonce.
 *
 * The canonical JSON owner is the shared Session-mutation equality primitive;
 * these bytes are unchanged by that extraction.
 */
export function serializeSessionInputRequestEqualityIntentV1(params: Readonly<{
  requestEnvelope: unknown;
  requestedAction: PendingRequestedActionV1;
}>): string {
  const requestedAction = PendingRequestedActionV1Schema.parse(params.requestedAction);
  const frame = { v: 1, requestEnvelope: params.requestEnvelope, requestedAction };
  // Preserve canonical-JSON rejection before a projection can copy descriptors
  // or omit the transport field. Non-media inputs keep their exact old bytes.
  const canonical = serializeCanonicalJsonForSessionMutationEqualityV1(frame);
  const mediaEnvelope = projectStagedMediaRequestEqualityEnvelope(params.requestEnvelope);
  if (mediaEnvelope === null) return canonical;
  return serializeCanonicalJsonForSessionMutationEqualityV1({
    ...frame,
    requestEnvelope: mediaEnvelope,
    // Serializer-owned domain separation prevents malformed caller input with
    // a missing handle id from colliding with a validated semantic projection.
    stagedMediaIdentity: 'immutableContentV1',
  });
}

function projectStagedMediaPlainInputEquality(content: unknown): Record<string, unknown> | null {
  if (!isRecord(content) || content.t !== 'plain' || !isRecord(content.v)) return null;
  const record = content.v;
  if (record.role !== 'user' || !isRecord(record.content) || record.content.type !== 'text'
    || typeof record.content.text !== 'string' || !isRecord(record.meta)) return null;
  const meta = record.meta;
  const structured = meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
  if (!isRecord(structured) || !Array.isArray(structured.composerAttachments)
    || !RawIngressStructuredInputV1Schema.safeParse(structured).success) return null;
  let projected = false;
  const composerAttachments = structured.composerAttachments.map(attachment => {
    if (!isRecord(attachment) || !isRecord(attachment.content) || attachment.content.kind !== 'stagedMedia'
      || !isRecord(attachment.content.handle)) return attachment;
    const { id: _transportId, ...immutableHandle } = attachment.content.handle;
    projected = true;
    return { ...attachment, content: { ...attachment.content, handle: immutableHandle } };
  });
  return projected ? { ...content, v: { ...record, meta: { ...meta,
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { ...structured, composerAttachments },
  } } } : null;
}

function projectStagedMediaRequestEqualityEnvelope(envelope: unknown): Record<string, unknown> | null {
  const plain = projectStagedMediaPlainInputEquality(envelope);
  if (plain !== null) return plain;
  // This is the existing trusted host's E2EE signing carrier. Do not recurse
  // into arbitrary metadata bags or normalize staged-media lookalikes there.
  if (!isRecord(envelope) || envelope.v !== 1 || envelope.kind !== 'sessionInputRequest'
    || typeof envelope.localId !== 'string') return null;
  const content = projectStagedMediaPlainInputEquality(envelope.content);
  return content === null ? null : { ...envelope, content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DisplayNameSnapshotSchema = lazyZodSchema(() => z.string().check(z.refine((value) => value === value.normalize('NFC'), 'Display-name snapshots must be NFC-normalized'), z.refine((value) => Array.from(value).length <= 128, 'Display-name snapshots must contain at most 128 Unicode code points')));

const SourceRefSchema = preservedBoundedNfcString(256, 'Source references');
const SourceRevisionOrEpochSchema = preservedBoundedNfcString(128, 'Source revisions');
const BoundedAutomationIdSchema = preservedBoundedNfcString(191, 'Automation ids');
export const BoundedAutomationRunIdSchema = preservedBoundedNfcString(191, 'Automation run ids');

export const PLUGIN_INVOCATION_SURFACES_V1 = [
  'cli',
  'mcp',
  'agent',
  'ui',
  'background',
] as const;

export const PluginInvocationSurfaceV1Schema = lazyZodSchema(() => z.enum(PLUGIN_INVOCATION_SURFACES_V1));
export type PluginInvocationSurfaceV1 = z.infer<typeof PluginInvocationSurfaceV1Schema>;

export const ExternalActorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['human', 'bot']),
  displayNameSnapshot: z.optional(DisplayNameSnapshotSchema),
}));
export type ExternalActorV1 = z.infer<typeof ExternalActorV1Schema>;

export const ContentProvenanceV1Schema = lazyZodSchema(() => z.enum(['original', 'forwarded', 'viaBot']));
export type ContentProvenanceV1 = z.infer<typeof ContentProvenanceV1Schema>;

function requireCoPresentExternalProvenance(
  value: Readonly<{
    externalActor?: unknown;
    contentProvenance?: unknown;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if ((value.externalActor === undefined) === (value.contentProvenance === undefined)) return;
  context.addIssue({
    code: 'custom',
    path: value.externalActor === undefined ? ['externalActor'] : ['contentProvenance'],
    message: 'External actor and content provenance must be supplied together',
  });
}

export const PluginSessionInputIdempotencyKeyV1Schema = preservedBoundedNfcString(
  256,
  'Plugin Session input idempotency keys',
);

export const PluginSessionInputSourceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
  requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  externalActor: z.optional(ExternalActorV1Schema),
  contentProvenance: z.optional(ContentProvenanceV1Schema),
}).check(z.superRefine(requireCoPresentExternalProvenance)));
export type PluginSessionInputSourceV1 = z.infer<typeof PluginSessionInputSourceV1Schema>;

/**
 * Canonical authored fields shared by the trusted-plugin SessionHandle request
 * and its `session.message.send` Action projection. The two carriers
 * intentionally use different text/session field names, but must not drift on
 * recipient routing, idempotency, source provenance, attachments, or tool
 * answer delivery.
 *
 * This is a Zod raw shape, not another admission schema or decision-maker.
 */
export const PluginSessionUserTextAuthoredFieldSchemasV1 = Object.freeze({
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
  recipient: zMini.optional(ParticipantRecipientRoutingIdentityV1Schema),
  source: z.optional(PluginSessionInputSourceV1Schema),
  attachments: zMini.optional(PluginSessionInputAttachmentsV1Schema),
  /** Descriptive authored context only; neither its source nor author grants authority. */
  forgeEvidence: z.optional(asProtocolZod(SessionInputForgeEvidenceV1Schema)),
  /** Identifies a provider-facing reply whose visible answer belongs on its question tool. */
  toolAnswerDelivery: z.optional(z.strictObject({ toolCallId: z.string().check(z.trim(), z.minLength(1)) })),
});

/** Public plugin-authored intent. Caller identity and admitted authority are host-owned. */
const PluginSessionUserTextInputRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('userText'),
  /**
   * Blank only when an attachment carries the input. `requireSessionInputContent`
   * is the single gate; a `.min(1)` here would restore the divergence.
   */
  text: z.string(),
  ...PluginSessionUserTextAuthoredFieldSchemasV1,
}).check(z.superRefine(requireSessionInputContent)));

const PluginSessionSubagentLaunchInputRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}));

const PluginSessionSubagentCommandInputRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('sessionSubagentCommand'),
  command: SubagentCommandV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}));

export const PluginSessionInputRequestV1Schema = lazyZodSchema(() => z.union([
  PluginSessionUserTextInputRequestV1Schema,
  PluginSessionSubagentLaunchInputRequestV1Schema,
  PluginSessionSubagentCommandInputRequestV1Schema,
]));
export type PluginSessionInputRequestV1 = z.infer<typeof PluginSessionInputRequestV1Schema>;

/** Canonical durable Pending identity for one host-attributed plugin Session input. */
export function derivePluginSessionInputLocalIdV1(params: Readonly<{
  caller: Readonly<{
    pluginId: string;
    contributionLocalId?: string;
  }>;
  sessionId: string;
  idempotencyKey: string;
}>): string {
  const pluginId = PluginIdSchema.parse(params.caller.pluginId);
  const contributionLocalId = PluginContributionLocalIdSchema.parse(
    params.caller.contributionLocalId,
  );
  const sessionId = SessionIdSchema.parse(params.sessionId);
  const idempotencyKey = PluginSessionInputIdempotencyKeyV1Schema.parse(params.idempotencyKey);
  const canonicalIdentity = JSON.stringify([
    PLUGIN_SESSION_INPUT_LOCAL_ID_DOMAIN_V1,
    1,
    'plugin',
    pluginId,
    contributionLocalId,
    sessionId,
    idempotencyKey,
  ]);
  const localId = readPendingLocalId(
    `plugin-input-v1:${encodeBase64(sha256(UTF8_ENCODER.encode(canonicalIdentity)), 'base64url')}`,
  );
  if (localId === null) throw new Error('Derived plugin Session input local id is invalid');
  return localId;
}

const HappierAppProvenanceSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('happierApp'),
  actor: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('owner') }),
    z.strictObject({ kind: z.literal('sharedCollaborator') }),
    /** Host-stamped question answerer; no grant or relationship is inferred. */
    z.strictObject({ kind: z.literal('person'), accountId: AccountIdSchema }),
  ]),
}));

const PluginSessionProvenanceSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('pluginSession'),
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  surface: z.union([PluginInvocationSurfaceV1Schema, z.literal('unspecified')]),
  sourceRef: zMini.optional(SourceRefSchema),
  sourceRevisionOrEpoch: zMini.optional(SourceRevisionOrEpochSchema),
  externalActor: z.optional(ExternalActorV1Schema),
  contentProvenance: z.optional(ContentProvenanceV1Schema),
}).check(z.superRefine((value, context) => {
  if ((value.sourceRef === undefined) !== (value.sourceRevisionOrEpoch === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceRef'],
      message: 'Plugin Session provenance requires sourceRef and sourceRevisionOrEpoch together',
    });
  }
  requireCoPresentExternalProvenance(value, context);
})));

const MessageProvenanceUnionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  HappierAppProvenanceSchema,
  z.strictObject({ v: z.literal(1), kind: z.literal('cli') }),
  z.strictObject({ v: z.literal(1), kind: z.literal('voice') }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('happierSession'),
    sourceSessionId: asProtocolZod(SessionIdSchema),
    via: z.enum(['action', 'mcp']),
    callerDepth: zMini.optional(SessionWorkDepthV1Schema),
  }),
  PluginSessionProvenanceSchema,
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('automation'),
    automationId: BoundedAutomationIdSchema,
    runId: BoundedAutomationRunIdSchema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('host'),
    producer: z.enum([
      'happierApp',
      'cli',
      'sessionAction',
      'happierMcp',
      'pluginSession',
      'automation',
      'voiceInput',
      'externalSessionHistory',
      'runtimeTranscript',
      'executionRunVoice',
      'agentRuntimeFirstInput',
    ]),
  }),
]));

export const SessionMessageProvenanceV1Schema = lazyZodSchema(() => MessageProvenanceUnionSchema.check(z.superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PROVENANCE_BYTES) {
    context.addIssue({
      code: 'custom',
      message: 'Session message provenance exceeds its encoded 4 KiB limit',
    });
  }
})));
export type SessionMessageProvenanceV1 = z.infer<typeof SessionMessageProvenanceV1Schema>;

/**
 * The step's visible number, stamped by the host that runs it from `workflowBlockOrdinalV1` (the same
 * owner the step's heading, map node and Session title read). A transcript shows it as written; it
 * never recomputes a number it has no definition for.
 */
const WorkflowStepOrdinalV1Schema = z.string().check(z.regex(/^[1-9][0-9]*$/u));

export const SessionMessageProvenanceV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(2), kind: z.literal('workflow_invocation'),
    runId: BoundedAutomationRunIdSchema,
    invocationRecordId: WorkflowInvocationRecordIdSchema,
    workDepth: zMini.optional(SessionWorkDepthV1Schema),
    stepOrdinal: z.optional(WorkflowStepOrdinalV1Schema),
  }),
]).check(z.superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PROVENANCE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Session message provenance exceeds its encoded 4 KiB limit' });
  }
})));
export type SessionMessageProvenanceV2 = z.infer<typeof SessionMessageProvenanceV2Schema>;
export const SessionMessageProvenanceSchema = lazyZodSchema(() => z.union([SessionMessageProvenanceV1Schema, SessionMessageProvenanceV2Schema]));
export type SessionMessageProvenance = z.infer<typeof SessionMessageProvenanceSchema>;

export const SESSION_ROLE_USER_PRODUCER_KINDS_V1 = [
  'happierApp',
  'cli',
  'sessionAction',
  'happierMcp',
  'pluginSession',
  'automation',
  'voiceInput',
  'externalSessionHistory',
  'runtimeTranscript',
  'executionRunVoice',
  'agentRuntimeFirstInput',
] as const;

export const SessionRoleUserProducerKindV1Schema = lazyZodSchema(() => z.enum(SESSION_ROLE_USER_PRODUCER_KINDS_V1));
export type SessionRoleUserProducerKindV1 = z.infer<typeof SessionRoleUserProducerKindV1Schema>;

export const SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1 = Object.freeze({
  happierApp: 'pendingInput',
  cli: 'pendingInput',
  sessionAction: 'pendingInput',
  happierMcp: 'pendingInput',
  pluginSession: 'pendingInput',
  automation: 'pendingInput',
  voiceInput: 'pendingInput',
  externalSessionHistory: 'transcriptOnly',
  runtimeTranscript: 'transcriptOnly',
  executionRunVoice: 'transcriptOnly',
  agentRuntimeFirstInput: 'pendingInput',
} as const satisfies Record<SessionRoleUserProducerKindV1, SessionRoleUserProducerAdmissionModeV1>);

export type SessionRoleUserProducerAdmissionModeV1 =
  | 'pendingInput'
  | 'directInput'
  | 'transcriptOnly';

export type SessionTranscriptMessageProducerKindV1 = {
  [Producer in SessionRoleUserProducerKindV1]:
    (typeof SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1)[Producer] extends 'transcriptOnly'
      ? Producer
      : never;
}[SessionRoleUserProducerKindV1];

/** Sole descriptive provenance builder for already-observed role-user transcript rows. */
export function buildSessionTranscriptMessageProvenanceV1(
  producer: SessionTranscriptMessageProducerKindV1,
): SessionMessageProvenanceV1 {
  if (SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1[producer] !== 'transcriptOnly') {
    throw new TypeError(`Producer ${producer} is not transcript-only`);
  }
  return SessionMessageProvenanceV1Schema.parse({ v: 1, kind: 'host', producer });
}

const SessionInputCallerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }),
  z.strictObject({ kind: z.literal('host') }),
]));

export const SessionInputSourceSessionV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: asProtocolZod(SessionIdSchema),
  sourceTurnId: TurnIdSchema,
  sourceInputId: z.optional(PendingLocalIdSchema),
  via: z.enum(['action', 'mcp']),
  /** Host-private question context retained by Action approval/replay, never an authored query authority. */
  discussionAddressing: z.optional(DiscussionAddressingV1Schema),
}).check(z.refine(value => !value.discussionAddressing || value.sourceInputId !== undefined
  && value.discussionAddressing.participantSessionId === value.sourceSessionId, {
  path: ['discussionAddressing'], message: 'Discussion context must belong to the exact admitted source Session input',
})));
export type SessionInputSourceSessionV1 = z.infer<typeof SessionInputSourceSessionV1Schema>;

export const SessionInputSourceAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}));
export type SessionInputSourceAuthorityV1 = z.infer<typeof SessionInputSourceAuthorityV1Schema>;

const SessionInputAutomationV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: BoundedAutomationIdSchema,
  runId: BoundedAutomationRunIdSchema,
}));

/** Exact human-selected destination; original accepted input retains the request identity. */
export const SessionInputHumanReplyOriginV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
}));
export type SessionInputHumanReplyOriginV1 = z.infer<typeof SessionInputHumanReplyOriginV1Schema>;

/** Host-owned intent; agent and human origins never impersonate each other. */
export const SessionInputReplyIntentV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['wait', 'return']),
  humanOrigin: z.optional(SessionInputHumanReplyOriginV1Schema),
}));
export type SessionInputReplyIntentV1 = z.infer<typeof SessionInputReplyIntentV1Schema>;

/** Original correlation and host-stamped sender; neither grants answer authority. */
export const SessionInputReturnedAnswerV1Schema = lazyZodSchema(() => z.strictObject({
  requestSessionId: asProtocolZod(SessionIdSchema),
  requestLocalId: PendingLocalIdSchema,
  outcome: z.enum(['answer', 'pass', 'failed', 'cancelled', 'terminal_no_result']),
  delivery: z.enum(['wake', 'next_turn']),
  /** Actual return publisher, supplied by the question/input owner even after its turn ends. */
  senderSessionId: z.optional(asProtocolZod(SessionIdSchema)),
  answeredBy: z.optional(SessionMessageProvenanceSchema),
  sourceMessageRef: z.optional(SessionMessageRefV1Schema),
}));
export type SessionInputReturnedAnswerV1 = z.infer<typeof SessionInputReturnedAnswerV1Schema>;

/** Protected origin only: display attribution must never select receiver policy. */
export function readSessionInputSenderSessionIdV1(request: SessionInputRequest | SessionInputAuthority): string | undefined {
  return request.sourceSession?.sourceSessionId
    ?? (request.v === 1 ? request.returnedAnswer?.senderSessionId ?? (request.followDeliveryV1
      && !isRunFollowOriginalV1(request.followDeliveryV1.original)
        ? request.followDeliveryV1.original.sourceSessionId : undefined) : undefined);
}

const SessionInputProtectedCommonV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  caller: z.optional(SessionInputCallerV1Schema),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  discussionAddressing: z.optional(DiscussionAddressingV1Schema),
  sourceAuthority: z.optional(SessionInputSourceAuthorityV1Schema),
  automation: z.optional(SessionInputAutomationV1Schema),
  replyIntent: z.optional(SessionInputReplyIntentV1Schema),
  returnedAnswer: z.optional(SessionInputReturnedAnswerV1Schema),
  followDeliveryV1: z.optional(SessionFollowInputV1Schema),
  /** Descriptive admitted cause, stamped only by the authenticated host. */
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
}));

function refineProtectedInputCommon(
  value: z.infer<typeof SessionInputProtectedCommonV1Schema>,
  context: z.core.$RefinementCtx,
): void {
  if (value.followDeliveryV1) {
    if (value.returnedAnswer || value.replyIntent && !value.discussionAddressing || value.sourceAuthority || value.automation
      || value.producer !== 'sessionAction'
      || value.sourceSession && (isRunFollowOriginalV1(value.followDeliveryV1.original)
        || value.sourceSession.sourceSessionId !== value.followDeliveryV1.original.sourceSessionId)) {
      context.addIssue({ code: 'custom', path: ['followDeliveryV1'], message: 'Follow input requires its exact original source and cannot request another effect' });
    }
  }
  if (value.discussionAddressing && (value.replyIntent?.mode !== 'return' || value.returnedAnswer
    || value.producer !== 'sessionAction' && value.producer !== 'happierMcp')) {
    context.addIssue({ code: 'custom', path: ['discussionAddressing'], message: 'Discussion addressing requires an original protected return obligation' });
  }
  if (value.replyIntent?.humanOrigin && (value.replyIntent.mode !== 'return'
    || value.sourceSession || value.discussionAddressing || value.caller?.kind !== 'host'
    || !['happierApp', 'voiceInput', 'cli'].includes(value.producer))) {
    context.addIssue({ code: 'custom', path: ['replyIntent', 'humanOrigin'], message: 'Human reply origin requires an admitted human input' });
  }
  if (value.replyIntent?.mode === 'return' && !value.sourceSession && !value.discussionAddressing && !value.replyIntent.humanOrigin) {
    context.addIssue({ code: 'custom', path: ['replyIntent'], message: 'Return intent requires an admitted causal Session' });
  }
  if (value.replyIntent && value.returnedAnswer) {
    context.addIssue({ code: 'custom', path: ['returnedAnswer'], message: 'Returned information cannot request another reply' });
  }
  if (value.sourceSession && value.returnedAnswer?.senderSessionId
    && value.sourceSession.sourceSessionId !== value.returnedAnswer.senderSessionId) {
    context.addIssue({ code: 'custom', path: ['returnedAnswer', 'senderSessionId'],
      message: 'Returned sender must match the protected source Session when both are present' });
  }
  const admissionMode = SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1[value.producer];
  if (admissionMode === 'transcriptOnly') {
    context.addIssue({
      code: 'custom',
      path: ['producer'],
      message: 'Transcript-only producers cannot carry protected input authority',
    });
  }
  if (value.producer === 'pluginSession' && value.caller?.kind !== 'plugin') {
    context.addIssue({
      code: 'custom',
      path: ['caller'],
      message: 'Plugin Session input requires a plugin caller',
    });
  }
  if (value.caller?.kind === 'plugin' && value.producer !== 'pluginSession') {
    context.addIssue({
      code: 'custom',
      path: ['producer'],
      message: 'Plugin callers may create only plugin Session input',
    });
  }
  const sourceAuthorityFromCausalSession = Boolean(
    value.sourceAuthority
    && value.sourceSession
    && (value.producer === 'sessionAction' || value.producer === 'happierMcp'),
  );
  if (value.sourceAuthority && value.caller?.kind !== 'plugin' && !sourceAuthorityFromCausalSession) {
    context.addIssue({
      code: 'custom',
      path: ['sourceAuthority'],
      message: 'Source authority requires a host-stamped plugin caller',
    });
  }
  if (value.sourceAuthority && value.caller?.kind === 'plugin'
    && value.sourceAuthority.mediatorPluginId !== value.caller.pluginId) {
    context.addIssue({
      code: 'custom',
      path: ['sourceAuthority', 'mediatorPluginId'],
      message: 'Source authority mediator must match the host-stamped plugin caller',
    });
  }
  if (value.sourceSession && value.producer !== 'sessionAction' && value.producer !== 'happierMcp') {
    context.addIssue({
      code: 'custom',
      path: ['sourceSession'],
      message: 'Source Session correlation is valid only for Session Action or Happier MCP input',
    });
  }
  if (value.automation && value.producer !== 'automation') {
    context.addIssue({
      code: 'custom',
      path: ['automation'],
      message: 'Automation identity is valid only for Automation input',
    });
  }
  if (value.producer === 'automation' && value.automation === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['automation'],
      message: 'Automation input requires exact Automation and Run identity',
    });
  }
}

export const SessionInputRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionInputProtectedCommonV1Schema, {
  permission: z.strictObject({
    requestedPermissionCeiling: zMini.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
  }),
})).check(z.superRefine(refineProtectedInputCommon)));
export type SessionInputRequestV1 = z.infer<typeof SessionInputRequestV1Schema>;

export const SessionInputWorkflowV2Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  z.strictObject({
    purpose: z.literal('invocation'),
    runId: BoundedAutomationRunIdSchema,
    invocationRecordId: WorkflowInvocationRecordIdSchema,
    workDepth: zMini.optional(SessionWorkDepthV1Schema),
    stepOrdinal: z.optional(WorkflowStepOrdinalV1Schema),
  }),
]));
export type SessionInputWorkflowV2 = z.infer<typeof SessionInputWorkflowV2Schema>;

/** Durable Pending identity for an exact Workflow invocation. */
export function deriveWorkflowSessionInputLocalIdV2(workflow: SessionInputWorkflowV2): string {
  const parsed = SessionInputWorkflowV2Schema.parse(workflow);
  const canonicalIdentity = JSON.stringify([
    WORKFLOW_SESSION_INPUT_LOCAL_ID_DOMAIN_V2,
    2,
    parsed.purpose,
    parsed.runId,
    parsed.invocationRecordId,
  ]);
  const localId = readPendingLocalId(
    `workflow-input-v2:${encodeBase64(sha256(UTF8_ENCODER.encode(canonicalIdentity)), 'base64url')}`,
  );
  if (localId === null) throw new Error('Derived Workflow Session input local id is invalid');
  return localId;
}

const SessionInputProtectedCommonV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  producer: z.literal('workflow'),
  caller: z.optional(SessionInputCallerV1Schema),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  sourceAuthority: z.optional(SessionInputSourceAuthorityV1Schema),
  replyIntent: z.optional(SessionInputReplyIntentV1Schema),
  discussionAddressing: z.optional(DiscussionAddressingV1Schema),
  workflow: SessionInputWorkflowV2Schema,
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
}));

function refineProtectedWorkflowInputCommon(
  value: z.infer<typeof SessionInputProtectedCommonV2Schema>,
  context: z.core.$RefinementCtx,
): void {
  if (value.caller?.kind === 'plugin') {
    context.addIssue({ code: 'custom', path: ['caller'], message: 'Workflow input is emitted only by the trusted host' });
  }
  if (value.replyIntent?.humanOrigin || value.replyIntent?.mode === 'return' && !value.sourceSession) {
    context.addIssue({ code: 'custom', path: ['replyIntent'], message: 'Workflow returns require an admitted causal Session' });
  }
  if (value.discussionAddressing && value.replyIntent?.mode !== 'wait') {
    context.addIssue({ code: 'custom', path: ['discussionAddressing'], message: 'Workflow Discussion publication observes the original invocation result' });
  }
}

export const SessionInputRequestV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionInputProtectedCommonV2Schema, {
  permission: z.strictObject({
    requestedPermissionCeiling: zMini.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
  }),
})).check(z.superRefine(refineProtectedWorkflowInputCommon)));
export type SessionInputRequestV2 = z.infer<typeof SessionInputRequestV2Schema>;
export const SessionInputRequestSchema = lazyZodSchema(() => z.union([SessionInputRequestV1Schema, SessionInputRequestV2Schema]));
export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

export const SessionInputAuthorityV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionInputProtectedCommonV2Schema, {
  permission: z.strictObject({
    requestedPermissionCeiling: zMini.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
    admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  }),
})).check(z.superRefine(refineProtectedWorkflowInputCommon)));
export type SessionInputAuthorityV2 = z.infer<typeof SessionInputAuthorityV2Schema>;

export const SESSION_INPUT_ADMISSION_WORKFLOW_PROTOCOL_VERSION = 2 as const;

/**
 * Sole builder for trusted host Pending admission. It stamps modality/source,
 * never Account relationship; authenticated target settlement owns that fact.
 */
export function buildTrustedHostSessionInputAdmissionV1(
  surface: keyof ActionSurfaces | null | undefined,
): Readonly<{
  provenance: SessionMessageProvenanceV1;
  request: SessionInputRequestV1;
}> {
  const producer = surface === 'ui'
    ? 'happierApp' as const
    : surface === 'cli'
      ? 'cli' as const
      : surface === 'voice'
        ? 'voiceInput' as const
        : surface === 'mcp'
          ? 'happierMcp' as const
          : 'sessionAction' as const;
  const provenance = surface === 'cli'
    ? { v: 1 as const, kind: 'cli' as const }
    : surface === 'voice'
      ? { v: 1 as const, kind: 'voice' as const }
      : { v: 1 as const, kind: 'host' as const, producer };
  return Object.freeze({
    provenance: SessionMessageProvenanceV1Schema.parse(provenance),
    request: SessionInputRequestV1Schema.parse({
      v: 1,
      producer,
      caller: { kind: 'host' },
      permission: {},
    }),
  });
}

export const SessionInputAuthorityV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionInputProtectedCommonV1Schema, {
  permission: z.strictObject({
    requestedPermissionCeiling: zMini.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
    admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  }),
})).check(z.superRefine(refineProtectedInputCommon)));
export type SessionInputAuthorityV1 = z.infer<typeof SessionInputAuthorityV1Schema>;
// Historical authority sealed into transcript content uses the same retained
// Follow delivery shape as the server receipt, without relaxing fresh input.
defineStoredReadProjection(SessionInputAuthorityV1Schema, () => createStoredReadSchema(z.safeExtend(
  SessionInputAuthorityV1Schema,
  { followDeliveryV1: z.optional(SessionFollowReceiptDeliveryV1Schema) },
)));
export const SessionInputAuthoritySchema = lazyZodSchema(() => z.union([SessionInputAuthorityV1Schema, SessionInputAuthorityV2Schema]));
export type SessionInputAuthority = z.infer<typeof SessionInputAuthoritySchema>;

/**
 * Machine authentication is required only when the request asserts a fact the
 * Account route cannot derive from its authenticated Account relationship.
 * Keeping this classification beside the request schema prevents client and
 * settlement paths from silently drifting apart.
 */
export function requiresAuthenticatedMachineAdmissionForSessionInputV1(
  request: SessionInputRequestV1,
): boolean {
  const parsed = SessionInputRequestV1Schema.parse(request);
  return parsed.producer === 'pluginSession'
    || parsed.producer === 'automation'
    || parsed.caller?.kind === 'plugin'
    || parsed.sourceSession !== undefined
    || parsed.sourceAuthority !== undefined
    || parsed.automation !== undefined
    || parsed.replyIntent?.mode === 'return' && parsed.replyIntent.humanOrigin === undefined
    || parsed.returnedAnswer !== undefined
    || parsed.discussionAddressing !== undefined
    || parsed.actionRequestAttributionV1 !== undefined;
}

export function requiresAuthenticatedMachineAdmissionForSessionInput(
  request: SessionInputRequest,
): boolean {
  const parsed = SessionInputRequestSchema.parse(request);
  return parsed.v === 2 || requiresAuthenticatedMachineAdmissionForSessionInputV1(parsed);
}

/**
 * Validates the server-issued admission fact before a target can turn a
 * protected request into immutable authority. Account routes may admit human
 * input, but cannot assert plugin, source-session, source-authority, or
 * Automation provenance that is reserved for authenticated machine admission.
 */
export function assertSessionInputAdmissionReceiptForRequestV1(params: Readonly<{
  request: SessionInputRequestV1;
  inputAdmissionReceipt: unknown;
}>): SessionInputAdmissionReceiptV1 {
  const receipt = SessionInputAdmissionReceiptV1Schema.parse(params.inputAdmissionReceipt);
  if (
    receipt.issuer === 'authenticatedAccount'
    && requiresAuthenticatedMachineAdmissionForSessionInputV1(params.request)
  ) {
    throw new TypeError('Account admission receipts cannot attest plugin, source, or Automation input');
  }
  assertFollowInputReceipt(params.request, receipt);
  assertDiscussionInputReceipt(params.request, receipt);
  return receipt;
}

export function assertSessionInputAdmissionReceiptForRequest(params: Readonly<{
  request: SessionInputRequest;
  inputAdmissionReceipt: unknown;
}>): SessionInputAdmissionReceiptV1 {
  const request = SessionInputRequestSchema.parse(params.request);
  const receipt = SessionInputAdmissionReceiptV1Schema.parse(params.inputAdmissionReceipt);
  if (receipt.issuer === 'authenticatedAccount' && requiresAuthenticatedMachineAdmissionForSessionInput(request)) {
    throw new TypeError('Account admission receipts cannot attest protected Workflow input');
  }
  if (request.v === 1) assertFollowInputReceipt(request, receipt);
  assertDiscussionInputReceipt(request, receipt);
  return receipt;
}

function assertFollowInputReceipt(request: SessionInputRequestV1, receipt: SessionInputAdmissionReceiptV1): void {
  const requested = request.followDeliveryV1;
  const admitted = receipt.followSources;
  if (!requested && !admitted && !receipt.followDeliveryV1) return;
  const admittedTarget = receipt.admittedTarget;
  if (!requested || !receipt.followDeliveryV1 || !admittedTarget
    || receipt.issuer === 'authenticatedAccount' && (receipt.actorAccountId !== admittedTarget.accountId || receipt.sessionRelationship !== 'owner')
    || serializeCanonicalJsonForSessionMutationEqualityV1(requested) !== serializeCanonicalJsonForSessionMutationEqualityV1(receipt.followDeliveryV1)
    || admitted?.some(source => source.destinationSessionId !== admittedTarget.sessionId
      || serializeCanonicalJsonForSessionMutationEqualityV1({ sourceSessionId: source.sourceSessionId,
        ...(source.sourceMessage ? { sourceMessage: source.sourceMessage }
          : 'sourceTurn' in source ? { sourceTurn: source.sourceTurn } : { sourceRequests: source.sourceRequests }) })
        !== serializeCanonicalJsonForSessionMutationEqualityV1(requested.original))) {
    throw new TypeError('Follow input requires its exact authenticated original occurrence receipt');
  }
}

function assertDiscussionInputReceipt(request: SessionInputRequest, receipt: SessionInputAdmissionReceiptV1): void {
  const admitted = receipt.issuer === 'authenticatedMachine' ? receipt.discussionAddressing : undefined;
  if (!request.discussionAddressing && !admitted) return;
  if (!request.discussionAddressing || !admitted || receipt.issuer !== 'authenticatedMachine'
    || receipt.admittedTarget?.sessionId !== admitted.participantSessionId
    || serializeCanonicalJsonForSessionMutationEqualityV1(request.discussionAddressing)
      !== serializeCanonicalJsonForSessionMutationEqualityV1(admitted)) {
    throw new TypeError('Discussion input requires its exact authenticated question and receiver receipt');
  }
}

/** Validates the minimal receipt against already-settled immutable authority. */
export function assertSessionInputAdmissionReceiptForAuthorityV1(params: Readonly<{
  authority: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionInputAdmissionReceiptV1 {
  const authority = SessionInputAuthoritySchema.parse(params.authority);
  const { admittedPermissionCeiling: _admittedPermissionCeiling, ...requestPermission } = authority.permission;
  return assertSessionInputAdmissionReceiptForRequest({
    request: SessionInputRequestSchema.parse({
      ...authority,
      permission: requestPermission,
    }),
    inputAdmissionReceipt: params.inputAdmissionReceipt,
  });
}

/**
 * Sole pure request -> immutable authority reconciliation. Callers must supply
 * the current target Session policy; the protected request can only narrow it.
 */
export function settleSessionInputRequestV1(params: Readonly<{
  request: SessionInputRequestV1;
  currentSessionPermissionCeiling: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionInputAuthorityV1 {
  const request = SessionInputRequestV1Schema.parse(params.request);
  const current = AgentPermissionIntentV1Schema.parse(params.currentSessionPermissionCeiling);
  assertSessionInputAdmissionReceiptForRequestV1({
    request,
    inputAdmissionReceipt: params.inputAdmissionReceipt,
  });
  if (SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1[request.producer] === 'transcriptOnly') {
    throw new TypeError(`Cannot settle transcript-only producer ${request.producer}`);
  }
  const effective = resolveEffectivePermissionMode({
    currentMode: current,
    admittedPermissionCeiling: request.permission.requestedPermissionCeiling ?? current,
    supportedModes: ['read-only', 'plan', 'default', 'safe-yolo', 'yolo'],
  });
  if (!effective.ok) {
    throw new TypeError(`Cannot settle Session input permission: ${effective.reason}`);
  }
  return SessionInputAuthorityV1Schema.parse({
    ...request,
    permission: {
      ...(request.permission.requestedPermissionCeiling
        ? { requestedPermissionCeiling: request.permission.requestedPermissionCeiling }
        : {}),
      admittedPermissionCeiling: effective.effectiveMode,
    },
  });
}

export function settleSessionInputRequestV2(params: Readonly<{
  request: SessionInputRequestV2;
  currentSessionPermissionCeiling: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionInputAuthorityV2 {
  const request = SessionInputRequestV2Schema.parse(params.request);
  const current = AgentPermissionIntentV1Schema.parse(params.currentSessionPermissionCeiling);
  assertSessionInputAdmissionReceiptForRequest({ request, inputAdmissionReceipt: params.inputAdmissionReceipt });
  const requested = request.permission.requestedPermissionCeiling ?? current;
  const dominance = assertNonEscalatingPermissionMode({
    requestedMode: requested,
    callerMode: current,
    supportedModes: ['read-only', 'plan', 'default', 'safe-yolo', 'yolo'],
  });
  if (!dominance.ok) throw new TypeError(`Cannot settle Session input permission: ${dominance.reason}`);
  return SessionInputAuthorityV2Schema.parse({
    ...request,
    permission: {
      ...(request.permission.requestedPermissionCeiling ? { requestedPermissionCeiling: request.permission.requestedPermissionCeiling } : {}),
      admittedPermissionCeiling: requested,
    },
  });
}

const AccountIdSchema = preservedBoundedNfcString(191, 'Account ids');

/** Server-stamped input placement, not author-supplied execution authority. */
export const SessionInputMachineTargetV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: z.string().check(z.minLength(1)),
  accountId: AccountIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  machineId: z.string().check(z.minLength(1)),
  installationId: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionInputMachineTargetV1 = z.infer<typeof SessionInputMachineTargetV1Schema>;

/** Lossy non-content notification; the retained receipt remains the recovery authority. */
export const PendingActivationRequestedEphemeralV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('pending-activation-requested'),
  target: SessionInputMachineTargetV1Schema,
  requestId: z.string().check(z.trim(), z.minLength(1)),
  requestedAt: z.number().check(z.int(), z.nonnegative()),
  pendingVersion: z.number().check(z.int(), z.nonnegative()),
}));
export type PendingActivationRequestedEphemeralV1 = z.infer<typeof PendingActivationRequestedEphemeralV1Schema>;

/** Server-admitted Follow custody, never authored into the public input body. */
export const SESSION_FOLLOW_INPUT_ADMISSION_FIELDS_V1 = {
  followSources: z.optional(z.lazy(() => SessionFollowSourceOccurrenceWitnessesV1Schema)),
  followRelations: z.optional(z.lazy(() => SessionFollowRelationWitnessesV1Schema)),
  followDeliveryV1: z.optional(z.lazy(() => SessionFollowInputV1Schema)),
};

/** Explicit quiet delivery intent, never inferred from display metadata. */
export const SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1 = {
  nextTurnNote: z.optional(NextTurnFileReviewNoteV1Schema),
};

const SESSION_FOLLOW_INPUT_RECEIPT_FIELDS_V1 = {
  ...SESSION_FOLLOW_INPUT_ADMISSION_FIELDS_V1,
  followDeliveryV1: z.optional(z.lazy(() => SessionFollowReceiptDeliveryV1Schema)),
};

export const SessionInputAdmissionReceiptV1Schema = lazyZodSchema(() => z.discriminatedUnion('issuer', [
  z.strictObject({
    v: z.literal(1),
    issuer: z.literal('authenticatedAccount'),
    ...SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1,
    ...SESSION_FOLLOW_INPUT_RECEIPT_FIELDS_V1,
    callerInputConstraints: zMini.optional(CallerInputConstraintsV1Schema),
    actorAccountId: AccountIdSchema,
    sessionRelationship: z.enum(['owner', 'sharedEditor', 'sharedAdmin']),
    admittedTarget: z.optional(SessionInputMachineTargetV1Schema),
  }),
  z.strictObject({
    v: z.literal(1),
    issuer: z.literal('authenticatedMachine'),
    ...SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1,
    ...SESSION_FOLLOW_INPUT_RECEIPT_FIELDS_V1,
    discussionAddressing: z.optional(DiscussionAddressingV1Schema),
    callerInputConstraints: zMini.optional(CallerInputConstraintsV1Schema),
    admittedTarget: z.optional(SessionInputMachineTargetV1Schema),
  }),
]));
export type SessionInputAdmissionReceiptV1 = z.infer<typeof SessionInputAdmissionReceiptV1Schema>;

function isRequestedProvenanceForSessionInputV1(
  request: SessionInputRequestV1,
  provenance: SessionMessageProvenanceV1,
): boolean {
  if (provenance.kind === 'host') return provenance.producer === request.producer;
  if (provenance.kind === 'cli') return request.producer === 'cli';
  if (provenance.kind === 'voice') return request.producer === 'voiceInput';
  if (provenance.kind === 'happierSession') {
    return request.sourceSession !== undefined
      && request.sourceSession.sourceSessionId === provenance.sourceSessionId
      && request.sourceSession.via === provenance.via;
  }
  if (provenance.kind === 'pluginSession') {
    return request.producer === 'pluginSession'
      && request.caller?.kind === 'plugin'
      && request.caller.pluginId === provenance.pluginId
      && request.caller.contributionLocalId === provenance.contributionLocalId;
  }
  if (provenance.kind === 'automation') {
    return request.producer === 'automation'
      && request.automation?.automationId === provenance.automationId
      && request.automation.runId === provenance.runId;
  }
  return false;
}

/**
 * Reconciles descriptive provenance beside protected authority. Only an
 * authenticated Account receipt may decide owner versus collaborator.
 */
export function settleSessionMessageProvenanceV1(params: Readonly<{
  request: SessionInputRequestV1;
  requestedProvenance: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionMessageProvenanceV1 {
  const request = SessionInputRequestV1Schema.parse(params.request);
  const inputAdmissionReceipt = assertSessionInputAdmissionReceiptForRequestV1({
    request,
    inputAdmissionReceipt: params.inputAdmissionReceipt,
  });
  if (request.producer === 'happierApp') {
    // Machine transport does not turn the original protected UI requester into
    // host prose. This describes the person, without asserting a relationship.
    const requester = request.actionRequestAttributionV1?.requester;
    return SessionMessageProvenanceV1Schema.parse(
      inputAdmissionReceipt.issuer === 'authenticatedAccount'
        ? {
            v: 1,
            kind: 'happierApp',
            actor: {
              kind: inputAdmissionReceipt.sessionRelationship === 'owner'
                ? 'owner'
                : 'sharedCollaborator',
            },
          }
        : requester && !request.returnedAnswer
          ? { v: 1, kind: 'happierApp', actor: { kind: 'person', accountId: requester.accountId } }
          : { v: 1, kind: 'host', producer: 'happierApp' },
    );
  }
  const requestedProvenance = SessionMessageProvenanceV1Schema.safeParse(params.requestedProvenance);
  return requestedProvenance.success
    && isRequestedProvenanceForSessionInputV1(request, requestedProvenance.data)
    ? requestedProvenance.data
    : SessionMessageProvenanceV1Schema.parse({ v: 1, kind: 'host', producer: request.producer });
}

export function settleSessionMessageProvenanceV2(params: Readonly<{
  request: SessionInputRequestV2;
  requestedProvenance: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionMessageProvenanceV2 {
  const request = SessionInputRequestV2Schema.parse(params.request);
  assertSessionInputAdmissionReceiptForRequest({
    request,
    inputAdmissionReceipt: params.inputAdmissionReceipt,
  });
  const provenance = SessionMessageProvenanceV2Schema.parse(params.requestedProvenance);
  const matches = provenance.kind === 'workflow_invocation'
    && provenance.runId === request.workflow.runId
    && provenance.invocationRecordId === request.workflow.invocationRecordId
    && provenance.workDepth === request.workflow.workDepth
    && provenance.stepOrdinal === request.workflow.stepOrdinal;
  if (!matches) {
    throw new TypeError('Workflow Session input provenance does not match the protected request');
  }
  return provenance;
}

export const SessionInputRequestEnvelopeDigestV1Schema = SessionMutationEqualityBase64UrlSha256V1Schema;
export type SessionInputRequestEnvelopeDigestV1 = z.infer<typeof SessionInputRequestEnvelopeDigestV1Schema>;

/**
 * Session input's arm of the shared Session-mutation equality evidence. The
 * name and persisted field stay source-compatible; the schema is the one
 * canonical owner rather than a second copy of the same closed union.
 */
export const SessionInputRequestEqualityEvidenceV1Schema = SessionMutationEqualityEvidenceV1Schema;
export type SessionInputRequestEqualityEvidenceV1 = z.infer<typeof SessionInputRequestEqualityEvidenceV1Schema>;

/** Initial Pending custody; receiver policy holds belong to later settlement. */
export const SessionInputEnqueueResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  }),
  z.strictObject({
    status: z.literal('alreadyAccepted'),
    localId: PendingLocalIdSchema,
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: SessionInputAdmissionRejectionCodeV1Schema,
  }),
  z.strictObject({
    status: z.literal('outcomeUnknown'),
    localId: PendingLocalIdSchema,
    code: preservedBoundedNfcString(128, 'Admission outcome codes'),
  }),
]));
export type SessionInputEnqueueResultV1 = z.infer<typeof SessionInputEnqueueResultV1Schema>;

export const SessionInputAdmissionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  SessionInputEnqueueResultV1Schema,
  z.strictObject({
    status: z.literal('held'),
    localId: PendingLocalIdSchema,
    code: z.enum(['autonomous_check_in', 'session_input_target_unavailable']),
  }),
]));
export type SessionInputAdmissionResultV1 = z.infer<typeof SessionInputAdmissionResultV1Schema>;

/**
 * Public result for `session.message.send`. Admission remains owned by the
 * canonical admission result above; these two additional arms describe a
 * proven terminal outcome when the caller asked to wait for one exact,
 * already-admitted Execution Run input.
 */
export const SessionMessageSendResultV1Schema = lazyZodSchema(() => z.union([
  SessionInputAdmissionResultV1Schema,
  z.strictObject({
    status: z.literal('replied'),
    localId: PendingLocalIdSchema,
    inputMessageRef: z.optional(SessionMessageRefV1Schema),
    outcome: SessionMessageReplyResolvedOutcomeV1Schema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    localId: PendingLocalIdSchema,
    code: z.literal('session_input_turn_failed'),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    localId: PendingLocalIdSchema,
    code: z.literal('session_input_turn_cancelled'),
  }),
]));
export type SessionMessageSendResultV1 = z.infer<typeof SessionMessageSendResultV1Schema>;

/** Complete Action outcome, including the front door's exact-target fanout. */
export const SessionMessageSendActionResultV1Schema = lazyZodSchema(() =>
  withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema));
export const SessionMessageSendResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SessionMessageSendActionResultV1Schema));

export const SessionPermissionSourceAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('mediatedExternal'),
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}));
export type SessionPermissionSourceAuthorityV1 = z.infer<
  typeof SessionPermissionSourceAuthorityV1Schema
>;

/**
 * Immutable input authority carried with one host-dispatched turn. Its explicit
 * arm separates admitted V1 input from pre-admission legacy/host execution.
 */
export const SessionInputCausalPermissionAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('admittedSessionInputV1'),
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  sourceAuthority: z.optional(SessionPermissionSourceAuthorityV1Schema),
}).check(z.superRefine((value, context) => {
  if (
    value.sourceAuthority
    && value.sourceAuthority.admittedPermissionCeiling !== value.admittedPermissionCeiling
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sourceAuthority', 'admittedPermissionCeiling'],
      message: 'Mediated source authority must carry the causal admitted permission ceiling',
    });
  }
})));
export type SessionInputCausalPermissionAuthorityV1 = z.infer<
  typeof SessionInputCausalPermissionAuthorityV1Schema
>;

/**
 * Materializes the narrow, host-owned causal stamp into an independent frozen
 * snapshot before it crosses a runtime ownership boundary. This deliberately
 * copies only the protocol authority shape, not arbitrary caller payload.
 */
export function materializeSessionInputCausalPermissionAuthorityV1(
  value: unknown,
): SessionInputCausalPermissionAuthorityV1 | null {
  const parsed = SessionInputCausalPermissionAuthorityV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const sourceAuthority = parsed.data.sourceAuthority;
  return Object.freeze({
    kind: 'admittedSessionInputV1',
    admittedPermissionCeiling: parsed.data.admittedPermissionCeiling,
    ...(sourceAuthority
      ? {
          sourceAuthority: Object.freeze({
            kind: 'mediatedExternal' as const,
            mediatorPluginId: sourceAuthority.mediatorPluginId,
            sourceRef: sourceAuthority.sourceRef,
            sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
            admittedPermissionCeiling:
              sourceAuthority.admittedPermissionCeiling,
            remoteApprovalMaxScope: sourceAuthority.remoteApprovalMaxScope,
          }),
        }
      : {}),
  });
}

function readMetaRecord(meta: unknown): Record<string, unknown> | null {
  return isRecord(meta) ? meta : null;
}

export function readSessionInputRequestV1(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionInputRequestV1 | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_AUTHORITY_META_KEY)) return null;
  const parsed = (mode === 'stored' ? createStoredReadSchema(SessionInputRequestV1Schema) : SessionInputRequestV1Schema).safeParse(record[SESSION_INPUT_REQUEST_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputRequest(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionInputRequest | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_AUTHORITY_META_KEY)) return null;
  const parsed = (mode === 'stored' ? createStoredReadSchema(SessionInputRequestSchema) : SessionInputRequestSchema).safeParse(record[SESSION_INPUT_REQUEST_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputAuthorityV1(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionInputAuthorityV1 | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_REQUEST_META_KEY)) return null;
  const parsed = (mode === 'stored' ? createStoredReadSchema(SessionInputAuthorityV1Schema) : SessionInputAuthorityV1Schema).safeParse(record[SESSION_INPUT_AUTHORITY_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputAuthority(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionInputAuthority | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_REQUEST_META_KEY)) return null;
  const parsed = (mode === 'stored' ? createStoredReadSchema(SessionInputAuthoritySchema) : SessionInputAuthoritySchema).safeParse(record[SESSION_INPUT_AUTHORITY_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionMessageProvenanceV1(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionMessageProvenanceV1 | null {
  const record = readMetaRecord(meta);
  if (!record) return null;

  if (Object.hasOwn(record, SESSION_MESSAGE_PROVENANCE_META_KEY)) {
    const parsed = (mode === 'stored' ? createStoredReadSchema(SessionMessageProvenanceV1Schema) : SessionMessageProvenanceV1Schema).safeParse(record[SESSION_MESSAGE_PROVENANCE_META_KEY]);
    return parsed.success ? parsed.data : null;
  }

  const predecessorOrigin = readConversationTurnOriginV1FromMessageMeta(record, mode);
  if (!predecessorOrigin?.source) return null;
  const projected = SessionMessageProvenanceV1Schema.safeParse({
    v: 1,
    kind: 'pluginSession',
    pluginId: predecessorOrigin.source.pluginId,
    contributionLocalId: predecessorOrigin.source.contributionId,
    surface: 'unspecified',
  });
  return projected.success ? projected.data : null;
}

export function readSessionMessageProvenance(meta: unknown, mode: 'input' | 'stored' = 'input'): SessionMessageProvenance | null {
  const record = readMetaRecord(meta);
  if (!record) return null;
  if (!Object.hasOwn(record, SESSION_MESSAGE_PROVENANCE_META_KEY)) return readSessionMessageProvenanceV1(meta, mode);
  const parsed = (mode === 'stored' ? createStoredReadSchema(SessionMessageProvenanceSchema) : SessionMessageProvenanceSchema).safeParse(record[SESSION_MESSAGE_PROVENANCE_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionPermissionSourceAuthorityV1(
  meta: unknown,
  mode: 'input' | 'stored' = 'input',
): SessionPermissionSourceAuthorityV1 | null {
  const authority = readSessionInputAuthority(meta, mode);
  if (!authority?.sourceAuthority) return null;
  return {
    kind: 'mediatedExternal',
    mediatorPluginId: authority.sourceAuthority.mediatorPluginId,
    sourceRef: authority.sourceAuthority.sourceRef,
    sourceRevisionOrEpoch: authority.sourceAuthority.sourceRevisionOrEpoch,
    admittedPermissionCeiling: authority.permission.admittedPermissionCeiling,
    remoteApprovalMaxScope: authority.sourceAuthority.remoteApprovalMaxScope,
  };
}

export function readSessionInputCausalPermissionAuthorityV1(
  meta: unknown,
  mode: 'input' | 'stored' = 'input',
): SessionInputCausalPermissionAuthorityV1 | null {
  const authority = readSessionInputAuthority(meta, mode);
  if (!authority) return null;
  const sourceAuthority = readSessionPermissionSourceAuthorityV1(meta, mode);
  const parsed = SessionInputCausalPermissionAuthorityV1Schema.safeParse({
    kind: 'admittedSessionInputV1',
    admittedPermissionCeiling: authority.permission.admittedPermissionCeiling,
    ...(sourceAuthority ? { sourceAuthority } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Removes protected lifecycle records before caller-controlled message metadata
 * is merged. Only the canonical admission/settlement owner may add them back.
 */
export function stripSessionInputProtectedMeta(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(meta ?? {}) };
  delete next[SESSION_INPUT_REQUEST_META_KEY];
  delete next[SESSION_INPUT_AUTHORITY_META_KEY];
  return next;
}

export function withSessionInputRequestV1(
  meta: Record<string, unknown> | null | undefined,
  request: SessionInputRequestV1,
): Record<string, unknown> {
  return {
    ...stripSessionInputProtectedMeta(meta),
    [SESSION_INPUT_REQUEST_META_KEY]: SessionInputRequestV1Schema.parse(request),
  };
}

export function withSessionInputRequest(
  meta: Record<string, unknown> | null | undefined,
  request: SessionInputRequest,
): Record<string, unknown> {
  return {
    ...stripSessionInputProtectedMeta(meta),
    [SESSION_INPUT_REQUEST_META_KEY]: SessionInputRequestSchema.parse(request),
  };
}

export function withSessionInputAuthorityV1(
  meta: Record<string, unknown> | null | undefined,
  authority: SessionInputAuthorityV1,
): Record<string, unknown> {
  return {
    ...stripSessionInputProtectedMeta(meta),
    [SESSION_INPUT_AUTHORITY_META_KEY]: SessionInputAuthorityV1Schema.parse(authority),
  };
}

export function withSessionInputAuthority(
  meta: Record<string, unknown> | null | undefined,
  authority: SessionInputAuthority,
): Record<string, unknown> {
  return {
    ...stripSessionInputProtectedMeta(meta),
    [SESSION_INPUT_AUTHORITY_META_KEY]: SessionInputAuthoritySchema.parse(authority),
  };
}
