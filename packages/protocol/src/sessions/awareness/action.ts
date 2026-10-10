import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { SessionListResultSchema, SessionListMetadataUpgradeRequiredCountSchema, SessionListBotFilterUnavailableCountSchema } from '../control/listResult.js';

import {
  SESSION_AWARENESS_PROJECTION_VERSION_V1,
  SessionAwarenessProjectionV1Schema,
  type SessionAwarenessProjectionV1,
} from './projectionV1.js';

/**
 * The `session.list` representation selector and its MARKED result (Lane 09A, AWR-04/AWI-08/09).
 *
 * `view` is an optional input, so a host that predates awareness silently ignores it and answers
 * with an ordinary Session summary list. That is exactly the false-success hazard this module
 * exists to close: the marker below is mandatory in the response, so a caller that asked for
 * awareness and did not get the marker reports `awareness_view_unsupported` instead of projecting
 * a summary locally and claiming success.
 */
export const SESSION_LIST_AWARENESS_VIEW_V1 = 'awareness' as const;
export const SESSION_LIST_SUMMARY_VIEW_V1 = 'summary' as const;
/**
 * Proves that a `session.list` Action host applied the strict query carried by the request.
 * This is a result marker, not a feature capability or endpoint-admission decision.
 */
export const SESSION_LIST_QUERY_RESULT_VERSION_V1 = 1 as const;

export const SessionListViewV1Schema = lazyZodSchema(() => z.enum([
  SESSION_LIST_SUMMARY_VIEW_V1,
  SESSION_LIST_AWARENESS_VIEW_V1,
]));
export type SessionListViewV1 = z.infer<typeof SessionListViewV1Schema>;

/** The typed unsupported-view failure every awareness caller must be able to distinguish. */
export const SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE = 'awareness_view_unsupported' as const;
export const SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE = 'session_list_query_update_required' as const;

/**
 * This is the exact payload inside an Action success envelope. The envelope's `ok` marker is not
 * part of awareness itself; accepting it here would create a second flattened result shape.
 * Everything stays strict: an unread count or any other viewer-personal field smuggled beside
 * awareness is a contract violation (AWI-17).
 *
 * Lane 07's attention continuation is independent from ordinary continuation, not from the
 * requested representation. Strict-query summary and awareness results preserve both families;
 * predecessor/no-query awareness results may omit the attention pair together.
 */
const SessionListAttentionContinuationFieldsV1 = {
  attentionNextCursor: z.string().min(1).nullable().optional(),
  attentionHasNext: z.boolean().optional(),
} as const;

const SessionListActionResultMarkerFieldsV1 = {
  queryVersion: z.literal(SESSION_LIST_QUERY_RESULT_VERSION_V1).optional(),
  metadataUpgradeRequiredCount: SessionListMetadataUpgradeRequiredCountSchema.optional(),
  botFilterUnavailableCount: SessionListBotFilterUnavailableCountSchema.optional(),
  ...SessionListAttentionContinuationFieldsV1,
} as const;

function requireAttentionContinuationPair(
  value: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
): void {
  const hasAttentionCursor = Object.hasOwn(value, 'attentionNextCursor');
  const hasAttentionFlag = Object.hasOwn(value, 'attentionHasNext');
  if (hasAttentionCursor !== hasAttentionFlag) {
    context.addIssue({
      code: 'custom',
      message: 'attentionNextCursor and attentionHasNext must be provided together',
    });
  }
}

function requireQueryMarkedAttentionContinuation(
  value: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
): void {
  requireAttentionContinuationPair(value, context);
  if (
    Object.hasOwn(value, 'queryVersion')
    && !Object.hasOwn(value, 'attentionNextCursor')
    && !Object.hasOwn(value, 'attentionHasNext')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A query-marked result must include attentionNextCursor and attentionHasNext',
    });
  }
}

type SessionListAttentionContinuationInputV1 =
  | SessionListRequiredAttentionContinuationInputV1
  | Readonly<{
      attentionNextCursor?: never;
      attentionHasNext?: never;
    }>;

