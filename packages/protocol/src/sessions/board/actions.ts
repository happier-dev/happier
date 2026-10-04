import { z } from 'zod';

import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionExecuteResult,
} from '../../actions/actionExecutionResult.js';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { FeatureDecisionSchema } from '../../features/decision.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import { SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX } from '../system/records/sessionSystemRecordRoutes.js';
import {
  SESSION_BOARD_ACTION_IDS_V1,
  SessionBoardActionIdV1Schema,
  type SessionBoardActionIdV1,
} from './actionIds.js';
import { SessionBoardTabIdSchema, SessionSurfaceItemIdSchema } from './ids.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from './item.js';
import { SessionBoardItemWidthSchema, SessionBoardLayoutV1Schema } from './layout.js';
import {
  SessionBoardMutationResultV1Schema,
  SessionBoardMutationV1Schema,
  isSessionBoardMutationResultCorresponding,
  type SessionBoardMutationResultV1,
  type SessionBoardMutationV1,
} from './mutations.js';
import {
  SessionBoardErrorCodeSchema,
  SessionBoardErrorV1Schema,
  SessionBoardFeatureGateErrorV1Schema,
  projectSessionBoardFeatureGateFailureV1,
  type SessionBoardErrorCode,
  type SessionBoardErrorV1,
} from './errors.js';
import { bindHomeDomainHttpRequestV1 } from '../../actions/homeDomainHttpBinding.js';
import {
  SessionBoardItemPlacementV1Schema,
  SessionBoardLayoutOperationV1Schema,
  sessionBoardItemPlacementOperandsRetainedV1,
  sessionBoardPlacedWidthRetainsPlacementV1,
} from './layoutOperations.js';

/**
 * Board reads compose the existing System Record list/read routes, so a Board
 * page is bounded by that owner's page limit rather than a Board-local number.
 */
export const SESSION_BOARD_GET_MAX_LIMIT_V1 = SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX;

/** One canonical sealed aggregate transport shared by Action specs and host adapters. */
export const SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1 = Object.freeze({
  method: 'PUT' as const,
  path: '/v2/sessions/:sessionId/board' as const,
});

/** Optional only because the executor's existing contextual rule stamps the current Session. */
const SessionBoardActionSessionIdSchema = z.string().trim().min(1).optional();

/** Mirrors the closed `SessionSurfaceItemV1` source union; a new arm must be classified here too. */
const SessionSurfaceItemSourceKindV1Schema: z.ZodType<SessionSurfaceItemV1['source']['kind']> =
  z.enum(['declarative', 'hostedHtml', 'installedSurface', 'walkthrough']);

export const SessionBoardGetInputV1Schema = z.object({
  sessionId: SessionBoardActionSessionIdSchema,
  /** Exact ids opt into full item bodies; the default response stays an inventory. */
  itemIds: z.array(SessionSurfaceItemIdSchema).max(SESSION_BOARD_GET_MAX_LIMIT_V1).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(SESSION_BOARD_GET_MAX_LIMIT_V1).optional(),
}).strict();
export type SessionBoardGetInputV1 = z.infer<typeof SessionBoardGetInputV1Schema>;

export const SessionBoardGetResultV1Schema = z.object({
  v: z.literal(1),
  serverId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  /** Projected from the Lane 04 evaluator by the host; never derived from a role or share level here. */
  capabilities: z.object({
    readTranscript: z.boolean(),
    editSessionRecords: z.boolean(),
  }).strict(),
  /** `null` is an absent layout record, not a synthesized default view. */
  layout: z.object({
    revision: SessionSystemRecordRevisionSchema,
    document: SessionBoardLayoutV1Schema,
  }).strict().nullable(),
  items: z.array(z.object({
    itemId: SessionSurfaceItemIdSchema,
    revision: SessionSystemRecordRevisionSchema,
    title: z.string(),
    sourceKind: SessionSurfaceItemSourceKindV1Schema,
    // Item capability requests reuse canonical Action ids, whose family list
    // includes these Board Actions. Defer the reverse schema edge until parse.
    item: z.lazy(() => SessionSurfaceItemV1Schema).optional(),
  }).strict()).max(SESSION_BOARD_GET_MAX_LIMIT_V1),
  /** Record pagination is not a snapshot: an unfinished read says so explicitly. */
  incomplete: z.boolean(),
  page: z.object({
    cursor: z.string().trim().min(1).nullable(),
    hasNext: z.boolean(),
  }).strict(),
}).strict();
export type SessionBoardGetResultV1 = z.infer<typeof SessionBoardGetResultV1Schema>;

export type SessionBoardReadProjectionEntryV1 =
  | Readonly<{ status: 'ready'; itemId: unknown; revision: unknown; item: unknown }>
  | Readonly<{ status: 'unavailable' }>;

/**
 * Canonical Board GET assembly after a host has opened record envelopes. The
 * transport/crypto adapters own opening; this owner alone decides summary
 * shape, body selection, dedupe and explicit incompleteness.
 */
