import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  SESSION_LIST_PAGE_MAX_LIMIT,
  SessionListQueryV1Schema,
  SessionListScopeV1Schema,
  SessionBotFilterV1Schema,
  type SessionAudienceSelectionV1,
} from '../../sessions/listing/query.js';
import {
  SESSION_LIST_AWARENESS_VIEW_V1,
  SESSION_LIST_SUMMARY_VIEW_V1,
  SessionListViewV1Schema,
} from '../../sessions/awareness/action.js';
import { actionCliDerivedDefault, type ActionCliBindContext, type ActionCliProjection } from '../actionCliProjection.js';

const SelectorSchema = lazyZodSchema(() => z.string().trim().min(1));
const GroupSelectorSchema = lazyZodSchema(() => SelectorSchema.refine((value) => {
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => part.trim().length > 0);
}, { message: 'Expected <teamId>/<groupId>' }));

/**
 * The established friendly `session list` grammar. Canonical fields stay
 * available, while scalar audience flags are projected into the one Lane 07
 * query instead of teaching the CLI how to filter Session rows itself.
 */
export const SessionListCliInputSchema = lazyZodSchema(() => z.object({
  query: SessionListQueryV1Schema.optional(),
  underSessionId: SelectorSchema.optional(),
  view: SessionListViewV1Schema.optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  attentionCursor: z.string().min(1).optional(),
  includeLastMessagePreview: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  archivedOnly: z.boolean().optional(),
  includeSystem: z.boolean().optional(),
  resumableOnly: z.boolean().optional(),
  scope: SessionListScopeV1Schema.optional(),
  bot: SessionBotFilterV1Schema.optional(),
  team: z.array(SelectorSchema).optional(),
  group: z.array(GroupSelectorSchema).optional(),
  outsideTeams: z.boolean().optional(),
  tag: z.array(SelectorSchema).optional(),
  attention: z.boolean().optional(),
  includeInactive: z.boolean().optional(),
  awareness: z.boolean().optional(),
  /** Presentation-only compatibility flag; never reaches the Action. */
  plain: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.activeOnly && value.archivedOnly) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['archivedOnly'], message: 'active and archived cannot be combined' });
  }
  if (value.cursor !== undefined && value.attentionCursor !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attentionCursor'], message: 'cursor and attentionCursor cannot be combined' });
  }
  if (value.view !== undefined && value.awareness !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['awareness'], message: 'view and awareness cannot be combined' });
  }
  const querySelectors = [
    value.underSessionId,
    value.scope,
    value.bot,
    value.team,
    value.group,
    value.outsideTeams,
    value.tag,
    value.attention,
    value.includeInactive,
    value.attentionCursor,
  ].some((entry) => entry !== undefined && entry !== false);
  if (
    value.query === undefined
    && querySelectors
    && value.limit !== undefined
    && value.limit > SESSION_LIST_PAGE_MAX_LIMIT
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['limit'],
      message: `limit must be at most ${SESSION_LIST_PAGE_MAX_LIMIT} for a canonical query`,
    });
  }
  if (value.query !== undefined && querySelectors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: 'query cannot be combined with friendly query selectors' });
  }
  if (value.query !== undefined) {
    for (const field of ['limit', 'cursor', 'activeOnly', 'archivedOnly', 'resumableOnly'] as const) {
      if (value[field] !== undefined && value[field] !== false) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} cannot be combined with query` });
      }
    }
  }
  if ((value.query !== undefined || querySelectors) && (value.activeOnly || value.resumableOnly)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeOnly'], message: 'active/resumable cannot be combined with a canonical query' });
  }
}));
export type SessionListCliInput = z.infer<typeof SessionListCliInputSchema>;

function parseGroupSelector(value: string): SessionAudienceSelectionV1 {
  const [teamId, groupId] = value.split('/');
  return { kind: 'group', teamId: teamId!.trim(), groupId: groupId!.trim() };
}

export function bindSessionListCliInput(
  value: SessionListCliInput,
  context?: Pick<ActionCliBindContext, 'output'>,
): Readonly<Record<string, unknown>> {
  const hasFriendlyQuery = [
    value.underSessionId,
    value.scope,
    value.bot,
    value.team,
    value.group,
    value.outsideTeams,
    value.tag,
    value.attention,
    value.includeInactive,
    value.attentionCursor,
  ].some((entry) => entry !== undefined && entry !== false);
  const audiences: SessionAudienceSelectionV1[] = [
    ...(value.team ?? []).map((teamId) => ({ kind: 'team' as const, teamId })),
    ...(value.group ?? []).map(parseGroupSelector),
    ...(value.outsideTeams ? [{ kind: 'outside_teams' as const }] : []),
  ];
  const query = value.query ?? (hasFriendlyQuery
    ? SessionListQueryV1Schema.parse({
        v: 1,
        storage: value.archivedOnly ? 'archived' : 'active',
        includeInactive: value.includeInactive ?? (value.underSessionId !== undefined),
        scope: value.scope ?? (audiences.length > 0 || value.underSessionId ? 'all_accessible' : 'my_work'),
        attention: value.attention ? 'needs_my_attention' : 'any',
        ...(value.bot === undefined ? {} : { bot: value.bot }),
        audiences,
        tagIds: value.tag ?? [],
        ...(value.underSessionId === undefined ? {} : { underSessionId: value.underSessionId }),
        ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
        ...(value.attentionCursor === undefined ? {} : { attentionCursor: value.attentionCursor }),
        ...(value.limit === undefined ? {} : { limit: value.limit }),
      })
    : undefined);

  return {
    ...(query === undefined ? {} : { query }),
    ...(query === undefined && value.activeOnly ? { activeOnly: true } : {}),
    ...(query === undefined && value.archivedOnly ? { archivedOnly: true } : {}),
    ...(value.includeSystem ? { includeSystem: true } : {}),
    ...(query === undefined && value.resumableOnly ? { resumableOnly: true } : {}),
    ...(query === undefined && value.limit !== undefined
      ? { limit: Math.min(value.limit, SESSION_LIST_PAGE_MAX_LIMIT) }
      : {}),
    ...(query === undefined && value.cursor !== undefined ? { cursor: value.cursor } : {}),
    ...(value.includeLastMessagePreview === undefined ? {} : { includeLastMessagePreview: value.includeLastMessagePreview }),
    ...(context?.output === 'human' ? { includeRows: actionCliDerivedDefault(true) } : {}),
    ...((value.awareness || value.view === SESSION_LIST_AWARENESS_VIEW_V1)
      ? { view: SESSION_LIST_AWARENESS_VIEW_V1 }
      : {}),
  };
}

export const SESSION_LIST_CLI_PROJECTION: ActionCliProjection = {
  commands: [
    { path: ['session', 'list'], visibility: 'canonical' },
    { path: ['list'], visibility: 'alias' },
    { path: ['ls'], visibility: 'alias' },
  ],
  acceptsServerId: true,
  requestTimeout: 'session_control',
  inputSchema: SessionListCliInputSchema,
  inputHints: {
    title: 'List sessions',
    fields: [
      { path: 'query', title: 'Canonical Session query', widget: 'json' },
      { path: 'underSessionId', title: 'Session led subtree', widget: 'text' },
      { path: 'view', title: 'Result view', widget: 'select', options: [{ value: SESSION_LIST_SUMMARY_VIEW_V1, label: 'Summary' }, { value: SESSION_LIST_AWARENESS_VIEW_V1, label: 'Awareness' }] },
      { path: 'limit', title: 'Maximum sessions', widget: 'text' },
      { path: 'cursor', title: 'Ordinary continuation cursor', widget: 'text' },
      { path: 'attentionCursor', title: 'Attention continuation cursor', widget: 'text' },
      { path: 'scope', title: 'Session scope', widget: 'select', options: SessionListScopeV1Schema.options.map((option) => ({ value: option, label: option })) },
      { path: 'bot', title: 'Session identity', widget: 'select', options: [{ value: 'bot', label: 'Bot' }, { value: 'ordinary', label: 'Ordinary Session' }] },
      { path: 'team', title: 'Team selector', widget: 'text_list', listSeparator: 'comma' },
      { path: 'group', title: 'Group selector as team/group', widget: 'text_list', listSeparator: 'comma' },
      { path: 'tag', title: 'Tag selector', widget: 'text_list', listSeparator: 'comma' },
      { path: 'outsideTeams', title: 'Outside Teams', widget: 'boolean' },
      { path: 'attention', title: 'Needs my attention', widget: 'boolean' },
      { path: 'includeInactive', title: 'Include inactive sessions', widget: 'boolean' },
      { path: 'activeOnly', title: 'Active sessions only', widget: 'boolean' },
      { path: 'archivedOnly', title: 'Archived sessions only', widget: 'boolean' },
      { path: 'includeSystem', title: 'Include system sessions', widget: 'boolean' },
      { path: 'resumableOnly', title: 'Resumable sessions only', widget: 'boolean' },
      { path: 'includeLastMessagePreview', title: 'Include last-message preview', widget: 'boolean' },
      { path: 'awareness', title: 'Awareness view', widget: 'boolean' },
      { path: 'plain', title: 'Plain one-line output', widget: 'boolean' },
    ],
  },
  flagAliases: [
    { path: 'activeOnly', aliases: ['--active'] },
    { path: 'archivedOnly', aliases: ['--archived'] },
    { path: 'resumableOnly', aliases: ['--resumable'] },
  ],
  bindInput: (value, context) => bindSessionListCliInput(value as SessionListCliInput, context),
};
