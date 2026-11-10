import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ProjectOpenDraftDocumentV2Schema } from '../projects/openProjectDraftV1.js';
import { DocPassageRefV1Schema } from '../artifacts/artifactCollaborationV1.js';
import { DiscussionMessageContentV1Schema } from '../discussions/content.js';
import { DiscussionLocalIdSchema } from '../discussions/references.js';
import { DiscussionInitialParticipantsV1Schema } from '../discussions/participants.js';
import { DiscussionReplyTargetV1Schema } from '../discussions/replyTargets.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { normalizeParticipantRecipientRoutingIdentityV1 } from '../messages/structured/participantMessageV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  SyncedSessionAuthoringFieldIdV1Schema,
  SyncedSessionAuthoringValueV1Schema,
} from '../sessions/authoring/syncedSessionAuthoringV1.js';
import { SessionAuthoringExecutionTargetV2Schema } from '../sessions/authoring/fieldCatalog.js';
import { SyncedSessionAuthoringValueV2Schema } from '../sessions/authoring/index.js';
import {
  ExecutionRunIdSchema,
  DiscussionIdSchema,
  SessionIdSchema,
} from '../sessions/idsV1.js';
import {
  SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH,
  SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES,
  SESSION_DRAFT_MAX_FIELDS,
  DraftFieldV1Schema,
  SessionDraftAddressV1Schema,
  SessionDraftDocumentV1Schema,
  SessionDraftExpectedRevisionV1Schema,
  SessionDraftPrivatePayloadV1Schema,
  SessionDraftStoredContentEnvelopeV1Schema,
  SessionDraftRecipientValueV1Schema,
  canonicalSessionDraftAddressV1,
  createSessionDraftAuthoringFieldsSchema,
  type SessionDraftAddressV1,
  type SessionDraftDocumentV1,
} from './sessionDrafts.js';

/**
 * V2 adds draft addresses and new-session authoring intent through the same
 * repository, KV prefix, revision CAS, cipher and lifecycle owners. Strict V1
 * operations neither expose nor rewrite successor addresses or content.
 */

export const SESSION_DRAFT_V2_SOCKET_EVENT = 'session-draft-v2-updated' as const;
export const SESSION_DRAFT_V2_ROUTE_READ = '/v2/account/session-drafts/read' as const;
export const SESSION_DRAFT_V2_ROUTE_LIST = '/v2/account/session-drafts/list' as const;
export const SESSION_DRAFT_V2_ROUTE_MUTATE = '/v2/account/session-drafts/mutate' as const;

const RunDraftAddressSchema = z.strictObject({
  kind: z.literal('run'),
  sessionId: asProtocolZod(SessionIdSchema),
  runId: ExecutionRunIdSchema,
});
const DiscussionDraftAddressSchema = z.strictObject({
  kind: z.literal('discussion'),
  discussionId: asProtocolZod(DiscussionIdSchema),
});
const NewDiscussionDraftAddressSchema = z.strictObject({
  kind: z.literal('newDiscussion'),
  draftId: z.optional(SessionDraftAddressV1Schema._zod.def.options[0].shape.draftId),
});

export const ProjectOpenDraftAddressV2Schema = z.strictObject({
  kind: z.literal('projectOpen'),
  draftId: SessionDraftAddressV1Schema._zod.def.options[0].shape.draftId,
});

/** Account-owned drafts follow Account mode, independently of Session availability. */
export const AccountOwnedDraftAddressV2Schema = z.union([
  SessionDraftAddressV1Schema._zod.def.options[0],
  ProjectOpenDraftAddressV2Schema,
  DiscussionDraftAddressSchema,
  NewDiscussionDraftAddressSchema,
]);
export type AccountOwnedDraftAddressV2 = z.infer<typeof AccountOwnedDraftAddressV2Schema>;

/** The address arms V1 cannot express. */
export const SessionDraftAddressV2OnlySchema = z.union([
  RunDraftAddressSchema,
  DiscussionDraftAddressSchema,
  NewDiscussionDraftAddressSchema,
  ProjectOpenDraftAddressV2Schema,
]);
export type SessionDraftAddressV2Only = z.infer<typeof SessionDraftAddressV2OnlySchema>;