export function projectSessionBoardGetResultV1(input: Readonly<{
  serverId: string;
  sessionId: string;
  capabilities: SessionBoardGetResultV1['capabilities'];
  layout: SessionBoardGetResultV1['layout'];
  requestedItemIds?: readonly string[];
  entries: readonly SessionBoardReadProjectionEntryV1[];
  incomplete: boolean;
  page: SessionBoardGetResultV1['page'];
}>): SessionBoardGetResultV1 {
  const requested = input.requestedItemIds === undefined ? null : new Set(input.requestedItemIds);
  const seen = new Set<string>();
  const items: SessionBoardGetResultV1['items'][number][] = [];
  let incomplete = input.incomplete;
  for (const entry of input.entries) {
    if (entry.status !== 'ready') {
      incomplete = true;
      continue;
    }
    const itemId = SessionSurfaceItemIdSchema.safeParse(entry.itemId);
    const revision = SessionSystemRecordRevisionSchema.safeParse(entry.revision);
    const item = SessionSurfaceItemV1Schema.safeParse(entry.item);
    if (!itemId.success || !revision.success || !item.success) {
      incomplete = true;
      continue;
    }
    if (seen.has(itemId.data)) continue;
    seen.add(itemId.data);
    items.push({
      itemId: itemId.data,
      revision: revision.data,
      title: item.data.title,
      sourceKind: item.data.source.kind,
      ...(requested?.has(itemId.data) ? { item: item.data } : {}),
    });
  }
  return SessionBoardGetResultV1Schema.parse({
    v: 1,
    serverId: input.serverId,
    sessionId: input.sessionId,
    capabilities: input.capabilities,
    layout: input.layout,
    items,
    incomplete,
    page: input.page,
  });
}

export const SessionBoardItemUpsertInputV1Schema = z.object({
  sessionId: SessionBoardActionSessionIdSchema,
  itemId: SessionSurfaceItemIdSchema,
  /** `null` requests creation; every other value is an exact optimistic-concurrency operand. */
  expectedItemRevision: SessionSystemRecordRevisionSchema.nullable(),
  item: z.lazy(() => SessionSurfaceItemV1Schema),
  placement: SessionBoardItemPlacementV1Schema.optional(),
}).strict().superRefine((input, context) => {
  if (input.expectedItemRevision === null && !input.placement) {
    context.addIssue({
      code: 'custom',
      path: ['placement'],
      message: 'Item creation requires an atomic first placement',
    });
  }
});
export type SessionBoardItemUpsertInputV1 = z.infer<typeof SessionBoardItemUpsertInputV1Schema>;

export const SessionBoardItemRemoveInputV1Schema = z.object({
  sessionId: SessionBoardActionSessionIdSchema,
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema,
  expectedLayoutRevision: SessionSystemRecordRevisionSchema,
}).strict();
export type SessionBoardItemRemoveInputV1 = z.infer<typeof SessionBoardItemRemoveInputV1Schema>;

export const SessionBoardLayoutUpdateInputV1Schema = z.object({
  sessionId: SessionBoardActionSessionIdSchema,
  expectedLayoutRevision: SessionSystemRecordRevisionSchema.nullable(),
  operation: SessionBoardLayoutOperationV1Schema,
}).strict();
export type SessionBoardLayoutUpdateInputV1 = z.infer<typeof SessionBoardLayoutUpdateInputV1Schema>;

/**
 * The Action projection of Plan 03's operation-specific mutation result. It adds
 * only host-known reference facts: where the item now sits and a
 * presentation-neutral descriptor the executor built from content it already
 * opened. It never carries item bytes, and a removal has no destination.
 */
export const SessionBoardMutationActionResultV1Schema = z.object({
  v: z.literal(1),
  serverId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  result: SessionBoardMutationResultV1Schema,
  destination: z.object({
    tabId: SessionBoardTabIdSchema,
    width: SessionBoardItemWidthSchema,
  }).strict().nullable(),
  preview: z.object({
    title: z.string(),
    sourceKind: SessionSurfaceItemSourceKindV1Schema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.result.operation === 'remove_item' && value.destination !== null) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'A removed item has no Board destination' });
  }
  if (value.result.operation !== 'upsert_item' && value.preview !== undefined) {
    context.addIssue({ code: 'custom', path: ['preview'], message: 'Only an item upsert opens content to preview' });
  }
});
export type SessionBoardMutationActionResultV1 = z.infer<typeof SessionBoardMutationActionResultV1Schema>;

export const SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'session.board.get': SessionBoardGetInputV1Schema,
  'session.board.item.upsert': SessionBoardItemUpsertInputV1Schema,
  'session.board.item.remove': SessionBoardItemRemoveInputV1Schema,
  'session.board.layout.update': SessionBoardLayoutUpdateInputV1Schema,
} as const satisfies Readonly<Record<SessionBoardActionIdV1, z.ZodTypeAny>>);