type SessionListRequiredAttentionContinuationInputV1 = Readonly<{
  attentionNextCursor: string | null;
  attentionHasNext: boolean;
}>;

const SessionListRequiredAttentionContinuationFieldsV1Schema = lazyZodSchema(() => z.object({
  attentionNextCursor: SessionListAttentionContinuationFieldsV1.attentionNextCursor.unwrap(),
  attentionHasNext: SessionListAttentionContinuationFieldsV1.attentionHasNext.unwrap(),
}).passthrough());

export const SessionAwarenessListResultV1Schema = lazyZodSchema(() => z.object({
    view: z.literal(SESSION_LIST_AWARENESS_VIEW_V1),
    projectionVersion: z.literal(SESSION_AWARENESS_PROJECTION_VERSION_V1),
    sessions: z.array(SessionAwarenessProjectionV1Schema),
    nextCursor: z.string().min(1).nullable(),
    hasNext: z.boolean(),
    metadataUpgradeRequiredCount: SessionListMetadataUpgradeRequiredCountSchema.optional(),
    botFilterUnavailableCount: SessionListBotFilterUnavailableCountSchema.optional(),
    ...SessionListAttentionContinuationFieldsV1,
  })
  .strict()
  .superRefine(requireAttentionContinuationPair));
export type SessionAwarenessListResultV1 = Readonly<
  Omit<z.infer<typeof SessionAwarenessListResultV1Schema>, 'sessions'> & {
    sessions: readonly SessionAwarenessProjectionV1[];
  }
>;

// Released UI hosts return a smaller summary than CLI hosts. Keep that read seam separate
// from awareness, including its optional retained-window preview and qualified display context.
const LegacyUiSessionListResultSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true).optional(),
  sessions: z.array(z.object({
    id: z.string().min(1),
    active: z.boolean(),
    presence: z.string().nullable(),
    updatedAt: z.number().nonnegative(),
    title: z.string().optional(),
    locationLabel: z.string().optional(),
    serverId: z.string().optional(),
    serverName: z.string().optional(),
    lastMessagePreview: z.object({
      role: z.string(), text: z.string(), createdAt: z.number().nullable(),
    }).optional(),
  })),
  nextCursor: z.string().nullable(),
  hasNext: z.boolean().optional(),
}).passthrough());

const SummarySessionListActionResultSchema = lazyZodSchema(() => z.union([
  SessionListResultSchema,
  LegacyUiSessionListResultSchema,
]).and(z.object({
  ...SessionListActionResultMarkerFieldsV1,
}).passthrough()).superRefine((value, context) => {
  if (Object.hasOwn(value, 'view') || Object.hasOwn(value, 'projectionVersion')) {
    context.addIssue({ code: 'custom', message: 'A marked result must satisfy the awareness contract' });
  }
  requireQueryMarkedAttentionContinuation(value, context);
}));

export const SessionListActionResultV1Schema = lazyZodSchema(() => z.union([
  SessionAwarenessListResultV1Schema,
  SummarySessionListActionResultSchema,
]));

/**
 * The conditional result contract for the non-ignorable strict `query` input. An older
 * passthrough host can accept the input while silently dropping it, so the marker is mandatory
 * before any current consumer may read the returned rows.
 */
export const SessionListQueryActionResultV1Schema = lazyZodSchema(() => z.union([
  // Awareness did not exist before the strict query host. Its closed representation marker is
  // therefore the proof for this branch; adding `queryVersion` would create a second marker.
  // Unlike predecessor/no-query awareness, a strict query must prove both page families.
  SessionAwarenessListResultV1Schema.and(z.object({
    attentionNextCursor: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionNextCursor,
    attentionHasNext: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionHasNext,
  }).passthrough()),
  SummarySessionListActionResultSchema.and(z.object({
    queryVersion: z.literal(SESSION_LIST_QUERY_RESULT_VERSION_V1),
    attentionNextCursor: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionNextCursor,
    attentionHasNext: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionHasNext,
  }).passthrough()),
]));
export type SessionListQueryActionResultV1 = Readonly<z.infer<typeof SessionListQueryActionResultV1Schema>>;

