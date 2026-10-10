import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
  readServerHttpRequestBodyUtf8ByteLengthV1,
} from '../../server/http/requestBodyBoundsV1.js';
import {
  StrictSessionStoredMessageContentEnvelopeSchema,
  type StrictSessionStoredMessageContentEnvelope,
} from '../messages/sessionStoredMessageContent.js';
import {
  SessionMutationEqualityEvidenceV1Schema,
  type SessionMutationEqualityEvidenceV1,
} from '../mutations/sessionMutationEqualityV1.js';
import {
  SessionDiscussionAccountIdSchema,
  SessionDiscussionIdSchema,
  SessionDiscussionLocalIdSchema,
} from './content.js';
import {
  SessionDiscussionAttentionFactsV1Schema,
  SessionDiscussionMessageV1Schema,
  SessionDiscussionReadCursorV1Schema,
  SessionDiscussionSummaryV1Schema,
} from './models.js';
export {
  SESSION_DISCUSSION_DEFAULT_PAGE_SIZE_V1,
  SESSION_DISCUSSION_MAX_PAGE_SIZE_V1,
  SessionDiscussionListQueryV1Schema,
  SessionDiscussionMessagesQueryV1Schema,
} from './query.js';
export type {
  SessionDiscussionListQueryV1,
  SessionDiscussionMessagesQueryV1,
} from './query.js';

export const SESSION_DISCUSSION_ERROR_CODES_V1 = [
  'session_discussions_unavailable',
  'session_discussion_not_found',
  'session_discussion_archived',
  'session_discussion_session_archived',
  'session_discussion_read_denied',
  'session_discussion_post_denied',
  'session_discussion_manage_denied',
  'session_discussion_encryption_mode_mismatch',
  'session_discussion_invalid_content',
  'session_discussion_invalid_mention',
  'session_discussion_idempotency_conflict',
  'session_discussion_read_cursor_invalid',
] as const;

export const SessionDiscussionErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_DISCUSSION_ERROR_CODES_V1));
export type SessionDiscussionErrorCodeV1 = z.infer<typeof SessionDiscussionErrorCodeV1Schema>;

/**
 * Lane 09's private tracking owner decides whether an Account tracks a Session
 * at all. Discussion code only refuses to write a cursor for an untracked
 * Account and surfaces that owner's result; it never establishes tracking.
 */
export const SESSION_DISCUSSION_NOT_TRACKED_CODE_V1 = 'session_not_tracked' as const;

export const SessionDiscussionErrorResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.union([
    SessionDiscussionErrorCodeV1Schema,
    z.literal(SESSION_DISCUSSION_NOT_TRACKED_CODE_V1),
  ]),
}).strict());
export type SessionDiscussionErrorResponseV1 = z.infer<typeof SessionDiscussionErrorResponseV1Schema>;

/**
 * One path owner shared by the Action catalog, explicit server routes, and
 * authenticated client adapters. Methods and handler policy remain with those
 * consumers; this object only prevents path literals from drifting.
 */
export const SESSION_DISCUSSION_HTTP_PATHS_V1 = Object.freeze({
  collection: '/v2/sessions/:sessionId/discussions',
  discussion: '/v2/sessions/:sessionId/discussions/:discussionId',
  archive: '/v2/sessions/:sessionId/discussions/:discussionId/archive',
  restore: '/v2/sessions/:sessionId/discussions/:discussionId/restore',
  messages: '/v2/sessions/:sessionId/discussions/:discussionId/messages',
  read: '/v2/sessions/:sessionId/discussions/:discussionId/read',
} as const);