export const SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'session.board.get': SessionBoardGetResultV1Schema,
  'session.board.item.upsert': SessionBoardMutationActionResultV1Schema,
  'session.board.item.remove': SessionBoardMutationActionResultV1Schema,
  'session.board.layout.update': SessionBoardMutationActionResultV1Schema,
} as const satisfies Readonly<Record<SessionBoardActionIdV1, z.ZodTypeAny>>);

export type SessionBoardActionInputV1ById = Readonly<{
  [TActionId in SessionBoardActionIdV1]: z.infer<(typeof SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1)[TActionId]>;
}>;

/** Lane 05 owns the continuation; Board only narrows its Action id. */
export const SessionBoardApprovalRequestCreatedResultV1Schema =
  ActionApprovalRequestCreatedResultSchema.superRefine((value, context) => {
    if (!SessionBoardActionIdV1Schema.safeParse(value.actionId).success) {
      context.addIssue({ code: 'custom', path: ['actionId'], message: 'Approval must reference a Board Action' });
    }
  });
export type SessionBoardApprovalRequestCreatedResultV1 = Readonly<
  z.infer<typeof SessionBoardApprovalRequestCreatedResultV1Schema>
>;

const SessionBoardMutationActionRecoveryEvidenceV1Schema = z.discriminatedUnion('actionId', [
  z.object({
    v: z.literal(1),
    actionId: z.literal('session.board.item.upsert'),
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    requestBody: z.string().min(1),
    mutationRequest: SessionBoardMutationV1Schema,
    intent: SessionBoardItemUpsertInputV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    actionId: z.literal('session.board.item.remove'),
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    requestBody: z.string().min(1),
    mutationRequest: SessionBoardMutationV1Schema,
    intent: SessionBoardItemRemoveInputV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    actionId: z.literal('session.board.layout.update'),
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    requestBody: z.string().min(1),
    mutationRequest: SessionBoardMutationV1Schema,
    intent: SessionBoardLayoutUpdateInputV1Schema,
  }).strict(),
]);

/** Exact issued mutation evidence retained only for an ambiguous post-dispatch result. */
export const SessionBoardActionRecoveryEvidenceV1Schema = SessionBoardMutationActionRecoveryEvidenceV1Schema.superRefine(
  (evidence, context) => {
    let mutation: z.infer<typeof SessionBoardMutationV1Schema> | null = null;
    try {
      const parsed = SessionBoardMutationV1Schema.safeParse(JSON.parse(evidence.requestBody));
      mutation = parsed.success ? parsed.data : null;
    } catch {
      mutation = null;
    }
    const expectedOperation = evidence.actionId === 'session.board.item.upsert'
      ? 'upsert_item'
      : evidence.actionId === 'session.board.item.remove'
        ? 'remove_item'
        : 'update_layout';
    if (
      mutation?.operation !== expectedOperation
      || !recordsEqualAfterSchemaParse(SessionBoardMutationV1Schema, mutation, evidence.mutationRequest)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestBody'],
        message: 'Recovery request body must be the exact mutation for its Board Action',
      });
      return;
    }
    if (evidence.intent.sessionId !== undefined && evidence.intent.sessionId !== evidence.sessionId) {
      context.addIssue({ code: 'custom', path: ['sessionId'], message: 'Recovery Session must match the invoked intent' });
    }
    if (evidence.actionId === 'session.board.item.upsert' && mutation.operation === 'upsert_item') {
      if (
        mutation.itemId !== evidence.intent.itemId
        || mutation.expectedItemRevision !== evidence.intent.expectedItemRevision
      ) {
        context.addIssue({
          code: 'custom', path: ['requestBody'],
          message: 'Recovery mutation must retain the invoked item and concurrency operands',
        });
      }
      const intendedPlacement = evidence.intent.placement;
      if ((intendedPlacement === undefined) !== (mutation.placement === undefined)) {
        context.addIssue({
          code: 'custom', path: ['requestBody'],
          message: 'Recovery mutation must retain whether placement was invoked',
        });
        return;
      }
      if (intendedPlacement !== undefined && mutation.placement?.layoutContent.t === 'plain') {
        // The layout operation owns what a placement operand means; this only asks it whether the
        // mutation it produced still carries the invocation, so the two can never disagree.
        const layout = SessionBoardLayoutV1Schema.safeParse(mutation.placement.layoutContent.v);
        if (
          !layout.success
          || !sessionBoardItemPlacementOperandsRetainedV1(layout.data, {
            itemId: evidence.intent.itemId,
            placement: intendedPlacement,
          })
        ) {
          context.addIssue({
            code: 'custom', path: ['requestBody'],
            message: 'Recovery mutation must retain the invoked placement operands',
          });
        }
      }
    } else if (evidence.actionId === 'session.board.item.remove' && mutation.operation === 'remove_item') {
      if (
        mutation.itemId !== evidence.intent.itemId
        || mutation.expectedItemRevision !== evidence.intent.expectedItemRevision
        || mutation.expectedLayoutRevision !== evidence.intent.expectedLayoutRevision
      ) {
        context.addIssue({
          code: 'custom', path: ['requestBody'],
          message: 'Recovery mutation must retain the invoked item and concurrency operands',
        });
      }
    } else if (evidence.actionId === 'session.board.layout.update' && mutation.operation === 'update_layout') {
      if (mutation.expectedLayoutRevision !== evidence.intent.expectedLayoutRevision) {
        context.addIssue({
          code: 'custom', path: ['requestBody'],
          message: 'Recovery mutation must retain the invoked layout concurrency operand',
        });
      }
      const intendedParticipantItemId = evidence.intent.operation.op === 'item.place'
        ? evidence.intent.operation.itemId
        : null;
      if (
        intendedParticipantItemId === null
          ? mutation.itemPlacementParticipant !== undefined
          : mutation.itemPlacementParticipant?.itemId !== intendedParticipantItemId
      ) {
        context.addIssue({
          code: 'custom', path: ['requestBody'],
          message: 'Recovery mutation must retain the exact item placement participant',
        });
      }
    }
  },
);
export type SessionBoardActionRecoveryEvidenceV1 = Readonly<z.infer<typeof SessionBoardActionRecoveryEvidenceV1Schema>>;

