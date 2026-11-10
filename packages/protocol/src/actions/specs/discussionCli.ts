import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  DiscussionAccountIdSchema,
  DiscussionIdSchema,
  DiscussionLocalIdSchema,
  DiscussionMessageContentV1Schema,
  DiscussionTitleV1Schema,
} from '../../discussions/content.js';
import { actionCliDerivedDefault, type ActionCliBindContext, type ActionCliProjection } from '../actionCliProjection.js';
import type { ActionInputHints } from '../metadata.js';

const MentionedAccountIdsSchema = lazyZodSchema(() => z.array(DiscussionAccountIdSchema).check(z.refine((value) => new Set(value).size === value.length, 'Mentioned Account ids must be deduplicated')));
const AuthoredTextSchema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, {
  message: 'message must not be blank',
})));

/**
 * The friendly create spelling is intentionally a scalar projection. The
 * canonical Action still owns the structured content schema and validates the
 * bound document; argv parsing never becomes another discussion input model.
 */
export const DiscussionCreateCliInputSchema = lazyZodSchema(() => z.strictObject({
  title: AuthoredTextSchema,
  message: AuthoredTextSchema,
  mentionedAccountIds: z.optional(MentionedAccountIdsSchema),
  creationLocalId: z.optional(DiscussionLocalIdSchema),
  messageLocalId: z.optional(DiscussionLocalIdSchema),
}));
export type DiscussionCreateCliInput = z.infer<typeof DiscussionCreateCliInputSchema>;

export const DiscussionPostCliInputSchema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  message: AuthoredTextSchema,
  mentionedAccountIds: z.optional(MentionedAccountIdsSchema),
  localId: z.optional(DiscussionLocalIdSchema),
}));
export type DiscussionPostCliInput = z.infer<typeof DiscussionPostCliInputSchema>;

export const DiscussionRenameCliInputSchema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  title: AuthoredTextSchema,
}));
export type DiscussionRenameCliInput = z.infer<typeof DiscussionRenameCliInputSchema>;

function normalizeAuthoredCliText(value: string): string {
  return value.normalize('NFC');
}

function textContent(text: string) {
  return DiscussionMessageContentV1Schema.parse({
    v: 1,
    parts: [{ t: 'text', text: normalizeAuthoredCliText(text) }],
  });
}

export function bindDiscussionCreateCliInput(
  value: Readonly<Partial<DiscussionCreateCliInput>>,
  context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  // Over canonical whole-input JSON this binder sees only the caller fields the
  // caller actually typed, so each projection is conditional on its source: the
  // first message exists exactly when the caller authored one.
  return {
    creationLocalId: value.creationLocalId ?? actionCliDerivedDefault(`discussion-${context.invocationId}`),
    ...(value.title === undefined ? {} : {
      title: DiscussionTitleV1Schema.shape.title.parse(normalizeAuthoredCliText(value.title)),
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

export function bindDiscussionRenameCliInput(
  value: Readonly<Partial<DiscussionRenameCliInput>>,
): Readonly<Record<string, unknown>> {
  return {
    ...(value.discussionId === undefined ? {} : { discussionId: value.discussionId }),
    ...(value.title === undefined ? {} : {
      title: DiscussionTitleV1Schema.shape.title.parse(normalizeAuthoredCliText(value.title)),
    }),
  };
}

export function bindDiscussionPostCliInput(
  value: Readonly<Partial<DiscussionPostCliInput>>,
  context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  return {
    ...(value.discussionId === undefined ? {} : { discussionId: value.discussionId }),
    localId: value.localId ?? actionCliDerivedDefault(context.invocationId),
    ...(value.message === undefined ? {} : { content: textContent(value.message) }),
    mentionedAccountIds: value.mentionedAccountIds ?? actionCliDerivedDefault([]),
  };
}

const CREATE_HINTS: ActionInputHints = {
  title: 'Start a discussion',
  fields: [
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
    { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
    { path: 'message', title: 'Message', widget: 'textarea', required: true },
    { path: 'mentionedAccountIds', title: 'Mentioned Account id', widget: 'text_list', listSeparator: 'comma' },
    { path: 'localId', title: 'Durable message identity for retry', widget: 'text' },
  ],
};

export const DISCUSSION_LIST_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['discussions', 'list'], positionals: [], visibility: 'canonical' }],
};

export const DISCUSSION_GET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['discussions', 'show'], positionals: ['discussionId'], visibility: 'canonical' }],
};

export const DISCUSSION_READ_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['discussions', 'read'], positionals: ['discussionId'], visibility: 'canonical' }],
};

export const DISCUSSION_CREATE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['discussions', 'create'],
    positionals: ['title', 'message'],
    visibility: 'canonical',
  }],
  inputSchema: DiscussionCreateCliInputSchema,
  inputHints: CREATE_HINTS,
  bindInput: (value, context) => bindDiscussionCreateCliInput(
    value as Partial<DiscussionCreateCliInput>,
    context,
  ),
};

export const DISCUSSION_POST_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['discussions', 'post'],
    positionals: ['discussionId', 'message'],
    visibility: 'canonical',
  }],
  inputSchema: DiscussionPostCliInputSchema,
  inputHints: POST_HINTS,
  bindInput: (value, context) => bindDiscussionPostCliInput(
    value as Partial<DiscussionPostCliInput>,
    context,
  ),
};

export const DISCUSSION_RENAME_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['discussions', 'rename'],
    positionals: ['discussionId', 'title'],
    visibility: 'canonical',
  }],
  inputSchema: DiscussionRenameCliInputSchema,
  inputHints: {
    title: 'Rename a discussion',
    fields: [
      { path: 'discussionId', title: 'Discussion id', widget: 'text', required: true },
      { path: 'title', title: 'Discussion title', widget: 'text', required: true },
    ],
  },
  bindInput: (value) => bindDiscussionRenameCliInput(value as Partial<DiscussionRenameCliInput>),
};

export const DISCUSSION_ARCHIVE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['discussions', 'archive'], positionals: ['discussionId'], visibility: 'canonical' }],
};

export const DISCUSSION_RESTORE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['discussions', 'restore'], positionals: ['discussionId'], visibility: 'canonical' }],
};

export const DISCUSSION_READ_STATE_SET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['discussions', 'read-state'],
    positionals: ['discussionId', 'lastReadSeq'],
    visibility: 'canonical',
  }],
};
