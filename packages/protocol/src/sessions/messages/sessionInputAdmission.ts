import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { CallerInputConstraintsV1Schema } from '../../auth/callerInputConstraintsV1.js';
import { sha256 } from '@noble/hashes/sha2';

import {
  assertNonEscalatingPermissionMode,
  resolveEffectivePermissionMode,
} from '../../actions/permissionPrivilege.js';
import type { ActionSurfaces } from '../../actions/metadata.js';
import { encodeBase64 } from '../../crypto/base64.js';
import { readConversationTurnOriginV1FromMessageMeta } from '../../messages/structured/conversationTurnOriginV1.js';
import { SubagentLaunchV1Schema } from '../../messages/structured/subagentLaunchV1.js';
import { ParticipantRecipientRoutingIdentityV1Schema } from '../../messages/structured/participantMessageV1.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { SessionWorkDepthV1Schema } from '../creation/sessionCreateOriginV1.js';
import {
  SessionMutationEqualityBase64UrlSha256V1Schema,
  SessionMutationEqualityEvidenceV1Schema,
  serializeCanonicalJsonForSessionMutationEqualityV1,
} from '../mutations/sessionMutationEqualityV1.js';
import { PendingLocalIdSchema, readPendingLocalId } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema, type PendingRequestedActionV1 } from '../pending/pendingRequestedActionV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { preservedBoundedNfcString } from '../../strings/preservedBoundedNfcString.js';
import { WorkflowInvocationRecordIdSchema } from '../../workflows/workflowIdsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from './sessionInputAuthoringV1.js';
import { SessionInputAdmissionRejectionCodeV1Schema } from './sessionInputAdmissionRejectionV1.js';
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
  return serializeCanonicalJsonForSessionMutationEqualityV1({
    v: 1,
    requestEnvelope: params.requestEnvelope,
    requestedAction,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DisplayNameSnapshotSchema = lazyZodSchema(() => z.string()
  .refine((value) => value === value.normalize('NFC'), 'Display-name snapshots must be NFC-normalized')
  .refine((value) => Array.from(value).length <= 128, 'Display-name snapshots must contain at most 128 Unicode code points'));

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

export const ExternalActorV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['human', 'bot']),
  displayNameSnapshot: DisplayNameSnapshotSchema.optional(),
}).strict());
export type ExternalActorV1 = z.infer<typeof ExternalActorV1Schema>;

export const ContentProvenanceV1Schema = lazyZodSchema(() => z.enum(['original', 'forwarded', 'viaBot']));
export type ContentProvenanceV1 = z.infer<typeof ContentProvenanceV1Schema>;

function requireCoPresentExternalProvenance(
  value: Readonly<{
    externalActor?: unknown;
    contentProvenance?: unknown;
  }>,
  context: z.RefinementCtx,
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

export const PluginSessionInputSourceV1Schema = lazyZodSchema(() => z.object({
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
  requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  externalActor: ExternalActorV1Schema.optional(),
  contentProvenance: ContentProvenanceV1Schema.optional(),
}).strict().superRefine(requireCoPresentExternalProvenance));
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
  recipient: ParticipantRecipientRoutingIdentityV1Schema.optional(),
  source: PluginSessionInputSourceV1Schema.optional(),
  attachments: PluginSessionInputAttachmentsV1Schema.optional(),
  /** Identifies a provider-facing reply whose visible answer belongs on its question tool. */
  toolAnswerDelivery: z.object({ toolCallId: z.string().trim().min(1) }).strict().optional(),
});

/** Public plugin-authored intent. Caller identity and admitted authority are host-owned. */
const PluginSessionUserTextInputRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('userText'),
  /**
   * Blank only when an attachment carries the input. `requireSessionInputContent`
   * is the single gate; a `.min(1)` here would restore the divergence.
   */
  text: z.string(),
  ...PluginSessionUserTextAuthoredFieldSchemasV1,
}).strict().superRefine(requireSessionInputContent));

const PluginSessionSubagentLaunchInputRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}).strict());