export const SessionBoardOutcomeUnknownDetailsV1Schema = z.object({
  recovery: SessionBoardActionRecoveryEvidenceV1Schema,
}).strict();
export type SessionBoardOutcomeUnknownDetailsV1 = Readonly<z.infer<typeof SessionBoardOutcomeUnknownDetailsV1Schema>>;

const boardFailure = <TCode extends string>(code: TCode) => z.object({
  ok: z.literal(false), errorCode: z.literal(code), error: z.literal(code),
}).strict();
const BoardRevisionConflictDetailsV1Schema = z.object({
  currentItemRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
  currentLayoutRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
}).strict().refine((value) => value.currentItemRevision !== undefined || value.currentLayoutRevision !== undefined);
const BoardFeatureFailureV1Schema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(['feature_disabled', 'feature_unavailable']),
  error: z.enum(['feature_disabled', 'feature_unavailable']),
  details: z.object({
    operation: SessionBoardActionIdV1Schema,
    featureDecision: FeatureDecisionSchema.optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.error !== value.errorCode) context.addIssue({ code: 'custom', path: ['error'], message: 'Failure discriminators must agree' });
  if (value.details.featureDecision && (
    value.details.featureDecision.featureId !== 'sessions.board'
    || (value.errorCode === 'feature_disabled'
      ? value.details.featureDecision.state !== 'disabled'
      : value.details.featureDecision.state !== 'unknown')
  )) context.addIssue({ code: 'custom', path: ['details', 'featureDecision'], message: 'Feature detail contradicts outer failure' });
});
const BoardUpdateRequiredFailureV1Schema = z.object({
  ok: z.literal(false), errorCode: z.literal('update_required'), error: z.literal('update_required'),
  details: OperationUpdateRequiredV1Schema,
}).strict().superRefine((value, context) => {
  if (!SessionBoardActionIdV1Schema.safeParse(value.details.operation).success) {
    context.addIssue({ code: 'custom', path: ['details', 'operation'], message: 'Update requirement must reference a Board Action' });
  }
});
const BoardDefiniteFailureCodeV1Schema = z.enum([
  'cancelled', 'corrupt_or_unopenable', 'encryption_material_unavailable', 'forbidden',
  'invalid_response', 'locked', 'malformed', 'mode_mismatch', 'not_authenticated',
  'not_found', 'offline', 'protocol_unavailable', 'server_error', 'server_target_mismatch',
  'unsupported_action', 'unsupported_version',
]);
export type SessionBoardDefiniteFailureCodeV1 = z.infer<typeof BoardDefiniteFailureCodeV1Schema>;
const BoardDefiniteFailureV1Schema = z.object({
  ok: z.literal(false), errorCode: BoardDefiniteFailureCodeV1Schema, error: BoardDefiniteFailureCodeV1Schema,
}).strict().refine((value) => value.error === value.errorCode);

/** Strict complete failure union accepted by the Board Action family boundary. */
export const SessionBoardActionFailureV1Schema = z.union([
  boardFailure('session_board_invalid'),
  boardFailure('session_board_item_not_found'),
  boardFailure('session_board_forbidden'),
  boardFailure('session_board_storage_mode_mismatch'),
  boardFailure('session_board_source_conflict'),
  boardFailure('session_board_revision_conflict'),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('session_board_revision_conflict'),
    error: z.literal('session_board_revision_conflict'),
    details: BoardRevisionConflictDetailsV1Schema,
  }).strict(),
  BoardFeatureFailureV1Schema,
  BoardUpdateRequiredFailureV1Schema,
  z.object({
    ok: z.literal(false), errorCode: z.literal('outcome_unknown'), error: z.literal('outcome_unknown'),
    details: SessionBoardOutcomeUnknownDetailsV1Schema,
  }).strict(),
  BoardDefiniteFailureV1Schema,
]);
export type SessionBoardActionFailureV1 = Readonly<z.infer<typeof SessionBoardActionFailureV1Schema>>;

