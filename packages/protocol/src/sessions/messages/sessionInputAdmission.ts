import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';

import { resolveEffectivePermissionMode } from '../../actions/permissionPrivilege.js';
import { encodeBase64 } from '../../crypto/base64.js';
import { readConversationTurnOriginV1FromMessageMeta } from '../../messages/structured/conversationTurnOriginV1.js';
import { SubagentLaunchV1Schema } from '../../messages/structured/subagentLaunchV1.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import {
  ComposerAttachmentAuthorValueV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
} from '../../runtime/input/composerAttachmentV1.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema, readPendingLocalId } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema, type PendingRequestedActionV1 } from '../pending/pendingRequestedActionV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export const SESSION_MESSAGE_PROVENANCE_META_KEY = 'happierProvenanceV1' as const;
export const SESSION_INPUT_REQUEST_META_KEY = 'happierInputRequestV1' as const;
export const SESSION_INPUT_AUTHORITY_META_KEY = 'happierInputAuthorityV1' as const;

const UTF8_ENCODER = new TextEncoder();
const MAX_PROVENANCE_BYTES = 4 * 1024;
const PLUGIN_SESSION_INPUT_LOCAL_ID_DOMAIN_V1 = 'happier.session-input.local-id.v1';

function serializeCanonicalJsonForSessionInputEquality(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Session input equality requires canonical JSON numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Session input equality requires acyclic canonical JSON');
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new TypeError('Session input equality requires canonical JSON arrays');
      }
      const dataKeys = keys.filter((key) => key !== 'length');
      if (dataKeys.length !== value.length) {
        throw new TypeError('Session input equality requires dense canonical JSON arrays');
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('Session input equality requires canonical JSON arrays');
        }
        entries.push(serializeCanonicalJsonForSessionInputEquality(descriptor.value, ancestors));
      }
      return `[${entries.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('Session input equality requires canonical JSON');
  }
  if (ancestors.has(value)) throw new TypeError('Session input equality requires acyclic canonical JSON');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Session input equality requires canonical JSON objects');
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Session input equality requires canonical JSON objects');
    }
    const entries = (keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new TypeError('Session input equality requires canonical JSON');
      }
      return `${JSON.stringify(key)}:${serializeCanonicalJsonForSessionInputEquality(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Canonical bytes shared by trusted host/server equality code. This is a
 * serializer only: plugins never supply a digest, HMAC, or encryption nonce.
 */
export function serializeSessionInputRequestEqualityIntentV1(params: Readonly<{
  requestEnvelope: unknown;
  requestedAction: PendingRequestedActionV1;
}>): string {
  const requestedAction = PendingRequestedActionV1Schema.parse(params.requestedAction);
  return serializeCanonicalJsonForSessionInputEquality({
    v: 1,
    requestEnvelope: params.requestEnvelope,
    requestedAction,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedNfcString(maxBytes: number, label: string) {
  return z.string()
    .refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank`)
    .refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`);
}

const DisplayNameSnapshotSchema = z.string()
  .refine((value) => value === value.normalize('NFC'), 'Display-name snapshots must be NFC-normalized')
  .refine((value) => Array.from(value).length <= 128, 'Display-name snapshots must contain at most 128 Unicode code points');

const SourceRefSchema = boundedNfcString(256, 'Source references');
const SourceRevisionOrEpochSchema = boundedNfcString(128, 'Source revisions');
const BoundedAgentIdSchema = boundedNfcString(256, 'Agent ids');
const BoundedAutomationIdSchema = boundedNfcString(191, 'Automation ids');
const BoundedAutomationRunIdSchema = boundedNfcString(191, 'Automation run ids');

export const PLUGIN_INVOCATION_SURFACES_V1 = [
  'cli',
  'mcp',
  'agent',
  'ui',
  'background',
] as const;

export const PluginInvocationSurfaceV1Schema = z.enum(PLUGIN_INVOCATION_SURFACES_V1);
export type PluginInvocationSurfaceV1 = z.infer<typeof PluginInvocationSurfaceV1Schema>;

export const ExternalActorV1Schema = z.object({
  kind: z.enum(['human', 'bot']),
  displayNameSnapshot: DisplayNameSnapshotSchema.optional(),
}).strict();
export type ExternalActorV1 = z.infer<typeof ExternalActorV1Schema>;

export const ContentProvenanceV1Schema = z.enum(['original', 'forwarded', 'viaBot']);
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

export const PluginSessionInputIdempotencyKeyV1Schema = boundedNfcString(
  256,
  'Plugin Session input idempotency keys',
);

export const PluginSessionInputSourceV1Schema = z.object({
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
  requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  externalActor: ExternalActorV1Schema.optional(),
  contentProvenance: ContentProvenanceV1Schema.optional(),
}).strict().superRefine(requireCoPresentExternalProvenance);
export type PluginSessionInputSourceV1 = z.infer<typeof PluginSessionInputSourceV1Schema>;

/**
 * One authored Composer attachment declared directly on a Session input.
 *
 * It is the same author half the Composer's `attachment.add` operation already
 * carries: the caller names its own declared attachment and supplies the key,
 * value and presentation. The host qualifies the plugin id from the
 * authenticated caller and stamps `v`, the instance identity and the declared
 * type label, so an author never asserts attachment identity here.
 */
export const PluginSessionInputAttachmentV1Schema = z.object({
  attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  value: ComposerAttachmentAuthorValueV1Schema,
}).strict();
export type PluginSessionInputAttachmentV1 = z.infer<typeof PluginSessionInputAttachmentV1Schema>;

/**
 * The one bounded attachment list every Session-input surface reuses.
 *
 * The instance ceiling is the incumbent per-Message Composer attachment cap,
 * because the persisted structured-input envelope enforces exactly that bound:
 * a seam admitting more would build a Message the canonical envelope rejects
 * whole. The aggregate encoded-attachment budget stays with that envelope,
 * which is the one owner that can see every attachment on the Message.
 */
export const PluginSessionInputAttachmentsV1Schema = z.array(PluginSessionInputAttachmentV1Schema)
  .min(1)
  .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1);

/**
 * The one rule for "this input has something to deliver", shared by every
 * Session-input seam.
 *
 * A composer submission has always been admissible with blank text as long as
 * one attachment is staged — an attached entry, image or file IS the message.
 * The plugin seam required non-empty text, so a configured action whose whole
 * payload was its attachment delivered nothing at all. The two are now one
 * predicate rather than two nearly identical checks that already disagreed.
 *
 * Whitespace is not content: the composer trims before deciding, so this does
 * too, and neither seam admits an input carrying neither.
 */
export function hasSessionInputContentV1(input: Readonly<{
  text: string;
  attachmentCount: number;
}>): boolean {
  return input.text.trim().length > 0 || input.attachmentCount > 0;
}

/**
 * Applies `hasSessionInputContentV1` to a parsed Session-input shape, so the
 * plugin request schema and the Action surface binding refuse exactly the same
 * empty input with exactly the same message.
 */
export function requireSessionInputContent(
  value: Readonly<{ text?: unknown; message?: unknown; attachments?: unknown }>,
  context: z.RefinementCtx,
): void {
  const raw = typeof value.text === 'string' ? value.text : value.message;
  const text = typeof raw === 'string' ? raw : '';
  const attachmentCount = Array.isArray(value.attachments) ? value.attachments.length : 0;
  if (hasSessionInputContentV1({ text, attachmentCount })) return;
  context.addIssue({
    code: 'custom',
    path: [typeof value.text === 'string' || value.message === undefined ? 'text' : 'message'],
    message: 'A Session input must carry non-empty text or at least one attachment',
  });
}

/** Public plugin-authored intent. Caller identity and admitted authority are host-owned. */
const PluginSessionUserTextInputRequestV1Schema = z.object({
  kind: z.literal('userText'),
  /**
   * Blank only when an attachment carries the input. `requireSessionInputContent`
   * is the single gate; a `.min(1)` here would restore the divergence.
   */
  text: z.string(),
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
  source: PluginSessionInputSourceV1Schema.optional(),
  /** Declared attachment drafts admitted alongside the text. */
  attachments: PluginSessionInputAttachmentsV1Schema.optional(),
}).strict().superRefine(requireSessionInputContent);

const PluginSessionSubagentLaunchInputRequestV1Schema = z.object({
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}).strict();

export const PluginSessionInputRequestV1Schema = z.union([
  PluginSessionUserTextInputRequestV1Schema,
  PluginSessionSubagentLaunchInputRequestV1Schema,
]);
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

const HappierAppProvenanceSchema = z.object({
  v: z.literal(1),
  kind: z.literal('happierApp'),
  actor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner') }).strict(),
    z.object({ kind: z.literal('sharedCollaborator') }).strict(),
  ]),
}).strict();

const PluginSessionProvenanceSchema = z.object({
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
});

const MessageProvenanceUnionSchema = z.discriminatedUnion('kind', [
  HappierAppProvenanceSchema,
  z.object({ v: z.literal(1), kind: z.literal('cli') }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('voice') }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('happierSession'),
    sourceSessionId: asProtocolZod(SessionIdSchema),
    via: z.enum(['action', 'mcp']),
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
    kind: z.literal('agentTerminal'),
    agentId: BoundedAgentIdSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('host'),
    producer: z.enum([
      'happierApp',
      'cli',
      'daemonInitialPrompt',
      'sessionAction',
      'happierMcp',
      'pluginSession',
      'connectedService',
      'automation',
      'voiceInput',
      'agentTerminal',
      'externalSessionHistory',
      'runtimeTranscript',
      'executionRunVoice',
      'agentRuntimeFirstInput',
    ]),
  }).strict(),
]);