export const SessionDiscussionListResponseV1Schema = lazyZodSchema(() => z.object({
  discussions: z.array(SessionDiscussionSummaryV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type SessionDiscussionListResponseV1 = z.infer<typeof SessionDiscussionListResponseV1Schema>;

export const SessionDiscussionMessagesResponseV1Schema = lazyZodSchema(() => z.object({
  messages: z.array(SessionDiscussionMessageV1Schema),
  hasMoreOlder: z.boolean(),
  messageSeq: z.number().int().min(0),
}).strict());
export type SessionDiscussionMessagesResponseV1 = z.infer<typeof SessionDiscussionMessagesResponseV1Schema>;

const MentionedAccountIdsSchema = lazyZodSchema(() => z.array(SessionDiscussionAccountIdSchema).refine(
  (value) => new Set(value).size === value.length,
  'Mentioned Account ids must be deduplicated',
));

/**
 * One sealed message write. Encrypted content must carry a client-derived
 * `e2eeTag`: the Home cannot compute it, so it can compare but never guess
 * plaintext. Plain content must not carry client-asserted equality at all —
 * the server derives that digest from the normalized semantic request.
 */
export const SessionDiscussionMessageWriteV1Schema = lazyZodSchema(() => z.object({
  localId: SessionDiscussionLocalIdSchema,
  requestEqualityEvidenceV1: SessionMutationEqualityEvidenceV1Schema.optional(),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  mentionedAccountIds: MentionedAccountIdsSchema,
}).strict().superRefine((value, context) => {
  refineEqualityEvidenceForEnvelope(
    value.content.t,
    value.requestEqualityEvidenceV1,
    context,
    ['requestEqualityEvidenceV1'],
  );
}));
export type SessionDiscussionMessageWriteV1 = z.infer<typeof SessionDiscussionMessageWriteV1Schema>;

function refineEqualityEvidenceForEnvelope(
  envelopeKind: 'plain' | 'encrypted',
  evidence: { kind: 'plainDigest' } | { kind: 'e2eeTag' } | undefined,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (envelopeKind === 'encrypted') {
    if (!evidence || evidence.kind !== 'e2eeTag') {
      context.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Encrypted discussion content requires client-derived e2eeTag equality evidence',
      });
    }
    return;
  }
  if (evidence) {
    context.addIssue({
      code: 'custom',
      path: [...path],
      message: 'Plain discussion content must not carry client-asserted equality evidence',
    });
  }
}

export const SessionDiscussionCreateRequestV1Schema = lazyZodSchema(() => z.object({
  creationLocalId: SessionDiscussionLocalIdSchema,
  creationEqualityEvidenceV1: SessionMutationEqualityEvidenceV1Schema.optional(),
  titleContent: StrictSessionStoredMessageContentEnvelopeSchema,
  firstMessage: SessionDiscussionMessageWriteV1Schema,
}).strict().superRefine((value, context) => {
  if (value.creationLocalId === value.firstMessage.localId) {
    context.addIssue({
      code: 'custom',
      path: ['firstMessage', 'localId'],
      message: 'Discussion creation and first-message retry identities must be distinct',
    });
  }
  refineEqualityEvidenceForEnvelope(
    value.titleContent.t,
    value.creationEqualityEvidenceV1,
    context,
    ['creationEqualityEvidenceV1'],
  );
  if (value.titleContent.t !== value.firstMessage.content.t) {
    context.addIssue({
      code: 'custom',
      path: ['firstMessage', 'content'],
      message: 'A discussion title and its first message must use the same Session storage mode',
    });
  }
}));
export type SessionDiscussionCreateRequestV1 = z.infer<typeof SessionDiscussionCreateRequestV1Schema>;

export const SessionDiscussionPostRequestV1Schema = SessionDiscussionMessageWriteV1Schema;
export type SessionDiscussionPostRequestV1 = z.infer<typeof SessionDiscussionPostRequestV1Schema>;

/**
 * Session-scoped runtime carrier for one Agent-authored Discussion post.
 *
 * The authenticated current-publisher socket supplies Account, Machine and
 * Session authority. The request deliberately contains no producer object:
 * the server derives that projection only after the publisher fence passes.
 */
export const SESSION_DISCUSSION_AGENT_POST_EVENT_V1 = 'session-discussion-agent-post-v1' as const;

export const SessionDiscussionAgentPostRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionId: SessionDiscussionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  request: SessionDiscussionPostRequestV1Schema,
  runId: SessionDiscussionIdSchema.optional(),
  toolCallId: SessionDiscussionIdSchema.optional(),
}).strict());
export type SessionDiscussionAgentPostRequestV1 = z.infer<typeof SessionDiscussionAgentPostRequestV1Schema>;