/** Every Board failure code whose strict envelope carries no details. */
export type SessionBoardSimpleFailureCodeV1 = SessionBoardErrorCode | SessionBoardDefiniteFailureCodeV1;

/**
 * Build the detail-free Board failure envelope every host adapter returns. The
 * strict union discriminates on `errorCode` and `error` together, which no
 * widened `{ errorCode: TCode; error: TCode }` object type satisfies, so the one
 * owner of the union settles the pair here instead of each host inventing a
 * local helper that the port boundary then has to re-validate.
 */
export function createSessionBoardFailureV1(code: SessionBoardSimpleFailureCodeV1): SessionBoardActionFailureV1 {
  return SessionBoardActionFailureV1Schema.parse({ ok: false, errorCode: code, error: code });
}

/**
 * Project the Board route's closed error document through the strict Action
 * failure union without losing readable conflict revisions. Keeping this beside
 * the union prevents UI and daemon adapters from growing similar-but-different
 * failure mappings.
 */
export function projectSessionBoardActionFailureV1(error: SessionBoardErrorV1): SessionBoardActionFailureV1 {
  if (error.error !== 'session_board_revision_conflict') return createSessionBoardFailureV1(error.error);
  const details = {
    ...(error.currentItemRevision !== undefined ? { currentItemRevision: error.currentItemRevision } : {}),
    ...(error.currentLayoutRevision !== undefined ? { currentLayoutRevision: error.currentLayoutRevision } : {}),
  };
  return SessionBoardActionFailureV1Schema.parse({
    ok: false,
    errorCode: error.error,
    error: error.error,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
}

const SESSION_BOARD_ADAPTER_ERROR_CODE_ALIASES = Object.freeze({
  plugin_session_records_unavailable: 'protocol_unavailable',
  plugin_session_record_forbidden: 'forbidden',
  plugin_session_not_found: 'not_found',
  session_not_found: 'not_found',
  plugin_session_record_invalid_query: 'malformed',
  plugin_session_record_invalid_request: 'malformed',
  plugin_session_record_invalid_response: 'invalid_response',
  plugin_session_record_encryption_mismatch: 'mode_mismatch',
  plugin_session_record_encryption_unavailable: 'corrupt_or_unopenable',
  // The connection-establishment codes the mutation path already treats as a proven
  // non-dispatch. A read that never reached the Home is `offline`, not an invalid response.
  ECONNREFUSED: 'offline',
  ENOTFOUND: 'offline',
  EAI_AGAIN: 'offline',
  ERR_CANCELED: 'cancelled',
} as const satisfies Readonly<Record<string, SessionBoardDefiniteFailureCodeV1>>);

function readSessionBoardAdapterErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null;
  const record = error as Readonly<{ errorCode?: unknown; code?: unknown; cause?: unknown; name?: unknown }>;
  for (const candidate of [record.errorCode, record.code]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  if (record.name === 'AbortError') return 'cancelled';
  return readSessionBoardAdapterErrorCode(record.cause, depth + 1);
}

/**
 * Project transport/record/crypto adapter exceptions into the one strict Board
 * failure vocabulary. This is intentionally only a reader of existing owner
 * codes; it does not decide whether an issued mutation is ambiguous.
 */
export function projectSessionBoardAdapterFailureV1(
  error: unknown,
  fallback: SessionBoardDefiniteFailureCodeV1 = 'invalid_response',
  actionId?: SessionBoardActionIdV1,
): SessionBoardActionFailureV1 {
  const rawCode = readSessionBoardAdapterErrorCode(error);
  // The feature refusal is the one producer code whose strict envelope carries the
  // operation, so it reuses the same gate projection the mutation settlement already uses.
  if (rawCode === 'plugin_session_record_feature_disabled' && actionId !== undefined) {
    return projectSessionBoardFeatureGateFailureV1(actionId);
  }
  const direct = BoardDefiniteFailureCodeV1Schema.safeParse(rawCode);
  const errorCode = direct.success
    ? direct.data
    : rawCode && Object.hasOwn(SESSION_BOARD_ADAPTER_ERROR_CODE_ALIASES, rawCode)
      ? SESSION_BOARD_ADAPTER_ERROR_CODE_ALIASES[rawCode as keyof typeof SESSION_BOARD_ADAPTER_ERROR_CODE_ALIASES]
      : fallback;
  return SessionBoardActionFailureV1Schema.parse({ ok: false, errorCode, error: errorCode });
}

/** Build the one failure envelope that may retain an issued Board mutation for reconciliation. */
export function createSessionBoardOutcomeUnknownFailureV1(input: Readonly<{
  actionId: Exclude<SessionBoardActionIdV1, 'session.board.get'>;
  serverId: string;
  sessionId: string;
  requestBody: string;
  mutationRequest: SessionBoardMutationV1;
  intent: unknown;
}>): Readonly<{
  ok: false;
  errorCode: 'outcome_unknown';
  error: 'outcome_unknown';
  details: SessionBoardOutcomeUnknownDetailsV1;
}> {
  const recovery = SessionBoardActionRecoveryEvidenceV1Schema.parse({
    v: 1,
    actionId: input.actionId,
    serverId: input.serverId,
    sessionId: input.sessionId,
    requestBody: input.requestBody,
    mutationRequest: input.mutationRequest,
    intent: input.intent,
  });
  return Object.freeze({
    ok: false,
    errorCode: 'outcome_unknown',
    error: 'outcome_unknown',
    details: Object.freeze({ recovery: Object.freeze(recovery) }),
  });
}

export type SessionBoardMutationTransportResultV1 =
  | Readonly<{ kind: 'applied'; result: SessionBoardMutationResultV1 }>
  | Readonly<{ kind: 'failure'; result: SessionBoardActionFailureV1 }>;

const SessionBoardMutationRequestPathV1Schema = z.object({
  sessionId: z.string().trim().min(1),
}).strict();

/**
 * Bind one Board mutation to its exact Home HTTP request through the generic
 * Home-domain binder. Both host adapters consume this instead of pairing the
 * declared method, the `:sessionId` placeholder and the body themselves.
 */
export function bindSessionBoardMutationRequestV1(input: Readonly<{
  sessionId: string;
  mutation: SessionBoardMutationV1;
}>): Readonly<{ method: typeof SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1.method; path: string; body: SessionBoardMutationV1 }> {
  const bound = bindHomeDomainHttpRequestV1({
    transport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    inputSchema: SessionBoardMutationRequestPathV1Schema,
    input: { sessionId: input.sessionId },
  });
  return Object.freeze({
    method: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1.method,
    path: bound.path,
    body: SessionBoardMutationV1Schema.parse(input.mutation),
  });
}

/**
 * Canonical post-dispatch HTTP classifier shared by UI and CLI adapters.
 * A definite non-2xx answer is never ambiguous. Once a 2xx answer arrives,
 * however, an empty, malformed, schema-invalid, or request-mismatched body
 * cannot prove which mutation committed and therefore requires reconciliation.
 */
export function classifySessionBoardMutationTransportResultV1(input: Readonly<{
  actionId: Exclude<SessionBoardActionIdV1, 'session.board.get'>;
  serverId: string;
  sessionId: string;
  intent: unknown;
  requestBody: string;
  mutationRequest: SessionBoardMutationV1;
  status: number;
  body: unknown;
}>): SessionBoardMutationTransportResultV1 {
  if (input.status >= 200 && input.status < 300) {
    const parsed = SessionBoardMutationResultV1Schema.safeParse(input.body);
    if (parsed.success && isSessionBoardMutationResultCorresponding(input.mutationRequest, parsed.data)) {
      return { kind: 'applied', result: parsed.data };
    }
    return {
      kind: 'failure',
      result: createSessionBoardOutcomeUnknownFailureV1(input),
    };
  }
  const domain = SessionBoardErrorV1Schema.safeParse(input.body);
  if (domain.success) {
    return { kind: 'failure', result: projectSessionBoardActionFailureV1(domain.data) };
  }
  if (input.status === 404 && SessionBoardFeatureGateErrorV1Schema.safeParse(input.body).success) {
    return { kind: 'failure', result: projectSessionBoardFeatureGateFailureV1(input.actionId) };
  }
  return {
    kind: 'failure',
    result: { ok: false, errorCode: 'invalid_response', error: 'invalid_response' },
  };
}

/**
 * What a Session Board port implementation returns to the executor: either the
 * strict Board failure union or the canonical output of the Action it ran. The
 * executor validates it once at the terminal boundary
 * (`parseSessionBoardActionPortResultV1`) and only then wraps a success in the
 * shared `{ ok: true, result }` envelope, so a port never produces that envelope
 * itself.
 */
export type SessionBoardActionPortResultV1 =
  | SessionBoardActionFailureV1
  | SessionBoardGetResultV1
  | SessionBoardMutationActionResultV1;

export type SessionBoardActionPortResultParseV1 =
  | Readonly<{
      success: true;
      kind: 'success';
      data: SessionBoardGetResultV1 | SessionBoardMutationActionResultV1;
    }>
  | Readonly<{ success: true; kind: 'failure'; data: SessionBoardActionFailureV1 }>
  | Readonly<{ success: false }>;

function recordsEqualAfterSchemaParse(schema: z.ZodTypeAny, left: unknown, right: unknown): boolean {
  const parsedLeft = schema.safeParse(left);
  const parsedRight = schema.safeParse(right);
  return parsedLeft.success && parsedRight.success
    && JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data);
}

function parseBoardFailure(
  actionId: SessionBoardActionIdV1,
  input: unknown,
  result: Readonly<Record<string, unknown>>,
  options: Readonly<{ expectedSessionId?: string; expectedServerId?: string }>,
): SessionBoardActionPortResultParseV1 {
  if (result.ok !== false || typeof result.errorCode !== 'string' || result.error !== result.errorCode) {
    return { success: false };
  }
  const errorCode = result.errorCode;
  const parsedSessionBoardErrorCode = SessionBoardErrorCodeSchema.safeParse(errorCode);
  if (parsedSessionBoardErrorCode.success) {
    const errorCode = parsedSessionBoardErrorCode.data;
    if (errorCode !== 'session_board_revision_conflict') {
      if (result.details !== undefined) return { success: false };
      const parsedFailure = SessionBoardActionFailureV1Schema.safeParse({
        ok: false,
        errorCode,
        error: errorCode,
      });
      return parsedFailure.success
        ? { success: true, kind: 'failure', data: parsedFailure.data }
        : { success: false };
    }
    if (!result.details || typeof result.details !== 'object' || Array.isArray(result.details)) {
      return { success: false };
    }
    const details = result.details as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(details, 'error')) return { success: false };
    const parsed = SessionBoardErrorV1Schema.safeParse({ error: errorCode, ...details });
    if (!parsed.success) return { success: false };
    if (parsed.data.error !== 'session_board_revision_conflict') return { success: false };
    return {
      success: true,
      kind: 'failure',
      data: {
        ok: false,
        errorCode,
        error: errorCode,
        ...(Object.keys(details).length > 0 ? { details: {
          ...(parsed.data.currentItemRevision !== undefined ? { currentItemRevision: parsed.data.currentItemRevision } : {}),
          ...(parsed.data.currentLayoutRevision !== undefined ? { currentLayoutRevision: parsed.data.currentLayoutRevision } : {}),
        } } : {}),
      },
    };
  }
  if (errorCode === 'feature_disabled' || errorCode === 'feature_unavailable') {
    const detailsSchema = z.object({
      operation: z.literal(actionId),
      featureDecision: FeatureDecisionSchema.optional(),
    }).strict();
    const parsed = detailsSchema.safeParse(result.details);
    if (
      !parsed.success
      || (parsed.data.featureDecision !== undefined && (
        parsed.data.featureDecision.featureId !== 'sessions.board'
        || (errorCode === 'feature_disabled'
          ? parsed.data.featureDecision.state !== 'disabled'
          : parsed.data.featureDecision.state !== 'unknown')
      ))
    ) return { success: false };
    return { success: true, kind: 'failure', data: { ok: false, errorCode, error: errorCode, details: parsed.data } };
  }
  if (errorCode === 'update_required') {
    const parsed = OperationUpdateRequiredV1Schema.safeParse(result.details);
    if (!parsed.success || parsed.data.operation !== actionId) return { success: false };
    return { success: true, kind: 'failure', data: { ok: false, errorCode, error: errorCode, details: parsed.data } };
  }
  if (errorCode === 'outcome_unknown' && actionId !== 'session.board.get') {
    const parsed = SessionBoardOutcomeUnknownDetailsV1Schema.safeParse(result.details);
    if (
      !parsed.success
      || parsed.data.recovery.actionId !== actionId
      || options.expectedServerId === undefined
      || parsed.data.recovery.serverId !== options.expectedServerId
      || options.expectedSessionId === undefined
      || parsed.data.recovery.sessionId !== options.expectedSessionId
      || !recordsEqualAfterSchemaParse(SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[actionId], parsed.data.recovery.intent, input)
    ) return { success: false };
    return { success: true, kind: 'failure', data: { ok: false, errorCode, error: errorCode, details: parsed.data } };
  }
  const parsedDefiniteFailureCode = BoardDefiniteFailureCodeV1Schema.safeParse(result.errorCode);
  if (parsedDefiniteFailureCode.success && result.details === undefined) {
    const errorCode = parsedDefiniteFailureCode.data;
    return { success: true, kind: 'failure', data: { ok: false, errorCode, error: errorCode } };
  }
  return { success: false };
}