export function markSessionListQueryResultV1<
  T extends Readonly<Record<string, unknown>> & SessionListRequiredAttentionContinuationInputV1,
>(
  result: T,
): T & Readonly<{ queryVersion: typeof SESSION_LIST_QUERY_RESULT_VERSION_V1 }> {
  SessionListRequiredAttentionContinuationFieldsV1Schema.parse(result);
  return { ...result, queryVersion: SESSION_LIST_QUERY_RESULT_VERSION_V1 };
}

export function parseSessionListQueryActionResultV1(value: unknown): SessionListQueryActionResultV1 | null {
  const parsed = SessionListQueryActionResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildSessionAwarenessListResultV1(params: Readonly<{
  sessions: readonly SessionAwarenessProjectionV1[];
  nextCursor: string | null;
  hasNext: boolean;
  metadataUpgradeRequiredCount?: number;
  botFilterUnavailableCount?: number;
}> & SessionListAttentionContinuationInputV1): SessionAwarenessListResultV1 {
  return {
    view: SESSION_LIST_AWARENESS_VIEW_V1,
    projectionVersion: SESSION_AWARENESS_PROJECTION_VERSION_V1,
    sessions: params.sessions,
    nextCursor: params.nextCursor,
    hasNext: params.hasNext,
    ...(params.metadataUpgradeRequiredCount !== undefined
      ? { metadataUpgradeRequiredCount: params.metadataUpgradeRequiredCount }
      : {}),
    ...(params.botFilterUnavailableCount !== undefined
      ? { botFilterUnavailableCount: params.botFilterUnavailableCount }
      : {}),
    ...(params.attentionNextCursor !== undefined && params.attentionHasNext !== undefined
      ? {
          attentionNextCursor: params.attentionNextCursor,
          attentionHasNext: params.attentionHasNext,
        }
      : {}),
  };
}

/** Returns the marked result, or `null` for anything a caller must not read as awareness. */
export function parseSessionAwarenessListResultV1(value: unknown): SessionAwarenessListResultV1 | null {
  const parsed = SessionAwarenessListResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The released `session.activity.get` response (`ui-web-v0.2.11` and the current `../0.2`
 * producer). Retained as a compatibility seam under the stable Action ID; the operational
 * booleans below are DERIVED from awareness so this stays an adapter, not a second status owner
 * (AWI-10).
 */
export const SessionActivityCompatibilityMessageCountsV1Schema = lazyZodSchema(() => z.object({
  total: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
}).strict());
export type SessionActivityCompatibilityMessageCountsV1 = Readonly<
  z.infer<typeof SessionActivityCompatibilityMessageCountsV1Schema>
>;

/**
 * Raw facts the host already holds. They are passed through verbatim — deriving them here would
 * recreate the projector this adapter is replacing.
 *
 * `messageCounts` counts only the messages the responding host currently retains locally. It is
 * an ancillary released field, never a whole-Session total, and is omitted rather than fabricated
 * as zero when the host has no retained window at all.
 *
 * `permissionRequestIds` follows the same rule for a different reason: a host that reads pending
 * COUNTS but never the agent state has no request identities at all. Answering `[]` there would
 * contradict `permissionRequired: true` and read to an approval caller as "nothing to approve",
 * so an unobserved identity set is omitted instead.
 */
export type SessionActivityCompatibilityFactsV1 = Readonly<{
  presence: string | null;
  active: boolean;
  thinking: boolean;
  updatedAt: number | null;
  permissionRequestIds?: readonly string[];
  messageCounts?: SessionActivityCompatibilityMessageCountsV1;
}>;

/** Exact successful shape emitted by the released UI host. */
export const SessionActivityCompatibilityUiResultV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  presence: z.string().nullable(),
  active: z.boolean(),
  thinking: z.boolean(),
  working: z.boolean(),
  blocked: z.boolean(),
  permissionRequired: z.boolean(),
  actionRequired: z.boolean(),
  updatedAt: z.number().nonnegative().nullable(),
  permissionRequestIds: z.array(z.string().min(1)).optional(),
  messageCounts: SessionActivityCompatibilityMessageCountsV1Schema.optional(),
  // The CLI/daemon released these numeric pending-fact fields. They remain compatibility facts;
  // operational meaning still comes only from the awareness projection above.
  pendingCount: z.number().int().nonnegative().optional(),
  pendingPermissionRequestCount: z.number().int().nonnegative().optional(),
  pendingUserActionRequestCount: z.number().int().nonnegative().optional(),
}).strict());

