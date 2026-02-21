import { z } from 'zod';

import {
  ExecutionRunPublicStateSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '../executionRuns.js';
import { ActionIdSchema, ActionInputHintsSchema, ActionSafetySchema, ActionSurfaceSchema } from '../actions/index.js';
import { ActionUiPlacementSchema } from '../actions/actionUiPlacements.js';
import { SubAgentRunResultV2Schema } from '../tools/v2/index.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const SessionControlErrorCodeSchema = z.enum([
  'not_authenticated',
  'server_unreachable',
  'session_not_found',
  'session_id_ambiguous',
  'session_active',
  'execution_run_not_found',
  'execution_run_action_not_supported',
  'execution_run_invalid_action_input',
  'execution_run_stream_not_found',
  'execution_run_not_allowed',
  'run_depth_exceeded',
  'conflict',
  'timeout',
  'invalid_arguments',
  'unsupported',
  'unknown_error',
  'already_exists',
]);
export type SessionControlErrorCode = z.infer<typeof SessionControlErrorCodeSchema>;

export const SessionControlErrorSchema = z.object({
  code: SessionControlErrorCodeSchema,
  message: z.string().optional(),
  details: z.unknown().optional(),
}).passthrough();
export type SessionControlError = z.infer<typeof SessionControlErrorSchema>;

export const SessionControlEnvelopeSuccessSchema = z.object({
  v: z.literal(1),
  ok: z.literal(true),
  kind: z.string().min(1),
  data: z.unknown(),
}).passthrough();
export type SessionControlEnvelopeSuccess = z.infer<typeof SessionControlEnvelopeSuccessSchema>;

export const SessionControlEnvelopeErrorSchema = z.object({
  v: z.literal(1),
  ok: z.literal(false),
  kind: z.string().min(1),
  error: SessionControlErrorSchema,
}).passthrough();
export type SessionControlEnvelopeError = z.infer<typeof SessionControlEnvelopeErrorSchema>;

export const SessionControlEnvelopeBaseSchema = z.discriminatedUnion('ok', [
  SessionControlEnvelopeSuccessSchema,
  SessionControlEnvelopeErrorSchema,
]);
export type SessionControlEnvelopeBase = z.infer<typeof SessionControlEnvelopeBaseSchema>;

export const AuthStatusResultSchema = z.object({
  authenticated: z.literal(true),
  encryption: z.object({
    type: z.enum(['legacy', 'dataKey']),
  }).passthrough(),
  machineRegistered: z.boolean(),
  machineId: z.string().min(1).optional(),
  host: z.string().min(1),
  happyHomeDir: z.string().min(1),
  daemonRunning: z.boolean(),
}).passthrough();
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  active: z.boolean(),
  activeAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  tag: z.string().optional(),
  title: z.string().min(1).optional(),
  path: z.string().optional(),
  host: z.string().optional(),
  share: z.object({
    accessLevel: z.string().min(1),
    canApprovePermissions: z.boolean(),
  }).nullable().optional(),
  isSystem: z.boolean().optional(),
  systemPurpose: z.string().nullable().optional(),
  encryptionMode: AccountEncryptionModeSchema.optional(),
  encryption: z.object({
    type: z.enum(['legacy', 'dataKey']),
  }).passthrough(),
}).passthrough();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * Factory form (accepts a caller-provided `z`) for nohoist/multi-zod-instance repos.
 * Consumers that need to embed the schema into their own Zod objects should use this
 * instead of importing `SessionSystemSessionV1Schema` directly.
 */
export function createSessionSystemSessionV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    key: zod.string(),
    hidden: zod.boolean().optional(),
  }).passthrough();
}

export const SessionSystemSessionV1Schema = createSessionSystemSessionV1Schema(z);
export type SessionSystemSessionV1 = z.infer<typeof SessionSystemSessionV1Schema>;

export function createSessionMetadataSchema(zod: typeof z) {
  return zod
    .object({
      systemSessionV1: createSessionSystemSessionV1Schema(zod).optional(),
    })
    .passthrough();
}

export const SessionMetadataSchema = createSessionMetadataSchema(z);
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export function readSystemSessionMetadataFromMetadata(params: Readonly<{ metadata: unknown }>): SessionSystemSessionV1 | null {
  const parsed = SessionMetadataSchema.safeParse(params.metadata);
  if (!parsed.success) return null;
  return parsed.data.systemSessionV1 ?? null;
}