export const SessionDraftAddressV2Schema = z.union([
  SessionDraftAddressV1Schema,
  SessionDraftAddressV2OnlySchema,
]);
export type SessionDraftAddressV2 = z.infer<typeof SessionDraftAddressV2Schema>;

export function isAccountOwnedDraftAddressV2(address: SessionDraftAddressV2): address is AccountOwnedDraftAddressV2 {
  return address.kind === 'newSession' || address.kind === 'projectOpen'
    || address.kind === 'discussion' || address.kind === 'newDiscussion';
}

export function isSessionDraftAddressV1(address: SessionDraftAddressV2): address is SessionDraftAddressV1 {
  return address.kind === 'newSession' || address.kind === 'session';
}

const NEW_DISCUSSION_SEGMENT = 'new-discussion';

export function canonicalSessionDraftAddressV2(address: SessionDraftAddressV2): string {
  if (isSessionDraftAddressV1(address)) return canonicalSessionDraftAddressV1(address);
  if (address.kind === 'projectOpen') return `project-open/${address.draftId}`;
  if (address.kind === 'discussion') {
    return `discussion/${encodeURIComponent(address.discussionId)}`;
  }
  if (address.kind === 'newDiscussion') return address.draftId === undefined
    ? NEW_DISCUSSION_SEGMENT : `${NEW_DISCUSSION_SEGMENT}/${address.draftId}`;
  return `session/${encodeURIComponent(address.sessionId)}/run/${encodeURIComponent(address.runId)}`;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Parses an exact canonical address. Round-trip equality is required, so a
 * non-canonical encoding of the same identifiers is rejected rather than
 * aliased onto a neighbouring row.
 */
export function parseCanonicalSessionDraftAddressV2(value: string): SessionDraftAddressV2 | null {
  const candidate = ((): unknown => {
    if (value.startsWith('new-session/')) {
      return { kind: 'newSession', draftId: value.slice('new-session/'.length) };
    }
    if (value.startsWith('project-open/')) {
      return { kind: 'projectOpen', draftId: value.slice('project-open/'.length) };
    }
    if (value === NEW_DISCUSSION_SEGMENT) return { kind: 'newDiscussion' };
    if (value.startsWith(`${NEW_DISCUSSION_SEGMENT}/`)) {
      return { kind: 'newDiscussion', draftId: value.slice(NEW_DISCUSSION_SEGMENT.length + 1) };
    }
    if (value.startsWith('discussion/')) {
      const discussionId = decodeSegment(value.slice('discussion/'.length));
      return discussionId === null ? null : { kind: 'discussion', discussionId };
    }
    if (!value.startsWith('session/')) return null;
    const segments = value.slice('session/'.length).split('/');
    const sessionId = decodeSegment(segments[0] ?? '');
    if (sessionId === null) return null;
    if (segments.length === 1) return { kind: 'session', sessionId };
    if (segments.length !== 3) return null;
    const identifier = decodeSegment(segments[2] ?? '');
    if (identifier === null) return null;
    if (segments[1] === 'run') return { kind: 'run', sessionId, runId: identifier };
    return null;
  })();
  if (candidate === null) return null;
  const parsed = SessionDraftAddressV2Schema.safeParse(candidate);
  return parsed.success && canonicalSessionDraftAddressV2(parsed.data) === value ? parsed.data : null;
}

export const CanonicalSessionDraftAddressV2Schema = z.string().check(z.minLength(1), z.refine((value) => parseCanonicalSessionDraftAddressV2(value) !== null, 'Expected a canonical session draft address'));
export type CanonicalSessionDraftAddressV2 = z.infer<typeof CanonicalSessionDraftAddressV2Schema>;

const DiscussionDraftFieldSchema = <T extends z.ZodMiniType>(value: T) => z.strictObject({
  mutationId: z.string().check(z.uuid()),
  value,
});

/** Original uncertain write; later draft edits cannot replace its authored operands. */
export const DiscussionDraftSubmittedContentV2Schema = lazyZodSchema(() => z.strictObject({
  attemptLocalId: DiscussionLocalIdSchema,
  content: DiscussionMessageContentV1Schema,
  title: z.optional(z.string()),
}));
export type DiscussionDraftSubmittedContentV2 = z.infer<typeof DiscussionDraftSubmittedContentV2Schema>;

/**
 * Human conversation drafts (Lane 05.03 semantics) composed at this one draft
 * document owner. They carry no Agent routing, delivery, authoring or
 * attachment bytes.
 */
export const DiscussionDraftDocumentV2Schema = z.strictObject({
  v: z.literal(2),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('discussion') }),
    z.strictObject({ kind: z.literal('newDiscussion') }),
  ]),
  composer: z.strictObject({
    text: DiscussionDraftFieldSchema(z.string()),
    mentions: DiscussionDraftFieldSchema(z.array(StrictJsonValueSchema)),
    attachments: DiscussionDraftFieldSchema(z.array(z.never()).check(z.maxLength(0))),
  }),
  title: z.optional(DiscussionDraftFieldSchema(z.string())),
  /** Explicit composer defaults, retained when submitted text is cleared. Never membership authority. */
  recipients: z.optional(DiscussionDraftFieldSchema(DiscussionInitialParticipantsV1Schema)),
  /** Explicit Reply intent, independent of navigation focus and cleared with its submitted post. */
  replyTarget: z.optional(DiscussionDraftFieldSchema(z.nullable(DiscussionReplyTargetV1Schema))),
  /** New Discussion only: the people and agents chosen to invite at create. Addressing stays in the message. */
  participants: z.optional(DiscussionDraftFieldSchema(DiscussionInitialParticipantsV1Schema)),
  /** The source basis is private draft content, never local-only retry metadata. */
  passage: z.optional(DiscussionDraftFieldSchema(z.nullable(DocPassageRefV1Schema.check(
    z.refine(value => value.ref.serverId !== undefined, 'A retained passage requires its captured Home'),
  )))),
  submission: z.optional(DiscussionDraftFieldSchema(z.nullable(DiscussionDraftSubmittedContentV2Schema))),
}).check(z.superRefine((document, context) => {
  if (document.title && document.target.kind !== 'newDiscussion') {
    context.addIssue({
      code: "custom",
      path: ['title'],
      message: 'Only a new-discussion draft carries a title field',
    });
  }
  if (document.participants && document.target.kind !== 'newDiscussion') {
    context.addIssue({
      code: "custom",
      path: ['participants'],
      message: 'Only a new-discussion draft carries initial participants',
    });
  }
}));
export type DiscussionDraftDocumentV2 = z.infer<typeof DiscussionDraftDocumentV2Schema>;