export const SessionDiscussionRenameRequestV1Schema = lazyZodSchema(() => z.object({
  titleContent: StrictSessionStoredMessageContentEnvelopeSchema,
}).strict());
export type SessionDiscussionRenameRequestV1 = z.infer<typeof SessionDiscussionRenameRequestV1Schema>;

type SessionDiscussionE2eeEqualityEvidenceV1 = Extract<
  SessionMutationEqualityEvidenceV1,
  Readonly<{ kind: 'e2eeTag' }>
>;

export type SessionDiscussionCreateMutationRequestBodyInputV1 = Readonly<{
  kind: 'create';
  creationLocalId: string;
  creationEqualityEvidenceV1?: SessionDiscussionE2eeEqualityEvidenceV1;
  titleContent: StrictSessionStoredMessageContentEnvelope;
  firstMessage: Readonly<{
    localId: string;
    requestEqualityEvidenceV1?: SessionDiscussionE2eeEqualityEvidenceV1;
    content: StrictSessionStoredMessageContentEnvelope;
    mentionedAccountIds: readonly string[];
  }>;
}>;
export type SessionDiscussionPostMutationRequestBodyInputV1 = Readonly<{
  kind: 'post';
  localId: string;
  requestEqualityEvidenceV1?: SessionDiscussionE2eeEqualityEvidenceV1;
  content: StrictSessionStoredMessageContentEnvelope;
  mentionedAccountIds: readonly string[];
}>;
export type SessionDiscussionRenameMutationRequestBodyInputV1 = Readonly<{
  kind: 'rename';
  titleContent: StrictSessionStoredMessageContentEnvelope;
}>;
export type SessionDiscussionMutationRequestBodyInputV1 =
  | SessionDiscussionCreateMutationRequestBodyInputV1
  | SessionDiscussionPostMutationRequestBodyInputV1
  | SessionDiscussionRenameMutationRequestBodyInputV1;

/**
 * Builds the final post-sealing body accepted by the Discussion storage route.
 *
 * Stateful callers own identity generation and retry custody; crypto owners
 * seal content and derive optional E2EE equality evidence. This pure boundary
 * owns only the exact HTTP field placement and strict route-schema validation,
 * so UI, CLI and plugin/SDK hosts cannot drift into similar-but-different wire
 * bodies.
 */
export function buildSessionDiscussionMutationRequestBodyV1(
  input: SessionDiscussionCreateMutationRequestBodyInputV1,
): SessionDiscussionCreateRequestV1;
export function buildSessionDiscussionMutationRequestBodyV1(
  input: SessionDiscussionPostMutationRequestBodyInputV1,
): SessionDiscussionPostRequestV1;
export function buildSessionDiscussionMutationRequestBodyV1(
  input: SessionDiscussionRenameMutationRequestBodyInputV1,
): SessionDiscussionRenameRequestV1;
export function buildSessionDiscussionMutationRequestBodyV1(
  input: SessionDiscussionMutationRequestBodyInputV1,
): SessionDiscussionCreateRequestV1 | SessionDiscussionPostRequestV1 | SessionDiscussionRenameRequestV1 {
  if (input.kind === 'create') {
    return SessionDiscussionCreateRequestV1Schema.parse({
      creationLocalId: input.creationLocalId,
      ...(input.creationEqualityEvidenceV1
        ? { creationEqualityEvidenceV1: input.creationEqualityEvidenceV1 }
        : {}),
      titleContent: input.titleContent,
      firstMessage: {
        localId: input.firstMessage.localId,
        ...(input.firstMessage.requestEqualityEvidenceV1
          ? { requestEqualityEvidenceV1: input.firstMessage.requestEqualityEvidenceV1 }
          : {}),
        content: input.firstMessage.content,
        mentionedAccountIds: [...input.firstMessage.mentionedAccountIds],
      },
    });
  }
  if (input.kind === 'post') {
    return SessionDiscussionPostRequestV1Schema.parse({
      localId: input.localId,
      ...(input.requestEqualityEvidenceV1
        ? { requestEqualityEvidenceV1: input.requestEqualityEvidenceV1 }
        : {}),
      content: input.content,
      mentionedAccountIds: [...input.mentionedAccountIds],
    });
  }
  return SessionDiscussionRenameRequestV1Schema.parse({
    titleContent: input.titleContent,
  });
}

