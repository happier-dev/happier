import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  SessionDiscussionAccountIdSchema,
  SessionDiscussionIdSchema,
  SessionDiscussionLocalIdSchema,
  SessionDiscussionMessageContentV1Schema,
  SessionDiscussionTitleV1Schema,
} from '../../sessions/discussions/content.js';
import { actionCliDerivedDefault, type ActionCliBindContext, type ActionCliProjection } from '../actionCliProjection.js';
import type { ActionInputHints } from '../metadata.js';

const SessionSelectorSchema = lazyZodSchema(() => z.string().trim().min(1));
const MentionedAccountIdsSchema = lazyZodSchema(() => z.array(SessionDiscussionAccountIdSchema).refine(
  (value) => new Set(value).size === value.length,
  'Mentioned Account ids must be deduplicated',
));
const AuthoredTextSchema = lazyZodSchema(() => z.string().refine((value) => value.trim().length > 0, {
  message: 'message must not be blank',
}));

/**
 * The friendly create spelling is intentionally a scalar projection. The
 * canonical Action still owns the structured content schema and validates the
 * bound document; argv parsing never becomes another discussion input model.
 */
export const SessionDiscussionCreateCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  title: AuthoredTextSchema,
  message: AuthoredTextSchema,
  mentionedAccountIds: MentionedAccountIdsSchema.optional(),
  creationLocalId: SessionDiscussionLocalIdSchema.optional(),
  messageLocalId: SessionDiscussionLocalIdSchema.optional(),
}).strict());
export type SessionDiscussionCreateCliInput = z.infer<typeof SessionDiscussionCreateCliInputSchema>;

export const SessionDiscussionPostCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  discussionId: SessionDiscussionIdSchema,
  message: AuthoredTextSchema,
  mentionedAccountIds: MentionedAccountIdsSchema.optional(),
  localId: SessionDiscussionLocalIdSchema.optional(),
}).strict());
export type SessionDiscussionPostCliInput = z.infer<typeof SessionDiscussionPostCliInputSchema>;

export const SessionDiscussionRenameCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  discussionId: SessionDiscussionIdSchema,
  title: AuthoredTextSchema,
}).strict());
export type SessionDiscussionRenameCliInput = z.infer<typeof SessionDiscussionRenameCliInputSchema>;

function normalizeAuthoredCliText(value: string): string {
  return value.normalize('NFC');
}

function textContent(text: string) {
  return SessionDiscussionMessageContentV1Schema.parse({
    v: 1,
    parts: [{ t: 'text', text: normalizeAuthoredCliText(text) }],
  });
}

export function bindSessionDiscussionCreateCliInput(
  value: Readonly<Partial<SessionDiscussionCreateCliInput>>,
  context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  // Over canonical whole-input JSON this binder sees only the caller fields the
  // caller actually typed, so each projection is conditional on its source: the
  // first message exists exactly when the caller authored one.
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    creationLocalId: value.creationLocalId ?? actionCliDerivedDefault(`discussion-${context.invocationId}`),
    ...(value.title === undefined ? {} : {
      title: SessionDiscussionTitleV1Schema.shape.title.parse(normalizeAuthoredCliText(value.title)),
    }),
    ...(value.message === undefined ? {} : {
      firstMessage: {
        localId: value.messageLocalId ?? `message-${context.invocationId}`,
        content: textContent(value.message),
        mentionedAccountIds: value.mentionedAccountIds ?? [],
      },
    }),
  };
}

export function bindSessionDiscussionRenameCliInput(
  value: Readonly<Partial<SessionDiscussionRenameCliInput>>,
): Readonly<Record<string, unknown>> {
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.discussionId === undefined ? {} : { discussionId: value.discussionId }),
    ...(value.title === undefined ? {} : {
      title: SessionDiscussionTitleV1Schema.shape.title.parse(normalizeAuthoredCliText(value.title)),
    }),
  };
}