export const SessionMessageProvenanceV1Schema = MessageProvenanceUnionSchema.superRefine((value, context) => {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_PROVENANCE_BYTES) {
    context.addIssue({
      code: 'custom',
      message: 'Session message provenance exceeds its encoded 4 KiB limit',
    });
  }
});
export type SessionMessageProvenanceV1 = z.infer<typeof SessionMessageProvenanceV1Schema>;

export const SESSION_ROLE_USER_PRODUCER_KINDS_V1 = [
  'happierApp',
  'cli',
  'daemonInitialPrompt',
  'sessionAction',
  'happierMcp',
  'pluginSession',
  'connectedService',
  'automation',
  'voiceInput',
  'agentTerminal',
  'externalSessionHistory',
  'runtimeTranscript',
  'executionRunVoice',
  'agentRuntimeFirstInput',
] as const;

export const SessionRoleUserProducerKindV1Schema = z.enum(SESSION_ROLE_USER_PRODUCER_KINDS_V1);
export type SessionRoleUserProducerKindV1 = z.infer<typeof SessionRoleUserProducerKindV1Schema>;

export const SESSION_ROLE_USER_PRODUCER_ADMISSION_MODES_V1 = Object.freeze({
  happierApp: 'pendingInput',
  cli: 'pendingInput',
  daemonInitialPrompt: 'pendingInput',
  sessionAction: 'pendingInput',
  happierMcp: 'pendingInput',
  pluginSession: 'pendingInput',
  connectedService: 'pendingInput',
  automation: 'pendingInput',
  voiceInput: 'pendingInput',
  agentTerminal: 'directInput',
  externalSessionHistory: 'transcriptOnly',
  runtimeTranscript: 'transcriptOnly',
  executionRunVoice: 'transcriptOnly',
  agentRuntimeFirstInput: 'pendingInput',
} as const satisfies Record<SessionRoleUserProducerKindV1, SessionRoleUserProducerAdmissionModeV1>);