/** Validate a Board family port response against both its schema and the request it acknowledges. */
export function parseSessionBoardActionPortResultV1(
  actionId: SessionBoardActionIdV1,
  input: unknown,
  result: unknown,
  options: Readonly<{ expectedSessionId?: string; expectedServerId?: string }> = {},
): SessionBoardActionPortResultParseV1 {
  const parsedInput = SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
  if (!parsedInput.success || !result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: false };
  }
  const resultRecord = result as Readonly<Record<string, unknown>>;
  if (resultRecord.ok === false || typeof resultRecord.errorCode === 'string') {
    return parseBoardFailure(actionId, parsedInput.data, resultRecord, options);
  }
  const parsedOutput = SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(result);
  if (!parsedOutput.success) return { success: false };
  const output = parsedOutput.data;
  // A successful Board result is useful for lost-response recovery only when
  // the invoking adapter supplies the exact Home it targeted. Inferring that
  // binding from the response would let a result from another Home acknowledge
  // an otherwise identical Session mutation.
  if (options.expectedServerId === undefined) return { success: false };
  const expectedSessionId = options.expectedSessionId
    ?? ('sessionId' in parsedInput.data ? parsedInput.data.sessionId : undefined);
  if (expectedSessionId !== undefined && output.sessionId !== expectedSessionId) return { success: false };
  if (options.expectedServerId !== undefined && output.serverId !== options.expectedServerId) return { success: false };

  if (actionId === 'session.board.get') {
    const requested = new Set((parsedInput.data as SessionBoardGetInputV1).itemIds ?? []);
    const getOutput = output as SessionBoardGetResultV1;
    if (getOutput.items.some((entry) => entry.item !== undefined && (
      !requested.has(entry.itemId)
      || entry.title !== entry.item.title
      || entry.sourceKind !== entry.item.source.kind
    ))) {
      return { success: false };
    }
    return { success: true, kind: 'success', data: getOutput };
  }

  const mutationOutput = output as SessionBoardMutationActionResultV1;
  if (actionId === 'session.board.item.upsert') {
    const upsert = parsedInput.data as SessionBoardItemUpsertInputV1;
    if (
      mutationOutput.result.operation !== 'upsert_item'
      || mutationOutput.result.itemId !== upsert.itemId
      || (upsert.expectedItemRevision === null
        ? mutationOutput.result.outcome === 'updated'
        : mutationOutput.result.outcome === 'created')
      || (upsert.placement !== undefined && mutationOutput.result.layoutRevision === undefined)
      || (upsert.placement !== undefined && (
        mutationOutput.destination === null
        || (upsert.placement.tabId !== undefined && mutationOutput.destination.tabId !== upsert.placement.tabId)
        || !sessionBoardPlacedWidthRetainsPlacementV1(mutationOutput.destination.width, upsert.placement)
      ))
      || (upsert.placement === undefined && mutationOutput.destination !== null)
    ) return { success: false };
  } else if (actionId === 'session.board.item.remove') {
    const remove = parsedInput.data as SessionBoardItemRemoveInputV1;
    if (mutationOutput.result.operation !== 'remove_item' || mutationOutput.result.itemId !== remove.itemId) {
      return { success: false };
    }
  } else {
    const update = parsedInput.data as SessionBoardLayoutUpdateInputV1;
    if (
      mutationOutput.result.operation !== 'update_layout'
      || (update.expectedLayoutRevision === null
        ? mutationOutput.result.outcome === 'updated'
        : mutationOutput.result.outcome === 'created')
    ) return { success: false };
  }
  return { success: true, kind: 'success', data: mutationOutput };
}