export const PluginSessionInputRequestV1Schema = lazyZodSchema(() => z.union([
  PluginSessionUserTextInputRequestV1Schema,
  PluginSessionSubagentLaunchInputRequestV1Schema,
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

const HappierAppProvenanceSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('happierApp'),
  actor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner') }).strict(),
    z.object({ kind: z.literal('sharedCollaborator') }).strict(),
  ]),
}).strict());

const PluginSessionProvenanceSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('pluginSession'),
  pluginId: asProtocolZod(PluginIdSchema),
  contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  surface: z.union([PluginInvocationSurfaceV1Schema, z.literal('unspecified')]),
  sourceRef: SourceRefSchema.optional(),
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema.optional(),
  externalActor: ExternalActorV1Schema.optional(),
  contentProvenance: ContentProvenanceV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.sourceRef === undefined) !== (value.sourceRevisionOrEpoch === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceRef'],
      message: 'Plugin Session provenance requires sourceRef and sourceRevisionOrEpoch together',
    });
  }
  requireCoPresentExternalProvenance(value, context);
}));

const MessageProvenanceUnionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  HappierAppProvenanceSchema,
  z.object({ v: z.literal(1), kind: z.literal('cli') }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('voice') }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('happierSession'),
    sourceSessionId: asProtocolZod(SessionIdSchema),
    via: z.enum(['action', 'mcp']),
    callerDepth: SessionWorkDepthV1Schema.optional(),
  }).strict(),
  PluginSessionProvenanceSchema,
  z.object({
    v: z.literal(1),
    kind: z.literal('automation'),
    automationId: BoundedAutomationIdSchema,
    runId: BoundedAutomationRunIdSchema,
  }).strict(),
  z.object({
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
  }).strict(),
]));

export const SessionMessageProvenanceV1Schema = lazyZodSchema(() => MessageProvenanceUnionSchema.superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PROVENANCE_BYTES) {
    context.addIssue({
      code: 'custom',
      message: 'Session message provenance exceeds its encoded 4 KiB limit',
    });
  }
}));
export type SessionMessageProvenanceV1 = z.infer<typeof SessionMessageProvenanceV1Schema>;

/**
 * The step's visible number, stamped by the host that runs it from `workflowBlockOrdinalV1` (the same
 * owner the step's heading, map node and Session title read). A transcript shows it as written; it
 * never recomputes a number it has no definition for.
 */
const WorkflowStepOrdinalV1Schema = z.string().regex(/^[1-9][0-9]*$/u);

export const SessionMessageProvenanceV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(2), kind: z.literal('workflow_invocation'),
    runId: BoundedAutomationRunIdSchema,
    invocationRecordId: WorkflowInvocationRecordIdSchema,
    workDepth: SessionWorkDepthV1Schema.optional(),
    stepOrdinal: WorkflowStepOrdinalV1Schema.optional(),
  }).strict(),
]).superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PROVENANCE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Session message provenance exceeds its encoded 4 KiB limit' });
  }
}));
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
  z.object({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  z.object({ kind: z.literal('host') }).strict(),
]));

export const SessionInputSourceSessionV1Schema = lazyZodSchema(() => z.object({
  sourceSessionId: asProtocolZod(SessionIdSchema),
  sourceTurnId: TurnIdSchema,
  via: z.enum(['action', 'mcp']),
}).strict());
export type SessionInputSourceSessionV1 = z.infer<typeof SessionInputSourceSessionV1Schema>;

export const SessionInputSourceAuthorityV1Schema = lazyZodSchema(() => z.object({
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}).strict());
export type SessionInputSourceAuthorityV1 = z.infer<typeof SessionInputSourceAuthorityV1Schema>;

const SessionInputAutomationV1Schema = lazyZodSchema(() => z.object({
  automationId: BoundedAutomationIdSchema,
  runId: BoundedAutomationRunIdSchema,
}).strict());

const SessionInputProtectedCommonV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  caller: SessionInputCallerV1Schema.optional(),
  sourceSession: SessionInputSourceSessionV1Schema.optional(),
  sourceAuthority: SessionInputSourceAuthorityV1Schema.optional(),
  automation: SessionInputAutomationV1Schema.optional(),
}).strict());