export type SessionRoleUserProducerAdmissionModeV1 =
  | 'pendingInput'
  | 'directInput'
  | 'transcriptOnly';

const SessionInputCallerV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  z.object({ kind: z.literal('host') }).strict(),
]);

const SessionInputSourceSessionV1Schema = z.object({
  sourceSessionId: asProtocolZod(SessionIdSchema),
  sourceTurnId: TurnIdSchema,
  via: z.enum(['action', 'mcp']),
}).strict();

export const SessionInputSourceAuthorityV1Schema = z.object({
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}).strict();
export type SessionInputSourceAuthorityV1 = z.infer<typeof SessionInputSourceAuthorityV1Schema>;

const SessionInputAutomationV1Schema = z.object({
  automationId: BoundedAutomationIdSchema,
  runId: BoundedAutomationRunIdSchema,
}).strict();

const SessionInputProtectedCommonV1Schema = z.object({
  v: z.literal(1),
  producer: SessionRoleUserProducerKindV1Schema,
  caller: SessionInputCallerV1Schema.optional(),
  sourceSession: SessionInputSourceSessionV1Schema.optional(),
  sourceAuthority: SessionInputSourceAuthorityV1Schema.optional(),
  automation: SessionInputAutomationV1Schema.optional(),
}).strict();

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
  if (value.sourceAuthority && value.caller?.kind !== 'plugin') {
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
}

export const SessionInputRequestV1Schema = SessionInputProtectedCommonV1Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
  }).strict(),
}).strict().superRefine(refineProtectedInputCommon);
export type SessionInputRequestV1 = z.infer<typeof SessionInputRequestV1Schema>;

