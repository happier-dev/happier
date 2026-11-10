import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionRecapActionResultV1Schema, type SessionRecapActionResultV1 } from './recap.js';
export { resolveSessionRecap, resolveSessionRecapState, SessionRecapSchema, SessionRecapStateSchema,
  SessionRecapActionResultV1Schema, type SessionRecap, type SessionRecapState, type SessionRecapSynopsis,
  type SessionRecapWorkerUpdate, type SessionRecapActionResultV1 } from './recap.js';
import { z } from '../../zodRuntimePolicy.js';
import { QualifiedProjectKeyV1Schema, type QualifiedProjectKeyV1 } from '../../workspaces/workspaceRefV1.js';
import { SessionListResultSchema, SessionSummarySchema, SessionListMetadataUpgradeRequiredCountSchema, SessionListBotFilterUnavailableCountSchema } from '../control/listResult.js';

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

/** Recap is a single-Session content read, never a Session-list representation. */
export const SessionActivityViewV1Schema = lazyZodSchema(() => z.enum(['summary', 'awareness', 'recap']));
export type SessionActivityViewV1 = z.infer<typeof SessionActivityViewV1Schema>;

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
  attentionNextCursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  attentionHasNext: z.optional(z.boolean()),
} as const;

const SessionListActionResultMarkerFieldsV1 = {
  project: z.optional(QualifiedProjectKeyV1Schema),
  projectFilterUnavailableCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  queryVersion: z.optional(z.literal(SESSION_LIST_QUERY_RESULT_VERSION_V1)),
  metadataUpgradeRequiredCount: z.optional(SessionListMetadataUpgradeRequiredCountSchema),
  botFilterUnavailableCount: z.optional(SessionListBotFilterUnavailableCountSchema),
  ...SessionListAttentionContinuationFieldsV1,
} as const;