/** New-session intent evolves here, never by widening the released V1 document. */
export const NewSessionDraftDocumentV2Schema = z.strictObject({
  v: z.literal(2),
  composer: SessionDraftDocumentV1Schema.shape.composer,
  target: z.strictObject({
    kind: z.literal('newSession'),
    authoring: createSessionDraftAuthoringFieldsSchema(SyncedSessionAuthoringValueV2Schema),
  }),
  extensions: SessionDraftDocumentV1Schema.shape.extensions,
}).check(z.superRefine((document, context) => {
  const extensionFields = Object.values(document.extensions)
    .reduce((count, fields) => count + Object.keys(fields).length, 0);
  if (3 + Object.keys(document.target.authoring).length + extensionFields > SESSION_DRAFT_MAX_FIELDS) {
    context.addIssue({ code: "custom", message: 'Draft field count exceeds the supported boundary' });
  }
}));
export type NewSessionDraftDocumentV2 = z.infer<typeof NewSessionDraftDocumentV2Schema>;

// Options are disjoint by `v` and target kind, so order changes no result. A union walks every
// failed option's whole shape, so the most numerous current kind (newSession) is tried first and
// the released V1 shape, read through its own V1 payload, last.
export const SessionDraftDocumentV2Schema = z.union([
  NewSessionDraftDocumentV2Schema,
  DiscussionDraftDocumentV2Schema,
  ProjectOpenDraftDocumentV2Schema,
  SessionDraftDocumentV1Schema,
]);
export type SessionDraftDocumentV2 = z.infer<typeof SessionDraftDocumentV2Schema>;