export const SessionInputAuthorityV1Schema = SessionInputProtectedCommonV1Schema.extend({
  permission: z.object({
    requestedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
    admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  }).strict(),
}).strict().superRefine(refineProtectedInputCommon);
export type SessionInputAuthorityV1 = z.infer<typeof SessionInputAuthorityV1Schema>;

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

const AccountIdSchema = boundedNfcString(191, 'Account ids');

export const SessionInputAdmissionReceiptV1Schema = z.discriminatedUnion('issuer', [
  z.object({
    v: z.literal(1),
    issuer: z.literal('authenticatedAccount'),
    actorAccountId: AccountIdSchema,
    sessionRelationship: z.enum(['owner', 'sharedEditor', 'sharedAdmin']),
  }).strict(),
  z.object({
    v: z.literal(1),
    issuer: z.literal('authenticatedMachine'),
  }).strict(),
]);
export type SessionInputAdmissionReceiptV1 = z.infer<typeof SessionInputAdmissionReceiptV1Schema>;

const Base64UrlSha256Schema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'Expected an unpadded base64url SHA-256 value',
);

export const SessionInputRequestEnvelopeDigestV1Schema = Base64UrlSha256Schema;
export type SessionInputRequestEnvelopeDigestV1 = z.infer<typeof SessionInputRequestEnvelopeDigestV1Schema>;

export const SessionInputRequestEqualityEvidenceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plainDigest'), digest: SessionInputRequestEnvelopeDigestV1Schema }).strict(),
  z.object({ kind: z.literal('e2eeTag'), tag: Base64UrlSha256Schema }).strict(),
]);
export type SessionInputRequestEqualityEvidenceV1 = z.infer<typeof SessionInputRequestEqualityEvidenceV1Schema>;

export const SESSION_INPUT_ADMISSION_REJECTION_CODES_V1 = [
  'session_input_invalid',
  'session_input_archived',
  'session_input_unauthorized',
  'session_input_target_unavailable',
  'session_input_target_update_required',
  'session_input_cancelled',
  'session_input_untrusted_assertion',
  'session_input_idempotency_conflict',
  'session_input_source_authority_mismatch',
  'session_input_permission_ceiling_rejected',
  'session_input_encryption_mode_mismatch',
] as const;

export const SessionInputAdmissionRejectionCodeV1Schema = z.enum(
  SESSION_INPUT_ADMISSION_REJECTION_CODES_V1,
);
export type SessionInputAdmissionRejectionCodeV1 = z.infer<
  typeof SessionInputAdmissionRejectionCodeV1Schema
>;

export const SessionInputAdmissionResultV1Schema = z.discriminatedUnion('status', [
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
    code: boundedNfcString(128, 'Admission outcome codes'),
  }).strict(),
]);
export type SessionInputAdmissionResultV1 = z.infer<typeof SessionInputAdmissionResultV1Schema>;

export const SessionPermissionSourceAuthorityV1Schema = z.object({
  kind: z.literal('mediatedExternal'),
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  sourceRef: SourceRefSchema,
  sourceRevisionOrEpoch: SourceRevisionOrEpochSchema,
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  remoteApprovalMaxScope: z.enum(['off', 'request', 'session']),
}).strict();
export type SessionPermissionSourceAuthorityV1 = z.infer<
  typeof SessionPermissionSourceAuthorityV1Schema
>;

/**
 * Immutable input authority carried with one host-dispatched turn. Its explicit
 * arm separates admitted V1 input from pre-admission legacy/host execution.
 */
export const SessionInputCausalPermissionAuthorityV1Schema = z.object({
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
});
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

export function readSessionInputAuthorityV1(meta: unknown): SessionInputAuthorityV1 | null {
  const record = readMetaRecord(meta);
  if (!record || Object.hasOwn(record, SESSION_INPUT_REQUEST_META_KEY)) return null;
  const parsed = SessionInputAuthorityV1Schema.safeParse(record[SESSION_INPUT_AUTHORITY_META_KEY]);
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

export function readSessionPermissionSourceAuthorityV1(
  meta: unknown,
): SessionPermissionSourceAuthorityV1 | null {
  const authority = readSessionInputAuthorityV1(meta);
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
  const authority = readSessionInputAuthorityV1(meta);
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

export function withSessionInputAuthorityV1(
  meta: Record<string, unknown> | null | undefined,
  authority: SessionInputAuthorityV1,
): Record<string, unknown> {
  return {
    ...stripSessionInputProtectedMeta(meta),
    [SESSION_INPUT_AUTHORITY_META_KEY]: SessionInputAuthorityV1Schema.parse(authority),
  };
}