function requireAttentionContinuationPair(
  value: Readonly<Record<string, unknown>>,
  context: z.core.$RefinementCtx,
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
  context: z.core.$RefinementCtx,
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

const SessionListRequiredAttentionContinuationFieldsV1Schema = lazyZodSchema(() => z.looseObject({
  attentionNextCursor: SessionListAttentionContinuationFieldsV1.attentionNextCursor._zod.def.innerType,
  attentionHasNext: SessionListAttentionContinuationFieldsV1.attentionHasNext._zod.def.innerType,
}));

export const SessionAwarenessListResultV1Schema = lazyZodSchema(() => z.strictObject({
    project: z.optional(QualifiedProjectKeyV1Schema),
    projectFilterUnavailableCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    view: z.literal(SESSION_LIST_AWARENESS_VIEW_V1),
    projectionVersion: z.literal(SESSION_AWARENESS_PROJECTION_VERSION_V1),
    sessions: z.array(SessionAwarenessProjectionV1Schema),
    nextCursor: z.nullable(z.string().check(z.minLength(1))),
    hasNext: z.boolean(),
    metadataUpgradeRequiredCount: z.optional(SessionListMetadataUpgradeRequiredCountSchema),
    botFilterUnavailableCount: z.optional(SessionListBotFilterUnavailableCountSchema),
    ...SessionListAttentionContinuationFieldsV1,
  }).check(z.superRefine(requireAttentionContinuationPair)));
export type SessionAwarenessListResultV1 = Readonly<
  Omit<z.infer<typeof SessionAwarenessListResultV1Schema>, 'sessions'> & {
    sessions: readonly SessionAwarenessProjectionV1[];
  }
>;

// Released UI hosts return a smaller summary than CLI hosts. Keep that read seam separate
// from awareness, including its optional retained-window preview and qualified display context.
const LegacyUiSessionListResultSchema = lazyZodSchema(() => z.looseObject({
  ok: z.optional(z.literal(true)),
  sessions: z.array(z.object({
    id: z.string().check(z.minLength(1)),
    manager: SessionSummarySchema.shape.manager,
    active: z.boolean(),
    presence: z.nullable(z.string()),
    updatedAt: z.number().check(z.nonnegative()),
    title: z.optional(z.string()),
    locationLabel: z.optional(z.string()),
    serverId: z.optional(z.string()),
    serverName: z.optional(z.string()),
    lastMessagePreview: z.optional(z.object({
      role: z.string(), text: z.string(), createdAt: z.nullable(z.number()),
    })),
  })),
  nextCursor: z.nullable(z.string()),
  hasNext: z.optional(z.boolean()),
}));

const SummarySessionListActionResultSchema = lazyZodSchema(() => z.intersection(z.union([
  SessionListResultSchema,
  LegacyUiSessionListResultSchema,
]), z.looseObject({
  ...SessionListActionResultMarkerFieldsV1,
})).check(z.superRefine((value, context) => {
  if (Object.hasOwn(value, 'view') || Object.hasOwn(value, 'projectionVersion')) {
    context.addIssue({ code: 'custom', message: 'A marked result must satisfy the awareness contract' });
  }
  requireQueryMarkedAttentionContinuation(value, context);
})));

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
  z.intersection(SessionAwarenessListResultV1Schema, z.looseObject({
    attentionNextCursor: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionNextCursor,
    attentionHasNext: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionHasNext,
  })),
  z.intersection(SummarySessionListActionResultSchema, z.looseObject({
    queryVersion: z.literal(SESSION_LIST_QUERY_RESULT_VERSION_V1),
    attentionNextCursor: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionNextCursor,
    attentionHasNext: SessionListRequiredAttentionContinuationFieldsV1Schema.shape.attentionHasNext,
  })),
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
  project?: QualifiedProjectKeyV1;
  projectFilterUnavailableCount?: number;
  sessions: readonly SessionAwarenessProjectionV1[];
  nextCursor: string | null;
  hasNext: boolean;
  metadataUpgradeRequiredCount?: number;
  botFilterUnavailableCount?: number;
}> & SessionListAttentionContinuationInputV1): SessionAwarenessListResultV1 {
  return {
    ...(params.project ? { project: params.project } : {}),
    ...(params.projectFilterUnavailableCount ? { projectFilterUnavailableCount: params.projectFilterUnavailableCount } : {}),
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
export const SessionActivityCompatibilityMessageCountsV1Schema = lazyZodSchema(() => z.strictObject({
  total: z.number().check(z.int(), z.nonnegative()),
  assistant: z.number().check(z.int(), z.nonnegative()),
  user: z.number().check(z.int(), z.nonnegative()),
}));
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
export const SessionActivityCompatibilityUiResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  presence: z.nullable(z.string()),
  active: z.boolean(),
  thinking: z.boolean(),
  working: z.boolean(),
  blocked: z.boolean(),
  permissionRequired: z.boolean(),
  actionRequired: z.boolean(),
  updatedAt: z.nullable(z.number().check(z.nonnegative())),
  permissionRequestIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  messageCounts: z.optional(SessionActivityCompatibilityMessageCountsV1Schema),
  // The CLI/daemon released these numeric pending-fact fields. They remain compatibility facts;
  // operational meaning still comes only from the awareness projection above.
  pendingCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  pendingPermissionRequestCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  pendingUserActionRequestCount: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

/**
 * Exact successful shape emitted by the released CLI host. It cannot observe the UI-only
 * presence/thinking/operational facts, so accepting it is a read adapter rather than permission
 * to fabricate those facts. This shape is present in both server-v0.2.11 and the moving 0.2
 * predecessor.
 */
export const SessionActivityCompatibilityCliResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  active: z.boolean(),
  updatedAt: z.nullable(z.number().check(z.nonnegative())),
  pendingCount: z.number().check(z.int(), z.nonnegative()),
  pendingPermissionRequestCount: z.number().check(z.int(), z.nonnegative()),
  pendingUserActionRequestCount: z.number().check(z.int(), z.nonnegative()),
}));

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
  SessionRecapActionResultV1Schema,
  SessionAwarenessProjectionV1Schema,
  SessionActivityCompatibilityResultV1Schema,
]));
export type SessionActivityActionResultV1 = Readonly<
  SessionAwarenessProjectionV1 | SessionActivityCompatibilityResultV1 | SessionRecapActionResultV1
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