function readManualRecipientRunId(document: SessionDraftDocumentV1): string | null {
  if (document.target.kind !== 'session') return null;
  const recipient = SessionDraftRecipientValueV1Schema.safeParse(document.target.routing.recipient.value);
  if (!recipient.success || recipient.data === null || recipient.data.recipient === null) return null;
  try {
    const identity = normalizeParticipantRecipientRoutingIdentityV1(recipient.data.recipient);
    return identity.kind === 'execution_run' ? identity.runId : null;
  } catch {
    return null;
  }
}

const SessionDraftPrivatePayloadV2OnlySchema = z.strictObject({
  v: z.literal(2),
  address: z.union([
    SessionDraftAddressV2OnlySchema,
    SessionDraftAddressV1Schema._zod.def.options[0],
  ]),
  document: SessionDraftDocumentV2Schema,
}).check(z.superRefine((payload, context) => {
  if (payload.address.kind === 'run') {
    if (payload.document.v === 2) {
      context.addIssue({
        code: "custom",
        path: ['document', 'v'],
        message: 'A run draft carries the existing Session document shape',
      });
    } else if (readManualRecipientRunId(payload.document) !== payload.address.runId) {
      context.addIssue({
        code: "custom",
        path: ['document', 'target', 'routing', 'recipient'],
        message: 'A run draft must select its own run as the manual recipient',
      });
    }
  } else if (payload.document.v !== 2 || payload.document.target.kind !== payload.address.kind) {
    context.addIssue({
      code: "custom",
      path: ['document', 'target', 'kind'],
      message: 'Draft payload address and document target must agree',
    });
  }
  if (
    new TextEncoder().encode(JSON.stringify(payload)).byteLength
    > SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: 'Draft private payload exceeds the supported boundary',
    });
  }
}));

/**
 * V1 addresses keep their exact V1 payload envelope on the shared rows, so a V2
 * client editing a main Session draft cannot break its V1 sibling.
 */
export const SessionDraftPrivatePayloadV2Schema = z.discriminatedUnion('v', [
  SessionDraftPrivatePayloadV1Schema,
  SessionDraftPrivatePayloadV2OnlySchema,
]);
export type SessionDraftPrivatePayloadV2 = z.infer<typeof SessionDraftPrivatePayloadV2Schema>;
export const SessionDraftPrivatePayloadV2StoredSchema = createStoredReadSchema(SessionDraftPrivatePayloadV2Schema);

/**
 * A lossless Machine-only projection retains ordinary V1 interoperability.
 * Successor fields, selection provenance and Temporary computer cannot be
 * dropped by this projection: the strict V1 parser instead selects V2.
 */
export function createSessionDraftPrivatePayloadV2(
  address: SessionDraftAddressV2,
  document: SessionDraftDocumentV2,
): SessionDraftPrivatePayloadV2 {
  return SessionDraftPrivatePayloadV2Schema.parse({
    v: isSessionDraftAddressV1(address) && document.v === 1 ? 1 : 2,
    address,
    document,
  });
}

export const SessionDraftStoredContentEnvelopeV2Schema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: SessionDraftPrivatePayloadV2Schema,
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    /** Visible content epoch protects opaque newSession rows from V1 writers. */
    v: z.optional(z.literal(2)),
    c: z.string().check(z.minLength(1), z.maxLength(SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH)),
  }),
]);
export type SessionDraftStoredContentEnvelopeV2 = z.infer<typeof SessionDraftStoredContentEnvelopeV2Schema>;
export const SessionDraftStoredContentEnvelopeV2StoredSchema = createStoredReadSchema(SessionDraftStoredContentEnvelopeV2Schema);

/** Address membership alone cannot determine whether a newSession row is V1-readable. */
export function isSessionDraftContentV1(
  content: SessionDraftStoredContentEnvelopeV2 | null,
): boolean {
  return content === null || SessionDraftStoredContentEnvelopeV1Schema.safeParse(content).success;
}

/** Existing HTTP operation-update result; unaffected V1 drafts remain usable. */
export const SessionDraftEpochUnavailableResponseV2Schema = z.strictObject({
  error: z.literal('session_draft_epoch_unavailable'),
});

export const SessionDraftRecordV2Schema = z.strictObject({
  address: SessionDraftAddressV2Schema,
  revision: z.number().check(z.int(), z.nonnegative()),
  content: z.nullable(SessionDraftStoredContentEnvelopeV2Schema),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
});
export type SessionDraftRecordV2 = z.infer<typeof SessionDraftRecordV2Schema>;