function refineProtectedInputCommon(
  value: z.infer<typeof SessionInputProtectedCommonV1Schema>,
  context: z.RefinementCtx,
): void {
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

export const SessionInputRequestV1Schema = lazyZodSchema(() => SessionInputProtectedCommonV1Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
  }).strict(),
}).strict().superRefine(refineProtectedInputCommon));
export type SessionInputRequestV1 = z.infer<typeof SessionInputRequestV1Schema>;

export const SessionInputWorkflowV2Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('invocation'),
    runId: BoundedAutomationRunIdSchema,
    invocationRecordId: WorkflowInvocationRecordIdSchema,
    workDepth: SessionWorkDepthV1Schema.optional(),
    stepOrdinal: WorkflowStepOrdinalV1Schema.optional(),
  }).strict(),
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

const SessionInputProtectedCommonV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  producer: z.literal('workflow'),
  caller: SessionInputCallerV1Schema.optional(),
  sourceSession: SessionInputSourceSessionV1Schema.optional(),
  sourceAuthority: SessionInputSourceAuthorityV1Schema.optional(),
  workflow: SessionInputWorkflowV2Schema,
}).strict());

function refineProtectedWorkflowInputCommon(
  value: z.infer<typeof SessionInputProtectedCommonV2Schema>,
  context: z.RefinementCtx,
): void {
  if (value.caller?.kind === 'plugin') {
    context.addIssue({ code: 'custom', path: ['caller'], message: 'Workflow input is emitted only by the trusted host' });
  }
}

export const SessionInputRequestV2Schema = lazyZodSchema(() => SessionInputProtectedCommonV2Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
  }).strict(),
}).strict().superRefine(refineProtectedWorkflowInputCommon));
export type SessionInputRequestV2 = z.infer<typeof SessionInputRequestV2Schema>;
export const SessionInputRequestSchema = lazyZodSchema(() => z.union([SessionInputRequestV1Schema, SessionInputRequestV2Schema]));
export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

export const SessionInputAuthorityV2Schema = lazyZodSchema(() => SessionInputProtectedCommonV2Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
    admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  }).strict(),
}).strict().superRefine(refineProtectedWorkflowInputCommon));
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

export const SessionInputAuthorityV1Schema = lazyZodSchema(() => SessionInputProtectedCommonV1Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
    admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  }).strict(),
}).strict().superRefine(refineProtectedInputCommon));
export type SessionInputAuthorityV1 = z.infer<typeof SessionInputAuthorityV1Schema>;
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
    || parsed.automation !== undefined;
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
  return receipt;
}

/** Validates the minimal receipt against already-settled immutable authority. */
export function assertSessionInputAdmissionReceiptForAuthorityV1(params: Readonly<{
  authority: unknown;
  inputAdmissionReceipt: unknown;
}>): SessionInputAdmissionReceiptV1 {
  const authority = SessionInputAuthorityV1Schema.parse(params.authority);
  const { admittedPermissionCeiling: _admittedPermissionCeiling, ...requestPermission } = authority.permission;
  return assertSessionInputAdmissionReceiptForRequestV1({
    request: SessionInputRequestV1Schema.parse({
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
export const SessionInputMachineTargetV1Schema = lazyZodSchema(() => z.object({
  homeId: z.string().min(1),
  accountId: AccountIdSchema,
  sessionId: asProtocolZod(SessionIdSchema),
  machineId: z.string().min(1),
  installationId: z.string().trim().min(1),
}).strict());
export type SessionInputMachineTargetV1 = z.infer<typeof SessionInputMachineTargetV1Schema>;

/** Lossy non-content notification; the retained receipt remains the recovery authority. */
export const PendingActivationRequestedEphemeralV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('pending-activation-requested'),
  target: SessionInputMachineTargetV1Schema,
  requestId: z.string().trim().min(1),
  requestedAt: z.number().int().nonnegative(),
  pendingVersion: z.number().int().nonnegative(),
}).strict());
export type PendingActivationRequestedEphemeralV1 = z.infer<typeof PendingActivationRequestedEphemeralV1Schema>;

export const SessionInputAdmissionReceiptV1Schema = lazyZodSchema(() => z.discriminatedUnion('issuer', [
  z.object({
    v: z.literal(1),
    issuer: z.literal('authenticatedAccount'),
    callerInputConstraints: CallerInputConstraintsV1Schema.optional(),
    actorAccountId: AccountIdSchema,
    sessionRelationship: z.enum(['owner', 'sharedEditor', 'sharedAdmin']),
    admittedTarget: SessionInputMachineTargetV1Schema.optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    issuer: z.literal('authenticatedMachine'),
    callerInputConstraints: CallerInputConstraintsV1Schema.optional(),
    admittedTarget: SessionInputMachineTargetV1Schema.optional(),
  }).strict(),
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

export const SessionInputAdmissionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('alreadyAccepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: SessionInputAdmissionRejectionCodeV1Schema,
  }).strict(),
  z.object({
    status: z.literal('outcomeUnknown'),
    localId: PendingLocalIdSchema,
    code: preservedBoundedNfcString(128, 'Admission outcome codes'),
  }).strict(),
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
  z.object({
    status: z.literal('failed'),
    localId: PendingLocalIdSchema,
    code: z.literal('session_input_turn_failed'),
  }).strict(),
  z.object({
    status: z.literal('cancelled'),
    localId: PendingLocalIdSchema,
    code: z.literal('session_input_turn_cancelled'),
  }).strict(),
]));
export type SessionMessageSendResultV1 = z.infer<typeof SessionMessageSendResultV1Schema>;

export const SessionPermissionSourceAuthorityV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('mediatedExternal'),
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}).strict());
export type SessionPermissionSourceAuthorityV1 = z.infer<
  typeof SessionPermissionSourceAuthorityV1Schema