export function isHiddenSystemSession(params: Readonly<{ metadata: unknown }>): boolean {
  const systemSession = readSystemSessionMetadataFromMetadata(params);
  return Boolean(systemSession && systemSession.hidden === true);
}

export function buildSystemSessionMetadataV1(params: Readonly<{ key: string; hidden?: boolean }>): { systemSessionV1: SessionSystemSessionV1 } {
  const hidden = params.hidden;
  return {
    systemSessionV1: {
      v: 1,
      key: params.key,
      ...(typeof hidden === 'boolean' ? { hidden } : {}),
    },
  };
}

export const SessionListResultSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.string().nullable().optional(),
  hasNext: z.boolean().optional(),
}).passthrough();
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

export const SessionShareSchema = z
  .object({
    accessLevel: z.enum(['view', 'edit', 'admin']),
    canApprovePermissions: z.boolean(),
  })
  .passthrough();
export type SessionShare = z.infer<typeof SessionShareSchema>;

export const V2SessionRecordSchema = z
  .object({
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    active: z.boolean(),
    activeAt: z.number().int().nonnegative(),
    archivedAt: z.number().int().nonnegative().nullable().optional(),
    encryptionMode: AccountEncryptionModeSchema.optional(),
    metadata: z.string(),
    metadataVersion: z.number().int().nonnegative(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number().int().nonnegative(),
    pendingCount: z.number().int().min(0).optional(),
    pendingVersion: z.number().int().min(0).optional(),
    dataEncryptionKey: z.string().nullable(),
    share: SessionShareSchema.nullable().optional(),
  })
  .passthrough();
export type V2SessionRecord = z.infer<typeof V2SessionRecordSchema>;

export const V2SessionListResponseSchema = z
  .object({
    sessions: z.array(V2SessionRecordSchema),
    nextCursor: z.string().nullable().optional(),
    hasNext: z.boolean().optional(),
  })
  .passthrough();
export type V2SessionListResponse = z.infer<typeof V2SessionListResponseSchema>;

export const V2_SESSION_LIST_CURSOR_V1_PREFIX = 'cursor_v1_' as const;

export function encodeV2SessionListCursorV1(sessionId: string): string {
  return `${V2_SESSION_LIST_CURSOR_V1_PREFIX}${sessionId}`;
}

export function decodeV2SessionListCursorV1(cursor: string): string | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(V2_SESSION_LIST_CURSOR_V1_PREFIX)) return null;
  const sessionId = cursor.slice(V2_SESSION_LIST_CURSOR_V1_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

export const V2SessionByIdResponseSchema = z
  .object({
    session: V2SessionRecordSchema,
  })
  .passthrough();
export type V2SessionByIdResponse = z.infer<typeof V2SessionByIdResponseSchema>;

export const V2SessionByIdNotFoundSchema = z.object({
  error: z.literal('Session not found'),
});
export type V2SessionByIdNotFound = z.infer<typeof V2SessionByIdNotFoundSchema>;

export const V2SessionMessageResponseSchema = z
  .object({
    didWrite: z.boolean(),
    message: z
      .object({
        id: z.string().min(1),
        seq: z.number().int().nonnegative(),
        localId: z.string().nullable(),
        createdAt: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
export type V2SessionMessageResponse = z.infer<typeof V2SessionMessageResponseSchema>;

export const SessionStatusResultSchema = z.object({
  session: SessionSummarySchema,
  agentState: z.object({
    controlledByUser: z.boolean().optional(),
    pendingRequestsCount: z.number().int().nonnegative(),
  }).passthrough().optional(),
}).passthrough();
export type SessionStatusResult = z.infer<typeof SessionStatusResultSchema>;

export const SessionCreateResultSchema = z.object({
  session: SessionSummarySchema,
  created: z.boolean(),
}).passthrough();
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;

export const SessionSendResultSchema = z.object({
  sessionId: z.string().min(1),
  localId: z.string().min(1),
  waited: z.boolean(),
}).passthrough();
export type SessionSendResult = z.infer<typeof SessionSendResultSchema>;

export const SessionWaitResultSchema = z.object({
  sessionId: z.string().min(1),
  idle: z.literal(true),
  observedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionWaitResult = z.infer<typeof SessionWaitResultSchema>;

export const SessionStopResultSchema = z.object({
  sessionId: z.string().min(1),
  stopped: z.literal(true),
}).passthrough();
export type SessionStopResult = z.infer<typeof SessionStopResultSchema>;

export const SessionArchiveResultSchema = z.object({
  sessionId: z.string().min(1),
  archivedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionArchiveResult = z.infer<typeof SessionArchiveResultSchema>;

export const SessionUnarchiveResultSchema = z.object({
  sessionId: z.string().min(1),
  archivedAt: z.null(),
}).passthrough();
export type SessionUnarchiveResult = z.infer<typeof SessionUnarchiveResultSchema>;

export const SessionSetTitleResultSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
}).passthrough();
export type SessionSetTitleResult = z.infer<typeof SessionSetTitleResultSchema>;

export const SessionSetPermissionModeResultSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionSetPermissionModeResult = z.infer<typeof SessionSetPermissionModeResultSchema>;

export const SessionSetModelResultSchema = z.object({
  sessionId: z.string().min(1),
  modelId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();
export type SessionSetModelResult = z.infer<typeof SessionSetModelResultSchema>;

export const SessionHistoryCompactMessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  role: z.string().min(1),
  kind: z.string().min(1),
  text: z.string(),
  structuredKind: z.string().min(1).optional(),
}).passthrough();
export type SessionHistoryCompactMessage = z.infer<typeof SessionHistoryCompactMessageSchema>;

export const SessionHistoryRawMessageSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  role: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
}).passthrough();
export type SessionHistoryRawMessage = z.infer<typeof SessionHistoryRawMessageSchema>;

export const SessionHistoryResultSchema = z.discriminatedUnion('format', [
  z.object({
    sessionId: z.string().min(1),
    format: z.literal('compact'),
    messages: z.array(SessionHistoryCompactMessageSchema),
  }).passthrough(),
  z.object({
    sessionId: z.string().min(1),
    format: z.literal('raw'),
    messages: z.array(SessionHistoryRawMessageSchema),
  }).passthrough(),
]);
export type SessionHistoryResult = z.infer<typeof SessionHistoryResultSchema>;

export const SessionRunStartResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  callId: z.string().min(1),
  intent: z.string().min(1),
  backendId: z.string().min(1),
}).passthrough();
export type SessionRunStartResult = z.infer<typeof SessionRunStartResultSchema>;

export const SessionRunListResultSchema = z.object({
  sessionId: z.string().min(1),
  runs: z.array(ExecutionRunPublicStateSchema),
}).passthrough();
export type SessionRunListResult = z.infer<typeof SessionRunListResultSchema>;

export const SessionRunGetResultSchema = z.object({
  sessionId: z.string().min(1),
  run: ExecutionRunPublicStateSchema,
  latestToolResult: SubAgentRunResultV2Schema.optional(),
  structuredMeta: z.object({ kind: z.string().min(1), payload: z.unknown() }).passthrough().optional(),
}).passthrough();
export type SessionRunGetResult = z.infer<typeof SessionRunGetResultSchema>;

export const SessionRunSendResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  sent: z.literal(true),
}).passthrough();
export type SessionRunSendResult = z.infer<typeof SessionRunSendResultSchema>;

export const SessionRunStopResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  stopped: z.literal(true),
}).passthrough();
export type SessionRunStopResult = z.infer<typeof SessionRunStopResultSchema>;