export type SessionBoardActionExecuteOutcomeParseV1 =
  | Readonly<{
      success: true;
      kind: 'applied';
      data: SessionBoardGetResultV1 | SessionBoardMutationActionResultV1;
    }>
  | Readonly<{
      success: true;
      kind: 'approval_request_created';
      data: SessionBoardApprovalRequestCreatedResultV1;
    }>
  | Readonly<{ success: true; kind: 'failure'; data: SessionBoardActionFailureV1 }>
  | Readonly<{ success: false }>;

/**
 * Classify the complete shared Action-executor envelope for Board consumers.
 * The approval arm is Lane 05's continuation and carries only its immutable
 * artifact and Action identity; it is neither application nor failure.
 */
export function parseSessionBoardActionExecuteOutcomeV1(
  actionId: SessionBoardActionIdV1,
  input: unknown,
  result: ActionExecuteResult,
  options: Readonly<{ expectedSessionId?: string; expectedServerId?: string }> = {},
): SessionBoardActionExecuteOutcomeParseV1 {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { success: false };
  const envelope = result as Readonly<Record<string, unknown>>;
  if (envelope.ok === false) {
    const parsed = parseSessionBoardActionPortResultV1(actionId, input, envelope, options);
    return parsed.success && parsed.kind === 'failure'
      ? { success: true, kind: 'failure', data: parsed.data }
      : { success: false };
  }
  if (envelope.ok !== true || !Object.hasOwn(envelope, 'result')) return { success: false };
  const approval = SessionBoardApprovalRequestCreatedResultV1Schema.safeParse(envelope.result);
  if (approval.success) {
    return approval.data.actionId === actionId
      ? { success: true, kind: 'approval_request_created', data: approval.data }
      : { success: false };
  }
  const parsed = parseSessionBoardActionPortResultV1(actionId, input, envelope.result, options);
  return parsed.success && parsed.kind === 'success'
    ? { success: true, kind: 'applied', data: parsed.data }
    : { success: false };
}