/**
 * Exact successful shape emitted by the released CLI host. It cannot observe the UI-only
 * presence/thinking/operational facts, so accepting it is a read adapter rather than permission
 * to fabricate those facts. This shape is present in both server-v0.2.11 and the moving 0.2
 * predecessor.
 */
export const SessionActivityCompatibilityCliResultV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  active: z.boolean(),
  updatedAt: z.number().nonnegative().nullable(),
  pendingCount: z.number().int().nonnegative(),
  pendingPermissionRequestCount: z.number().int().nonnegative(),
  pendingUserActionRequestCount: z.number().int().nonnegative(),
}).strict());

export const SessionActivityCompatibilityResultV1Schema = lazyZodSchema(() => z.union([
  SessionActivityCompatibilityUiResultV1Schema,
  SessionActivityCompatibilityCliResultV1Schema,
]));
export type SessionActivityCompatibilityUiResultV1 = Readonly<
  Omit<z.infer<typeof SessionActivityCompatibilityUiResultV1Schema>, 'permissionRequestIds'> & {
    permissionRequestIds?: readonly string[];
  }
>;
export type SessionActivityCompatibilityCliResultV1 = Readonly<
  z.infer<typeof SessionActivityCompatibilityCliResultV1Schema>
>;
export type SessionActivityCompatibilityResultV1 = Readonly<
  SessionActivityCompatibilityUiResultV1 | SessionActivityCompatibilityCliResultV1
>;

/**
 * What `session.activity.get` may answer. The same representation selector as `session.list`
 * chooses between them: omitted or `summary` keeps the released compatibility digest, while
 * `view: 'awareness'` answers with the canonical projection itself.
 *
 * The projection is its own marker. It carries `v: 1` and no `ok`, so a host that silently
 * ignores `view` and answers with its digest cannot be read as awareness — the same false-success
 * protection the marked list result provides (AWI-09), without a second single-Session envelope.
 */
export const SessionActivityActionResultV1Schema = lazyZodSchema(() => z.union([
  SessionAwarenessProjectionV1Schema,
  SessionActivityCompatibilityResultV1Schema,
]));
export type SessionActivityActionResultV1 = Readonly<
  SessionAwarenessProjectionV1 | SessionActivityCompatibilityResultV1
>;

export function projectSessionActivityCompatibilityV1(params: Readonly<{
  awareness: SessionAwarenessProjectionV1;
  facts: SessionActivityCompatibilityFactsV1;
}>): SessionActivityCompatibilityUiResultV1 {
  const reasons = params.awareness.operational.reasons;
  const permissionRequired = reasons.includes('permission_required');
  const actionRequired = reasons.includes('action_required');
  return {
    ok: true,
    sessionId: params.awareness.sessionId,
    presence: params.facts.presence,
    active: params.facts.active,
    thinking: params.facts.thinking,
    // Foreground work is an operational fact even when this host does not own a presence channel.
    // `background_active` never carries this reason, so provider background work stays distinct.
    working: reasons.includes('working'),
    blocked: permissionRequired || actionRequired,
    permissionRequired,
    actionRequired,
    updatedAt: params.facts.updatedAt,
    ...(params.facts.permissionRequestIds ? { permissionRequestIds: params.facts.permissionRequestIds } : {}),
    ...(params.facts.messageCounts ? { messageCounts: params.facts.messageCounts } : {}),
  };
}