export const SessionRunActionResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  actionId: z.string().min(1),
  updatedToolResult: SubAgentRunResultV2Schema.optional(),
}).passthrough();
export type SessionRunActionResult = z.infer<typeof SessionRunActionResultSchema>;

export const SessionRunWaitResultSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
}).passthrough();
export type SessionRunWaitResult = z.infer<typeof SessionRunWaitResultSchema>;

export const SessionRunStreamStartResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .merge(ExecutionRunTurnStreamStartResponseSchema)
  .passthrough();
export type SessionRunStreamStartResult = z.infer<typeof SessionRunStreamStartResultSchema>;

export const SessionRunStreamReadResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .merge(ExecutionRunTurnStreamReadResponseSchema)
  .passthrough();
export type SessionRunStreamReadResult = z.infer<typeof SessionRunStreamReadResultSchema>;

export const SessionRunStreamCancelResultSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    streamId: z.string().min(1),
    cancelled: z.literal(true),
  })
  .passthrough();
export type SessionRunStreamCancelResult = z.infer<typeof SessionRunStreamCancelResultSchema>;

export const SessionListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_list'),
  data: SessionListResultSchema,
});

export const SessionHistoryEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_history'),
  data: SessionHistoryResultSchema,
});

export const SessionRunGetEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_get'),
  data: SessionRunGetResultSchema,
});