export const SessionDraftReadRequestV2Schema = z.strictObject({
  address: SessionDraftAddressV2Schema,
});
export type SessionDraftReadRequestV2 = z.infer<typeof SessionDraftReadRequestV2Schema>;
export const SessionDraftReadResponseV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('present'), record: SessionDraftRecordV2Schema }),
  z.strictObject({ status: z.literal('deleted'), record: SessionDraftRecordV2Schema }),
  z.strictObject({ status: z.literal('absent') }),
]);
export type SessionDraftReadResponseV2 = z.infer<typeof SessionDraftReadResponseV2Schema>;

/**
 * Client read projection of a Home response: the record envelope stays strict,
 * while stored content drops retired fields through the persistence read owner.
 */
const SessionDraftRecordV2StoredContentSchema = z.strictObject({
  ...SessionDraftRecordV2Schema.shape,
  content: z.nullable(SessionDraftStoredContentEnvelopeV2StoredSchema),
});
export const SessionDraftReadResponseV2StoredContentSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('present'), record: SessionDraftRecordV2StoredContentSchema }),
  z.strictObject({ status: z.literal('deleted'), record: SessionDraftRecordV2StoredContentSchema }),
  z.strictObject({ status: z.literal('absent') }),
]);

export const SessionDraftAddressKindV2Schema = z.enum([
  'newSession',
  'session',
  'run',
  'discussion',
  'newDiscussion',
  'projectOpen',
]);
export type SessionDraftAddressKindV2 = z.infer<typeof SessionDraftAddressKindV2Schema>;

export const SessionDraftListRequestV2Schema = z.strictObject({
  after: z.optional(CanonicalSessionDraftAddressV2Schema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  /** Query selector only; it is never the V1/V2 compatibility barrier. */
  addressKinds: z.optional(z.array(SessionDraftAddressKindV2Schema).check(z.minLength(1))),
});
export type SessionDraftListRequestV2 = z.infer<typeof SessionDraftListRequestV2Schema>;
export const SessionDraftListResponseV2Schema = z.strictObject({
  items: z.array(SessionDraftRecordV2Schema),
  nextAfter: z.optional(CanonicalSessionDraftAddressV2Schema),
});
export type SessionDraftListResponseV2 = z.infer<typeof SessionDraftListResponseV2Schema>;
export const SessionDraftListResponseV2StoredContentSchema = z.strictObject({
  items: z.array(SessionDraftRecordV2StoredContentSchema),
  nextAfter: z.optional(CanonicalSessionDraftAddressV2Schema),
});

export const SessionDraftMutateRequestV2Schema = z.strictObject({
  address: SessionDraftAddressV2Schema,
  expectedRevision: SessionDraftExpectedRevisionV1Schema,
  content: z.nullable(SessionDraftStoredContentEnvelopeV2Schema),
});
export type SessionDraftMutateRequestV2 = z.infer<typeof SessionDraftMutateRequestV2Schema>;
export const SessionDraftMutateResponseV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), record: SessionDraftRecordV2Schema }),
  z.strictObject({
    status: z.literal('conflict'),
    current: z.union([
      SessionDraftRecordV2Schema,
      z.strictObject({ status: z.literal('absent') }),
    ]),
  }),
]);
export type SessionDraftMutateResponseV2 = z.infer<typeof SessionDraftMutateResponseV2Schema>;

/**
 * Emitted only for V2-only addresses. Its discriminator cannot satisfy the
 * strict V1 hint schema, so a released V1 reader ignores it instead of feeding
 * an unknown address into a V1 draft handler.
 */
export const SessionDraftChangeHintV2Schema = z.strictObject({
  v: z.literal(2),
  sessionDraftV2: z.literal(true),
  address: SessionDraftAddressV2Schema,
  revision: z.number().check(z.int(), z.nonnegative()),
  status: z.enum(['present', 'deleted']),
});
export type SessionDraftChangeHintV2 = z.infer<typeof SessionDraftChangeHintV2Schema>;
export const SessionDraftSocketUpdateV2Schema = SessionDraftChangeHintV2Schema;
export type SessionDraftSocketUpdateV2 = SessionDraftChangeHintV2;