>;

/**
 * Immutable input authority carried with one host-dispatched turn. Its explicit
 * arm separates admitted V1 input from pre-admission legacy/host execution.
 */
export const SessionInputCausalPermissionAuthorityV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('admittedSessionInputV1'),
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  sourceAuthority: SessionPermissionSourceAuthorityV1Schema.optional(),
}).strict().superRefine((value, context) => {
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
}));
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

export function readSessionInputRequestV1(meta: unknown): SessionInputRequestV1 | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_AUTHORITY_META_KEY)) return null;
  const parsed = SessionInputRequestV1Schema.safeParse(record[SESSION_INPUT_REQUEST_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputRequest(meta: unknown): SessionInputRequest | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_AUTHORITY_META_KEY)) return null;
  const parsed = SessionInputRequestSchema.safeParse(record[SESSION_INPUT_REQUEST_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputAuthorityV1(meta: unknown): SessionInputAuthorityV1 | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_REQUEST_META_KEY)) return null;
  const parsed = SessionInputAuthorityV1Schema.safeParse(record[SESSION_INPUT_AUTHORITY_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionInputAuthority(meta: unknown): SessionInputAuthority | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_REQUEST_META_KEY)) return null;
  const parsed = SessionInputAuthoritySchema.safeParse(record[SESSION_INPUT_AUTHORITY_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionMessageProvenanceV1(meta: unknown): SessionMessageProvenanceV1 | null {
  const record = readMetaRecord(meta);
  if (!record) return null;

  if (Object.hasOwn(record, SESSION_MESSAGE_PROVENANCE_META_KEY)) {
    const parsed = SessionMessageProvenanceV1Schema.safeParse(record[SESSION_MESSAGE_PROVENANCE_META_KEY]);
    return parsed.success ? parsed.data : null;
  }

  const predecessorOrigin = readConversationTurnOriginV1FromMessageMeta(record);
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

export function readSessionMessageProvenance(meta: unknown): SessionMessageProvenance | null {
  const record = readMetaRecord(meta);
  if (!record) return null;
  if (!Object.hasOwn(record, SESSION_MESSAGE_PROVENANCE_META_KEY)) return readSessionMessageProvenanceV1(meta);
  const parsed = SessionMessageProvenanceSchema.safeParse(record[SESSION_MESSAGE_PROVENANCE_META_KEY]);
  return parsed.success ? parsed.data : null;
}

export function readSessionPermissionSourceAuthorityV1(
  meta: unknown,
): SessionPermissionSourceAuthorityV1 | null {
  const authority = readSessionInputAuthority(meta);
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
): SessionInputCausalPermissionAuthorityV1 | null {
  const authority = readSessionInputAuthority(meta);
  if (!authority) return null;
  const sourceAuthority = readSessionPermissionSourceAuthorityV1(meta);
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