export const SessionStatusEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_status'),
  data: SessionStatusResultSchema,
});

export const SessionCreateEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_create'),
  data: SessionCreateResultSchema,
});

export const SessionSendEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_send'),
  data: SessionSendResultSchema,
});

export const SessionWaitEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_wait'),
  data: SessionWaitResultSchema,
});

export const SessionStopEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_stop'),
  data: SessionStopResultSchema,
});

export const SessionArchiveEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_archive'),
  data: SessionArchiveResultSchema,
});

export const SessionUnarchiveEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_unarchive'),
  data: SessionUnarchiveResultSchema,
});

export const SessionSetTitleEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_title'),
  data: SessionSetTitleResultSchema,
});

export const SessionSetPermissionModeEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_permission_mode'),
  data: SessionSetPermissionModeResultSchema,
});

export const SessionSetModelEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_set_model'),
  data: SessionSetModelResultSchema,
});

export const SessionRunStartEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_start'),
  data: SessionRunStartResultSchema,
});

export const SessionRunListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_list'),
  data: SessionRunListResultSchema,
});

export const SessionRunSendEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_send'),
  data: SessionRunSendResultSchema,
});

export const SessionRunStopEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stop'),
  data: SessionRunStopResultSchema,
});

export const SessionRunActionEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_action'),
  data: SessionRunActionResultSchema,
});

export const SessionRunWaitEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_wait'),
  data: SessionRunWaitResultSchema,
});

export const SessionRunStreamStartEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_start'),
  data: SessionRunStreamStartResultSchema,
});

export const SessionRunStreamReadEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_read'),
  data: SessionRunStreamReadResultSchema,
});

export const SessionRunStreamCancelEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_run_stream_cancel'),
  data: SessionRunStreamCancelResultSchema,
});

export const AuthStatusEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('auth_status'),
  data: AuthStatusResultSchema,
});

export const SessionControlActionSpecSummarySchema = z
  .object({
    id: ActionIdSchema,
    title: z.string().min(1),
    description: z.string().min(1).nullable(),
    safety: ActionSafetySchema,
    placements: z.array(ActionUiPlacementSchema),
    slash: z
      .object({
        tokens: z.array(z.string().min(1)),
      })
      .passthrough()
      .nullable(),
    bindings: z
      .object({
        voiceClientToolName: z.string().min(1).optional(),
        mcpToolName: z.string().min(1).optional(),
      })
      .passthrough()
      .nullable(),
    examples: z
      .object({
        voice: z
          .object({
            argsExample: z.string().min(1).optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        mcp: z
          .object({
            argsExample: z.string().min(1).optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable(),
    surfaces: ActionSurfaceSchema,
    inputHints: ActionInputHintsSchema.nullable(),
  })
  .passthrough();
export type SessionControlActionSpecSummary = z.infer<typeof SessionControlActionSpecSummarySchema>;

export const SessionActionsListResultSchema = z
  .object({
    actionSpecs: z.array(SessionControlActionSpecSummarySchema),
  })
  .passthrough();
export type SessionActionsListResult = z.infer<typeof SessionActionsListResultSchema>;

export const SessionActionsDescribeResultSchema = z
  .object({
    actionSpec: SessionControlActionSpecSummarySchema,
  })
  .passthrough();
export type SessionActionsDescribeResult = z.infer<typeof SessionActionsDescribeResultSchema>;

export const SessionActionsListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_actions_list'),
  data: SessionActionsListResultSchema,
});

export const SessionActionsDescribeEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('session_actions_describe'),
  data: SessionActionsDescribeResultSchema,
});