export function bindSessionDiscussionPostCliInput(
  value: Readonly<Partial<SessionDiscussionPostCliInput>>,
  context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.discussionId === undefined ? {} : { discussionId: value.discussionId }),
    localId: value.localId ?? actionCliDerivedDefault(context.invocationId),
    ...(value.message === undefined ? {} : { content: textContent(value.message) }),
    mentionedAccountIds: value.mentionedAccountIds ?? actionCliDerivedDefault([]),
  };
}

const CREATE_HINTS: ActionInputHints = {
  title: 'Start a discussion',
  fields: [
    { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
    { path: 'title', title: 'Discussion title', widget: 'text', required: true },
    { path: 'message', title: 'First message', widget: 'textarea', required: true },
    { path: 'mentionedAccountIds', title: 'Mentioned Account id', widget: 'text_list', listSeparator: 'comma' },
    { path: 'creationLocalId', title: 'Durable discussion identity for retry', widget: 'text' },
    { path: 'messageLocalId', title: 'Durable first-message identity for retry', widget: 'text' },
  ],
};

const POST_HINTS: ActionInputHints = {
  title: 'Post to a discussion',
  fields: [
    { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
    { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
    { path: 'message', title: 'Message', widget: 'textarea', required: true },
    { path: 'mentionedAccountIds', title: 'Mentioned Account id', widget: 'text_list', listSeparator: 'comma' },
    { path: 'localId', title: 'Durable message identity for retry', widget: 'text' },
  ],
};

export const SESSION_DISCUSSION_LIST_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'discussions', 'list'], positionals: ['sessionId'], visibility: 'canonical' }],
};

export const SESSION_DISCUSSION_GET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'discussions', 'show'], positionals: ['sessionId', 'discussionId'], visibility: 'canonical' }],
};

export const SESSION_DISCUSSION_READ_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'discussions', 'read'], positionals: ['sessionId', 'discussionId'], visibility: 'canonical' }],
};

export const SESSION_DISCUSSION_CREATE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'discussions', 'create'],
    positionals: ['sessionId', 'title', 'message'],
    visibility: 'canonical',
  }],
  inputSchema: SessionDiscussionCreateCliInputSchema,
  inputHints: CREATE_HINTS,
  bindInput: (value, context) => bindSessionDiscussionCreateCliInput(
    value as Partial<SessionDiscussionCreateCliInput>,
    context,
  ),
};

export const SESSION_DISCUSSION_POST_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'discussions', 'post'],
    positionals: ['sessionId', 'discussionId', 'message'],
    visibility: 'canonical',
  }],
  inputSchema: SessionDiscussionPostCliInputSchema,
  inputHints: POST_HINTS,
  bindInput: (value, context) => bindSessionDiscussionPostCliInput(
    value as Partial<SessionDiscussionPostCliInput>,
    context,
  ),
};

export const SESSION_DISCUSSION_RENAME_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'discussions', 'rename'],
    positionals: ['sessionId', 'discussionId', 'title'],
    visibility: 'canonical',
  }],
  inputSchema: SessionDiscussionRenameCliInputSchema,
  inputHints: {
    title: 'Rename a discussion',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'title', title: 'Discussion title', widget: 'text', required: true },
    ],
  },
  bindInput: (value) => bindSessionDiscussionRenameCliInput(value as Partial<SessionDiscussionRenameCliInput>),
};

export const SESSION_DISCUSSION_ARCHIVE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'discussions', 'archive'], positionals: ['sessionId', 'discussionId'], visibility: 'canonical' }],
};

export const SESSION_DISCUSSION_RESTORE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'discussions', 'restore'], positionals: ['sessionId', 'discussionId'], visibility: 'canonical' }],
};

export const SESSION_DISCUSSION_READ_STATE_SET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'discussions', 'read-state'],
    positionals: ['sessionId', 'discussionId', 'lastReadSeq'],
    visibility: 'canonical',
  }],
};