export const SessionDiscussionReadRequestV1Schema = lazyZodSchema(() => z.object({
  lastReadSeq: z.number().int().min(0),
}).strict());
export type SessionDiscussionReadRequestV1 = z.infer<typeof SessionDiscussionReadRequestV1Schema>;

export const SessionDiscussionDetailsResponseV1Schema = lazyZodSchema(() => z.object({
  discussion: SessionDiscussionSummaryV1Schema,
}).strict());
export type SessionDiscussionDetailsResponseV1 = z.infer<typeof SessionDiscussionDetailsResponseV1Schema>;

export const SessionDiscussionCreateResponseV1Schema = lazyZodSchema(() => z.object({
  discussion: SessionDiscussionSummaryV1Schema,
  firstMessage: SessionDiscussionMessageV1Schema,
}).strict());
export type SessionDiscussionCreateResponseV1 = z.infer<typeof SessionDiscussionCreateResponseV1Schema>;

export const SessionDiscussionPostResponseV1Schema = lazyZodSchema(() => z.object({
  message: SessionDiscussionMessageV1Schema,
  messageSeq: z.number().int().min(1),
}).strict());
export type SessionDiscussionPostResponseV1 = z.infer<typeof SessionDiscussionPostResponseV1Schema>;

export const SessionDiscussionAgentPostResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    v: z.literal(1),
    value: SessionDiscussionPostResponseV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    v: z.literal(1),
    error: SessionDiscussionErrorCodeV1Schema,
  }).strict(),
]));
export type SessionDiscussionAgentPostResponseV1 = z.infer<typeof SessionDiscussionAgentPostResponseV1Schema>;

export const SessionDiscussionReadResponseV1Schema = SessionDiscussionReadCursorV1Schema;
export type SessionDiscussionReadResponseV1 = z.infer<typeof SessionDiscussionReadResponseV1Schema>;

export { SessionDiscussionAttentionFactsV1Schema };

/**
 * The complete create/post request has to fit the transport that actually
 * serves it. This validates the whole encoded body against the canonical
 * server request-body owner instead of independent title/text/part/mention
 * maxima that cannot fit together.
 */
export function readSessionDiscussionRequestUtf8ByteLengthV1(body: unknown): number {
  return readServerHttpRequestBodyUtf8ByteLengthV1(body);
}

export function isSessionDiscussionRequestWithinTransportBudgetV1(body: unknown): boolean {
  const bytes = readServerHttpRequestBodyUtf8ByteLengthV1(body);
  return Number.isFinite(bytes) && bytes <= SESSION_DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1;
}

/**
 * Discussions do not narrow the API server's request-body ceiling. Their
 * accepted content range is exactly what the serving transport admits.
 */
export const SESSION_DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1 = SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1;

export const SessionDiscussionRouteParamsV1Schema = lazyZodSchema(() => z.object({
  sessionId: SessionDiscussionIdSchema,
}).strict());

export const SessionDiscussionRouteDiscussionParamsV1Schema = lazyZodSchema(() => z.object({
  sessionId: SessionDiscussionIdSchema,
  discussionId: SessionDiscussionIdSchema,
}).strict());
