import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ActionInputPredicateSchema, type ActionInputPredicate } from './actionInputPredicates.js';
import { MemorySearchQueryV1Schema } from '../memory/memorySearch.js';
import { ApprovalRequestCreatedBySchema, ApprovalRequestOriginV1Schema } from '../approvals/approvalRequestV1.js';
import { PromptRegistryConfiguredSourceV1Schema } from '../promptLibrary/promptRegistriesV1.js';
import { PromptAssetInstallModeV1Schema, PromptAssetScopeV1Schema } from '../promptLibrary/promptAssetsV1.js';
import { BackendTargetKeySchema, BackendTargetRefSchema, buildBackendTargetKey, parseBackendTargetKey } from '../backendTargets/backendTargetRef.js';
import { ExecutionRunListRequestSchema } from '../executionRunListRequest.js';
import { ExecutionRunStartRequestSchema } from '../executionRunStartRequest.js';
import { SessionRollbackTargetSchema } from '../sessionRollback.js';
import { SessionForkRpcParamsSchema } from '../sessionFork.js';
import { PendingFirstInputV1Schema } from '../spawnSession.js';
import { SessionSpawnSourceContextV1Schema } from '../sessionSpawnSourceContextV1.js';
import { SessionHandoffWorkspaceTransferSchema } from '../sessionControl/handoff/handoffSchemas.js';
import { ActionApprovalSchema, type ActionApproval } from './actionApprovalMetadata.js';
import {
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
} from '../sessionWorkState/sessionWorkStateRpc.js';
import { SessionTerminalComposerClearRequestV1Schema } from '../sessionControl/sessionTerminalComposerClearV1.js';
import { SessionPendingInputInterruptAndRunRequestV1Schema } from '../sessionControl/sessionPendingInputInterruptAndRunV1.js';
import { PendingRequestedActionV1Schema } from '../sessionMessages/pendingRequestedActionV1.js';
import { SessionWorkStateStatusV1Schema } from '../sessionWorkState/sessionWorkStateV1.js';
import { STRUCTURED_QUESTION_LIMITS } from '../tools/structuredQuestionAnswersV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessionMetadata/metadataOverridesV1.js';
import { SessionPermissionModeInputSchema } from '../sessionMetadata/sessionPermissionModes.js';
import { AgentRuntimeDescriptorV1Schema } from '../sessionMetadata/agentRuntimeDescriptorV1.js';
import { SessionMcpSelectionV1Schema } from '../mcpServers/sessionSelectionV1.js';
import { ConnectedServiceBindingsV1Schema } from '../connect/connectedServiceBindings.js';
import {
  SpawnConfigOptionValueSchema,
  findSpawnConfigOptionAliasConflicts,
} from './sessionSpawnConfigOptions.js';
import {
  EXECUTION_RUN_ACTION_PERMISSION_MODES,
  EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
  ExecutionRunActionPermissionModeSchema,
} from './executionRunActionPermissionMode.js';
import {
  ActionOperationDeclarationV1Schema,
  type ActionOperationDeclarationV1,
} from './operations/actionOperationDeclarationV1.js';

export {
  ActionApprovalFlowSchema,
  ActionApprovalResultSchema,
  ActionApprovalSchema,
  resolveActionApprovalFlow,
  type ActionApproval,
  type ActionApprovalFlow,
  type ActionApprovalResult,
} from './actionApprovalMetadata.js';
export {
  ActionOperationDeclarationV1Schema,
  type ActionOperationDeclarationV1,
} from './operations/actionOperationDeclarationV1.js';

const ZodSchemaLike = z.custom<z.ZodTypeAny>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' });

export const ActionSurfaceSchema = z.object({
  ui_button: z.boolean(),
  ui_slash_command: z.boolean(),
  voice_tool: z.boolean(),
  voice_action_block: z.boolean(),
  session_agent: z.boolean(),
  mcp: z.boolean(),
  cli: z.boolean(),
}).strict();
export type ActionSurfaces = z.infer<typeof ActionSurfaceSchema>;

export const ActionToolExposureModeSchema = z.enum(['direct', 'discoverable_only']);
export type ActionToolExposureMode = z.infer<typeof ActionToolExposureModeSchema>;

export const ActionToolExposureSurfaceSchema = z.enum(['session_agent', 'mcp', 'cli']);
export type ActionToolExposureSurface = z.infer<typeof ActionToolExposureSurfaceSchema>;

export const ActionToolExposureSchema = z.object({
  session_agent: ActionToolExposureModeSchema.optional(),
  mcp: ActionToolExposureModeSchema.optional(),
  cli: ActionToolExposureModeSchema.optional(),
}).strict();
export type ActionToolExposure = z.infer<typeof ActionToolExposureSchema>;

export const ActionSafetySchema = z.enum(['safe', 'danger']);
export type ActionSafety = z.infer<typeof ActionSafetySchema>;

export const ActionInputWidgetSchema = z.enum(['text', 'textarea', 'text_list', 'select', 'multiselect', 'toggle', 'checkbox']);
export type ActionInputWidget = z.infer<typeof ActionInputWidgetSchema>;

export const ActionInputOptionSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type ActionInputOption = z.infer<typeof ActionInputOptionSchema>;

export const ActionInputFieldHintSchema = z
  .object({
    /**
     * Dot-path in the action input object, e.g. `engineIds` or `base.kind`.
     *
     * This is UI/elicitation metadata only; the canonical validation remains the action `inputSchema`.
     */
    path: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    widget: ActionInputWidgetSchema,
    /**
     * Only used for `widget='text_list'`.
     *
     * This is UI/elicitation metadata only; canonical validation remains the action `inputSchema`.
     */
    listSeparator: z.enum(['comma', 'newline']).optional(),
    required: z.boolean().optional(),
    /**
     * When true, draft/launcher UIs should keep this field empty until the user
     * explicitly picks a value instead of auto-seeding or auto-selecting one.
     */
    requireExplicitSelection: z.boolean().optional(),
    options: z.array(ActionInputOptionSchema).optional(),
    optionsSourceId: z.string().min(1).optional(),
    visibleWhen: ActionInputPredicateSchema.optional(),
    requiredWhen: ActionInputPredicateSchema.optional(),
    disabledWhen: ActionInputPredicateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const widget = (value as any).widget as string;
    const options = Array.isArray((value as any).options) ? (value as any).options : null;
    const optionsSourceId = typeof (value as any).optionsSourceId === 'string' ? (value as any).optionsSourceId.trim() : '';

    if (widget === 'select' || widget === 'multiselect') {
      const hasOptions = Array.isArray(options) && options.length > 0;
      const hasSource = Boolean(optionsSourceId);
      if (!hasOptions && !hasSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${widget} requires options or optionsSourceId`,
          path: ['options'],
        });
      }
    }

    if (widget === 'text_list') {
      const listSeparator = (value as any).listSeparator;
      if (listSeparator !== 'comma' && listSeparator !== 'newline') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'text_list requires listSeparator',
          path: ['listSeparator'],
        });
      }
    }
  });
export type ActionInputFieldHint = z.infer<typeof ActionInputFieldHintSchema>;

export const ActionInputHintsSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    fields: z.array(ActionInputFieldHintSchema).default([]),
  })
  .strict();
export type ActionInputHints = z.infer<typeof ActionInputHintsSchema>;

export const ActionPromptingSchema = z
  .object({
    voiceHotPath: z.boolean().optional(),
  })
  .strict();
export type ActionPrompting = z.infer<typeof ActionPromptingSchema>;

export const ActionSpecSchema = z.object({
  id: ActionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  safety: ActionSafetySchema,
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z.array(ActionUiPlacementSchema).default([]),
  // Optional stable slash command token for ui_slash_command.
  slash: z.object({
    tokens: z.array(z.string().min(1)),
  }).passthrough().optional(),
  bindings: z.object({
    // Tool name the voice client is allowed to expose (surface.voice_tool).
    voiceClientToolName: z.string().min(1).optional(),
    // Tool name for MCP surface (surface.mcp).
    mcpToolName: z.string().min(1).optional(),
  }).passthrough().optional(),
  examples: z
    .object({
      voice: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
      mcp: z
        .object({
          argsExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  prompting: ActionPromptingSchema.optional(),
  operation: ActionOperationDeclarationV1Schema.optional(),
  toolExposure: ActionToolExposureSchema.optional(),
  approval: ActionApprovalSchema,
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
}).passthrough();

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
  operation?: ActionOperationDeclarationV1;
}>;

const EmptyObjectSchema = z.object({}).strict();
const OptionalSessionIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough();

const SessionIdRequiredInputSchema = z.object({
  sessionId: z.string().min(1),
}).passthrough();

const SessionTitleSetInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1),
}).passthrough();

const SessionPermissionModeSetInputSchema = z.object({
  sessionId: z.string().min(1),
  permissionMode: z.string().trim().min(1),
}).passthrough();

const SessionModelSetInputSchema = z.object({
  sessionId: z.string().min(1),
  modelId: z.string().refine((value) => value.trim().length > 0, { message: 'Model ID must not be blank' }),
}).passthrough();

const SessionStatusGetInputSchema = z.object({
  sessionId: z.string().min(1),
  live: z.boolean().optional(),
}).passthrough();

const SessionHistoryGetInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(250).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
}).passthrough();

const SessionTranscriptRoleSchema = z.enum(['user', 'assistant']);
const SessionTranscriptScopeSchema = z.enum(['main', 'sidechain', 'all']);
const SessionTranscriptDirectionSchema = z.enum(['before', 'after']);

export const SessionTranscriptGetInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: SessionTranscriptDirectionSchema.optional(),
  scope: SessionTranscriptScopeSchema.optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionTranscriptRoleSchema).optional(),
  includeTools: z.boolean().optional(),
  includeReasoning: z.boolean().optional(),
  includeEvents: z.boolean().optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
  maxRawPayloadChars: z.number().int().min(0).max(32768).nullable().optional(),
}).passthrough();
export type SessionTranscriptGetInput = z.infer<typeof SessionTranscriptGetInputSchema>;
export type SessionTranscriptGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  role: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;
export type SessionTranscriptGetOutput =
  | Readonly<{
    ok: true;
    sessionId: string;
    items: readonly SessionTranscriptGetItem[];
    nextCursor: string | null;
    hasMore: boolean;
    diagnostics?: Readonly<{
      rawRowsScanned: number;
      pagesFetched: number;
      scanLimitReached: boolean;
    }>;
  }>
  | Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
    candidates?: readonly string[];
  }>;

const SessionEventRoleSchema = z.enum(['event', 'agent', 'user', 'unknown']);

export const SessionEventsGetInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  direction: SessionTranscriptDirectionSchema.optional(),
  scope: SessionTranscriptScopeSchema.optional(),
  sidechainId: z.string().min(1).nullable().optional(),
  roles: z.array(SessionEventRoleSchema).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  format: z.enum(['compact', 'raw']).optional(),
  includeMeta: z.boolean().optional(),
  includeStructuredPayload: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  maxTextChars: z.number().int().min(0).max(4000).optional(),
  maxPayloadChars: z.number().int().min(0).max(32768).optional(),
}).passthrough();
export type SessionEventsGetInput = z.infer<typeof SessionEventsGetInputSchema>;
export type SessionEventsGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: 'user' | 'agent' | 'event' | 'unknown';
  semanticRole: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  provider?: string;
  text?: string;
  summary?: string;
  toolName?: string;
  callId?: string;
  raw?: unknown;
  truncated?: boolean;
  rawTruncated?: boolean;
}>;
export type SessionEventsGetOutput =
  | Readonly<{
    ok: true;
    sessionId: string;
    items: readonly SessionEventsGetItem[];
    nextCursor: string | null;
    hasMore: boolean;
    diagnostics?: Readonly<{
      rawRowsScanned: number;
      pagesFetched: number;
      scanLimitReached: boolean;
      payloadTruncations: number;
    }>;
  }>
  | Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
    candidates?: readonly string[];
  }>;

const SessionWaitIdleInputSchema = z.object({
  sessionId: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough();

const SessionGoalSetInputSchema = z.object({
  sessionId: z.string().min(1),
  objective: z.string().trim().min(1).max(4000).optional(),
  status: SessionWorkStateStatusV1Schema.optional(),
  tokenBudget: z.number().finite().positive().nullable().optional(),
}).passthrough().refine((value) => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
), { message: 'At least one goal mutation field is required' });

const SessionCatalogListInputSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1).optional(),
}).passthrough();

const IntentStartCommonSchema = z.object({
  sessionId: z.string().min(1).optional(),
  backendTargetKeys: z.array(BackendTargetKeySchema).min(1),
  instructions: z.string().trim().min(1),
  permissionMode: ExecutionRunActionPermissionModeSchema.optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
  // Optional model selection for every fanned-out run, using the SAME canonical shape as
  // session spawn (`session.spawn_new`'s `modelId`). Omit to use each backend's default model.
  modelId: z.string().min(1).optional(),
  // Optional config-option overrides applied to every fanned-out run, using the SAME canonical
  // vocabulary as session spawn. Reasoning effort is the `reasoning_effort` option. Provide either
  // the canonical `sessionConfigOptionOverrides` object or the agent-friendly `configOptions`
  // shorthand (e.g. { reasoning_effort: "high" }); they are merged at the action boundary and a
  // conflicting value in both forms is a typed rejection.
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  configOptions: z.record(z.string().min(1), SpawnConfigOptionValueSchema).optional(),
  // Optional connected-services selection applied to every fanned-out target. Accepts the simple
  // string form (e.g. "openai-codex:group:happier" or "openai-codex:team") or a full bindings
  // object; normalized at the action boundary. Omit to use each account's default.
  connectedServices: z.unknown().optional(),
  // Optional per-target override keyed by backend target key (e.g. { "agent:codex": "openai-codex:team" }).
  // A per-target entry wins over the blanket `connectedServices` for that target.
  connectedServicesByBackendTargetKey: z.record(z.string().min(1), z.unknown()).optional(),
}).passthrough();

const PlanStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const DelegateStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('workspace_write'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const VoiceAgentStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: ExecutionRunActionPermissionModeSchema.default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('long_lived'),
  ioMode: z.enum(['request_response', 'streaming']).default('streaming'),
}).passthrough();

const ExecutionRunIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1),
}).passthrough();

const ExecutionRunStartInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  intent: z.enum(['review', 'plan', 'delegate', 'voice_agent', 'memory_hints']),
  backendTarget: BackendTargetRefSchema,
  instructions: z.string().optional(),
  display: z.unknown().optional(),
  permissionMode: z.string().min(1),
  retentionPolicy: z.enum(['ephemeral', 'resumable']),
  runClass: z.enum(['bounded', 'long_lived']),
  ioMode: z.enum(['request_response', 'streaming']),
  initialContextMode: z.enum(['bootstrap', 'first_turn']).optional(),
  // Optional model selection for the run's backend — SAME canonical shape as session spawn's
  // `modelId`. Omit to use the backend's default model.
  modelId: z.string().min(1).optional(),
  // Optional config-option overrides for the run, using the SAME canonical vocabulary as session
  // spawn. Reasoning effort is the `reasoning_effort` option. Provide either the canonical
  // `sessionConfigOptionOverrides` object or the `configOptions` shorthand; they are merged at the
  // action boundary and a conflicting value in both forms is a typed rejection.
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  configOptions: z.record(z.string().min(1), SpawnConfigOptionValueSchema).optional(),
  resumeHandle: z.unknown().nullable().optional(),
  replay: z.unknown().optional(),
  // Optional connected-services selection binding the run's backend to a specific account/pool
  // instead of the runner's inherited account. Accepts the simple string form
  // (e.g. "openai-codex:group:happier" or "openai-codex:team") or a full bindings object; normalized
  // at the action boundary. Omit to use the account's configured default exactly as stored (literal:
  // a profile default binds to that profile, a pool default binds to that pool — no silent upgrade).
  connectedServices: z.unknown().optional(),
}).passthrough();

const ExecutionRunGetInputSchema = ExecutionRunIdInputSchema.extend({
  includeStructured: z.boolean().optional(),
}).passthrough();

const ExecutionRunSendInputSchema = ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunActionInputSchema = ExecutionRunIdInputSchema.extend({
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();

const ExecutionRunWaitInputSchema = ExecutionRunIdInputSchema.extend({
  timeoutSeconds: z.number().int().min(1).optional(),
  pollIntervalMs: z.number().int().min(100).max(60_000).optional(),
}).passthrough();

const SessionOpenInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  sessionTitle: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!(typeof value.sessionId === 'string' && value.sessionId.trim().length > 0) && !(typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
});

/**
 * Action-facing fork recipe. The transport's parent session id is resolved from
 * the action input/context, while legacy callers may continue to omit a fork
 * point and let their host adapter apply its existing default.
 */
export const SessionForkActionInputSchema = SessionForkRpcParamsSchema
  .omit({ v: true, parentSessionId: true })
  .partial()
  .extend({ sessionId: z.string().min(1).optional() })
  .passthrough();
export type SessionForkActionInput = z.infer<typeof SessionForkActionInputSchema>;

const SessionRollbackInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  target: SessionRollbackTargetSchema.optional(),
}).passthrough();

const SessionHandoffInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  targetMachineId: z.string().min(1).optional(),
  targetSessionStorageMode: z.enum(['direct', 'persisted']).optional(),
  workspaceTransfer: SessionHandoffWorkspaceTransferSchema.optional(),
}).passthrough();

const SessionSpawnTerminalInputSchema = z.object({
  mode: z.enum(['plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.string().nullable().optional(),
  }).strict().optional(),
}).strict();

function normalizeSpawnTargetAlias(value: string): string {
  const trimmed = value.trim();
  if (BackendTargetKeySchema.safeParse(trimmed).success) return trimmed;
  return trimmed === 'customAcp' ? trimmed : `agent:${trimmed}`;
}

const SessionSpawnAttemptIdentifierSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'Spawn attempt identifier must not be blank',
});

export const SessionSpawnNewInputSchema = z.object({
  tag: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  agentId: z.string().trim().min(1).optional(),
  backend: z.string().trim().min(1).optional(),
  target: z.string().trim().min(1).optional(),
  modelId: z.string().min(1).optional(),
  backendTargetKey: BackendTargetKeySchema.optional(),
  backendTarget: BackendTargetRefSchema.optional(),
  title: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  approvedNewDirectoryCreation: z.boolean().optional(),
  host: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
  spawnNonce: SessionSpawnAttemptIdentifierSchema.optional(),
  userAttemptId: SessionSpawnAttemptIdentifierSchema.optional(),
  firstTurnLocalId: SessionSpawnAttemptIdentifierSchema.optional(),
  attachmentMessageLocalId: SessionSpawnAttemptIdentifierSchema.optional(),
  pendingFirstInput: PendingFirstInputV1Schema.optional(),
  prompt: z.string().min(1).optional(),
  initialPrompt: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
  permissionMode: SessionPermissionModeInputSchema.optional(),
  permissionModeUpdatedAt: z.number().int().optional(),
  agentModeId: z.string().min(1).optional(),
  agentModeUpdatedAt: z.number().int().optional(),
  modelUpdatedAt: z.number().int().optional(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
  configOptions: z.record(z.string().min(1), SpawnConfigOptionValueSchema).optional(),
  profileId: z.string().min(1).optional(),
  resume: z.string().trim().min(1).optional(),
  environmentVariables: z.record(z.string().min(1), z.string()).optional(),
  connectedServices: ConnectedServiceBindingsV1Schema.optional(),
  connectedServicesUpdatedAt: z.number().int().optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
  terminal: SessionSpawnTerminalInputSchema.optional(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  windowsTerminalWindowName: z.string().min(1).optional(),
  experimentalCodexAcp: z.boolean().optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
  /**
   * Typed source recipe for a configurable Replay-seeded child Session.
   *
   * When present this is required semantics: the daemon resolves the source
   * transcript and Replay seed before creating the child, and a failure creates
   * no child. This schema is `.strict()`, so a daemon that predates the field
   * rejects the whole request rather than silently creating an ordinary child.
   * This is required semantics on the Action input, not an inspection-negotiated
   * capability.
   */
  sourceContext: SessionSpawnSourceContextV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const record = value as Record<string, unknown>;
  const rejectConflictingAliases = (fields: readonly string[]) => {
    const defined = fields
      .map((field) => ({ field, value: record[field] }))
      .filter((entry): entry is { field: string; value: string } => typeof entry.value === 'string');
    if (defined.length < 2) return;
    const first = defined[0]?.value;
    if (defined.every((entry) => entry.value === first)) return;
    for (const entry of defined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fields.join('/')} aliases must agree`,
        path: [entry.field],
      });
    }
  };
  const rejectConflictingTargetAliases = () => {
    const aliases: { field: string; value: string }[] = [];
    if (typeof value.agentId === 'string') aliases.push({ field: 'agentId', value: normalizeSpawnTargetAlias(value.agentId) });
    if (typeof value.backend === 'string') aliases.push({ field: 'backend', value: normalizeSpawnTargetAlias(value.backend) });
    if (typeof value.target === 'string') aliases.push({ field: 'target', value: normalizeSpawnTargetAlias(value.target) });
    if (typeof value.backendTargetKey === 'string') {
      aliases.push({ field: 'backendTargetKey', value: value.backendTargetKey });
    }
    if (value.backendTarget) {
      aliases.push({ field: 'backendTarget', value: buildBackendTargetKey(value.backendTarget) });
    }
    const concreteValues = aliases.map((alias) => alias.value).filter((alias) => alias !== 'customAcp');
    const hasCustomAcpAlias = aliases.some((alias) => alias.value === 'customAcp');
    if (aliases.length < 2 && !hasCustomAcpAlias) return;

    const hasConflictingConcreteTargets = new Set(concreteValues).size > 1;
    const hasBuiltInTarget = concreteValues.some((alias) => alias.startsWith('agent:'));
    const hasConcreteAcpTarget = concreteValues.some((alias) => alias.startsWith('acpBackend:'));
    if (!hasConflictingConcreteTargets && !(hasCustomAcpAlias && hasBuiltInTarget) && !(hasCustomAcpAlias && !hasConcreteAcpTarget)) return;

    for (const alias of aliases) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'spawn target aliases must agree',
        path: [alias.field],
      });
    }
  };
  const rejectConflictingConfigAliases = () => {
    for (const conflict of findSpawnConfigOptionAliasConflicts({
      sessionConfigOptionOverrides: value.sessionConfigOptionOverrides,
      configOptions: value.configOptions,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'configOptions must agree with sessionConfigOptionOverrides',
        path: ['configOptions', conflict.optionId],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sessionConfigOptionOverrides must agree with configOptions',
        path: ['sessionConfigOptionOverrides', 'overrides', conflict.optionId, 'value'],
      });
    }
  };

  rejectConflictingAliases(['path', 'directory']);
  rejectConflictingAliases(['prompt', 'initialPrompt', 'initialMessage']);
  rejectConflictingTargetAliases();
  rejectConflictingConfigAliases();
});
export type SessionSpawnNewInput = z.infer<typeof SessionSpawnNewInputSchema>;

const SessionSpawnPickerInputSchema = z.object({
  tag: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
}).passthrough();

const PathsListRecentInputSchema = z.object({
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).passthrough();

const MachinesListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const ServersListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const ReviewEnginesListInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  includeDisabled: z.boolean().optional(),
}).passthrough();

const AgentsBackendsListInputSchema = z.object({
  includeDisabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

const AgentsModelsListInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: BackendTargetKeySchema.optional(),
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  if (value.agentId === 'customAcp' && !value.backendTargetKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTargetKey is required for customAcp',
      path: ['backendTargetKey'],
    });
  }
  if (value.agentId && value.backendTargetKey) {
    const parsedTarget = parseBackendTargetKey(value.backendTargetKey);
    const derivedAgentId = parsedTarget.kind === 'builtInAgent' ? parsedTarget.agentId : 'customAcp';
    if (value.agentId !== derivedAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agentId must match backendTargetKey when both are provided',
        path: ['agentId'],
      });
    }
  }
});

const AgentsSessionModesListInputSchema = AgentsModelsListInputSchema;
const AgentsConfigOptionsListInputSchema = AgentsModelsListInputSchema;

const SpawnDiscoveryAgentContextInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: BackendTargetKeySchema.optional(),
  includeDisabled: z.boolean().optional(),
  includeUnavailable: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.agentId && value.backendTargetKey) {
    const parsedTarget = parseBackendTargetKey(value.backendTargetKey);
    const derivedAgentId = parsedTarget.kind === 'builtInAgent' ? parsedTarget.agentId : 'customAcp';
    if (value.agentId !== derivedAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agentId must match backendTargetKey when both are provided',
        path: ['agentId'],
      });
    }
  }
});

const SessionsSpawnProfilesListInputSchema = SpawnDiscoveryAgentContextInputSchema;
const SessionsSpawnConnectedServicesListInputSchema = SpawnDiscoveryAgentContextInputSchema;

const SessionsSpawnMcpServersPreviewInputSchema = z.object({
  agentId: z.string().min(1).optional(),
  backendTargetKey: BackendTargetKeySchema.optional(),
  machineId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  selection: SessionMcpSelectionV1Schema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.agentId && value.backendTargetKey) {
    const parsedTarget = parseBackendTargetKey(value.backendTargetKey);
    const derivedAgentId = parsedTarget.kind === 'builtInAgent' ? parsedTarget.agentId : 'customAcp';
    if (value.agentId !== derivedAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agentId must match backendTargetKey when both are provided',
        path: ['agentId'],
      });
    }
  }
  if (value.path && value.directory && value.path !== value.directory) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'path and directory aliases must agree',
      path: ['directory'],
    });
  }
});

const ActionSpecSearchInputSchema = z.object({
  query: z.string().trim().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const ActionSpecGetInputSchema = z.object({
  id: z.string().min(1),
}).passthrough();

const ActionOptionsResolveInputSchema = z.object({
  actionId: z.string().min(1).optional(),
  fieldPath: z.string().min(1).optional(),
  optionsSourceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().optional(),
}).passthrough().superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'actionId + fieldPath or optionsSourceId is required',
      path: ['actionId'],
    });
  }
});

const SessionSendMessageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  permissionModeOverride: z.string().trim().min(1).optional(),
  modelOverride: z.union([
    z.string().refine((value) => value.trim().length > 0, { message: 'Model override must not be blank' }),
    z.null(),
  ]).optional(),
  wait: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough();

const SessionPermissionRespondInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']),
  requestId: z.string().min(1).optional(),
}).passthrough();

const SessionUserActionAnswerItemSchema = z.object({
  question: z.string()
    .min(1)
    .max(STRUCTURED_QUESTION_LIMITS.maxStringLength)
    .refine((value) => value.trim().length > 0, { message: 'question must not be blank' }),
  values: z.array(z.string().max(STRUCTURED_QUESTION_LIMITS.maxStringLength))
    .min(1)
    .max(STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion)
    .optional(),
  answer: z.string().min(1).max(STRUCTURED_QUESTION_LIMITS.maxStringLength).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.answer !== undefined && value.values !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer and values cannot both be provided' });
  }
  if (value.answer === undefined && value.values === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer or values is required' });
  }
});

const SessionUserActionAnswerInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema)
    .min(1)
    .max(STRUCTURED_QUESTION_LIMITS.maxQuestions)
    .optional(),
  updatedPermissions: z.unknown().optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const seenQuestions = new Set<string>();
  for (const [index, entry] of (value.answers ?? []).entries()) {
    if (seenQuestions.has(entry.question)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate question', path: ['answers', index, 'question'] });
    }
    seenQuestions.add(entry.question);
    if (entry.values && new Set(entry.values).size !== entry.values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate answer value', path: ['answers', index, 'values'] });
    }
  }
  const decision = typeof value.decision === 'string' ? value.decision : null;
  if (hasAnswers && decision && decision !== 'approve') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answers cannot accompany a rejecting decision', path: ['decision'] });
  }
  if (!hasAnswers && !decision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'decision or answers is required',
      path: ['decision'],
    });
  }
  if (decision === 'request_changes' && !(typeof value.reason === 'string' && value.reason.trim().length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reason is required when decision=request_changes',
      path: ['reason'],
    });
  }
});

const SessionModeSetInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  modeId: z.string().min(1),
}).passthrough();

const SessionPrimaryTargetInputSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  sessionTitle: z.string().trim().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasSessionId = value.sessionId === null || (typeof value.sessionId === 'string' && value.sessionId.trim().length > 0);
  const hasSessionTitle = typeof value.sessionTitle === 'string' && value.sessionTitle.trim().length > 0;
  if (!hasSessionId && !hasSessionTitle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sessionId or sessionTitle is required',
      path: ['sessionId'],
    });
  }
});

const SessionTrackedTargetsInputSchema = z.object({
  sessionIds: z.array(z.string().min(1)).max(50),
}).passthrough();

const SessionListInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeLastMessagePreview: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  archivedOnly: z.boolean().optional(),
  includeSystem: z.boolean().optional(),
  resumableOnly: z.boolean().optional(),
  includeRows: z.boolean().optional(),
}).passthrough();

const SessionActivityInputSchema = z.object({
  sessionId: z.string().min(1),
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
}).passthrough();

const SessionRecentMessagesInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeUser: z.boolean().optional(),
  includeAssistant: z.boolean().optional(),
  maxCharsPerMessage: z.number().int().min(0).max(50_000).nullable().optional(),
}).passthrough();

const MemorySearchInputSchema = z.object({
  machineId: z.string().min(1),
  query: MemorySearchQueryV1Schema,
}).passthrough();

const MemoryGetWindowInputSchema = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
});

const MemoryEnsureUpToDateInputSchema = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).passthrough();

const ApprovalRequestCreateInputSchema = z.object({
  actionId: ActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().min(1),
  createdBy: ApprovalRequestCreatedBySchema,
  origin: ApprovalRequestOriginV1Schema.optional(),
  preview: z.unknown().optional(),
}).passthrough();

const ApprovalRequestDecideInputSchema = z.object({
  artifactId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
}).passthrough();

const PromptDocUpdateInputSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough();

const PromptBundleUpdateInputSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  skillMarkdown: z.string(),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
}).passthrough();

const PromptAssetExportInputSchema = z.object({
  artifactId: z.string().min(1),
  machineId: z.string().min(1),
  assetTypeId: z.string().min(1),
  scope: PromptAssetScopeV1Schema,
  directory: z.string().min(1).optional(),
  targetPath: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
  installMode: PromptAssetInstallModeV1Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasDocTarget = typeof value.targetPath === 'string' && value.targetPath.trim().length > 0;
  const hasBundleTarget = typeof value.targetName === 'string' && value.targetName.trim().length > 0;
  if (!hasDocTarget && !hasBundleTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetPath or targetName is required',
      path: ['targetPath'],
    });
  }
});

const PromptRegistryInstallInputSchema = z.object({
  machineId: z.string().min(1),
  sourceId: z.string().min(1),
  itemId: z.string().min(1),
  configuredSources: z.array(PromptRegistryConfiguredSourceV1Schema).default([]),
  installTarget: z.object({
    assetTypeId: z.string().min(1),
    scope: PromptAssetScopeV1Schema,
    directory: z.string().min(1).optional(),
    targetName: z.string().min(1),
    installMode: PromptAssetInstallModeV1Schema.optional(),
  }).optional(),
}).passthrough();

const APPROVAL_RESULT_REQUIRED: ActionApproval = Object.freeze({ result: 'required' });
const APPROVAL_RESULT_NONE: ActionApproval = Object.freeze({ result: 'none' });
const APPROVAL_RESULT_OPTIONAL_DEFERRED: ActionApproval = Object.freeze({ result: 'optional', flow: 'deferred' });

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze([
  {
    id: 'action.spec.search',
    title: 'Search action specs',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: false,
    },
    inputHints: {
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    inputSchema: ActionSpecSearchInputSchema,
  },
  {
    id: 'action.spec.get',
    title: 'Get action spec',
    description: 'Get one Happier action spec with input hints and examples.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: false,
    },
    inputHints: {
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
      ],
    },
    inputSchema: ActionSpecGetInputSchema,
  },
  {
    id: 'action.options.resolve',
    title: 'Resolve action options',
    description: 'Resolve valid options for an action field, including dynamic options sources.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: false,
    },
    inputHints: {
      title: 'Resolve action options',
      description: 'Use this when an action field has static options or an optionsSourceId.',
      fields: [
        { path: 'actionId', title: 'Action id', description: 'Optional when optionsSourceId is provided directly.', widget: 'text' },
        { path: 'fieldPath', title: 'Field path', description: 'Dot-path for the action input field.', widget: 'text' },
        { path: 'optionsSourceId', title: 'Options source id', description: 'Direct options source lookup when known.', widget: 'text' },
        { path: 'sessionId', title: 'Session id', description: 'Needed for session-scoped option sources.', widget: 'text' },
        { path: 'query', title: 'Query filter', description: 'Optional search text to filter the returned options.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of options to return.', widget: 'text' },
      ],
    },
    inputSchema: ActionOptionsResolveInputSchema,
  },
  {
    id: 'review.start',
    title: 'Start review',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Start one or more parallel review runs against the current worktree.',
      fields: [
        {
          path: 'engineIds',
          title: 'Review engines',
          description: 'Select one or more engines. Each engine runs as its own execution run.',
          widget: 'multiselect',
          required: true,
          requireExplicitSelection: true,
          optionsSourceId: 'review.engines.available',
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the reviewers to focus on.',
          widget: 'textarea',
        },
        {
          path: 'changeType',
          title: 'Change type',
          description: 'Which changes to review.',
          widget: 'select',
          required: true,
          options: [
            { value: 'committed', label: 'Committed' },
            { value: 'uncommitted', label: 'Uncommitted' },
            { value: 'all', label: 'All' },
          ],
        },
        {
          path: 'base.kind',
          title: 'Base selection',
          description: 'How to define the review base for tools that need it (e.g. CodeRabbit).',
          widget: 'select',
          required: true,
          options: [
            { value: 'none', label: 'None' },
            { value: 'branch', label: 'Base branch' },
            { value: 'commit', label: 'Base commit' },
          ],
        },
        {
          path: 'base.baseBranch',
          title: 'Base branch',
          description: 'Branch name to diff against (when base.kind=branch).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
        },
        {
          path: 'base.baseCommit',
          title: 'Base commit',
          description: 'Commit SHA to diff against (when base.kind=commit).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
        },
        {
          path: 'engines.coderabbit.configFiles',
          title: 'CodeRabbit config files',
          description: 'Optional extra config file(s) to pass to CodeRabbit via --config.',
          widget: 'text_list',
          listSeparator: 'comma',
          visibleWhen: { op: 'includes', path: 'engineIds', value: 'coderabbit' },
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputSchema: ReviewStartInputSchema,
  },
  {
    id: 'subagents.plan.start',
    title: 'Start plan run',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'subagents_plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start Happier-managed planning runs using explicit agent provider/backend targets.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select the agent provider/backend targets to use. These choose agent implementations, not parallelism capacity slots.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the planner(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'modelId',
          title: 'Model',
          description: 'Optional. Model id for the run(s), using the SAME shape as session spawn. Applies to every target; omit to use each backend\'s default model. Enumerate valid ids with the agents.models.available options source.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional. Per-run config options using the SAME vocabulary as session spawn, e.g. { "reasoning_effort": "high" }. Reasoning effort is the reasoning_effort option (values are backend-specific, e.g. Codex low|medium|high|xhigh). Merged with sessionConfigOptionOverrides; a conflicting value in both forms is rejected.',
          widget: 'text',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (account/pool)',
          description: 'Optional. Bind these runs to a connected account or pool instead of the runner\'s inherited account. Simple form: "openai-codex:group:<poolId>" (a pool — auto-rotates when autoSwitch is enabled), "openai-codex:<profileId>" (a single account), "openai-codex:native" (opt out), or a full { v:1, bindingsByServiceId } object. Applies to every target; omit to use each account\'s configured default exactly as stored (literal: a profile default binds to that profile, a pool default to that pool — no silent upgrade; to rotate, store a pool default or pass a pool selection).',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target',
          description: 'Optional per-target override, e.g. { "agent:codex": "openai-codex:group:<poolId>" }. A per-target entry wins over connectedServices for that target.',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Plan the changes."}' },
    },
	    surfaces: {
	      ui_button: true,
	      ui_slash_command: true,
	      voice_tool: true,
	      voice_action_block: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	    },
	    inputSchema: PlanStartInputSchema,
	  },
  {
    id: 'subagents.delegate.start',
    title: 'Start delegate run',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'subagents_delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start Happier-managed delegation runs using explicit agent provider/backend targets.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select the agent provider/backend targets to use. These choose agent implementations, not parallelism capacity slots.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the delegate(s) to do.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'permissionMode',
          title: 'Permission mode',
          description: EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
          widget: 'select',
          options: EXECUTION_RUN_ACTION_PERMISSION_MODES.map((value) => ({ value, label: value })),
        },
        {
          path: 'modelId',
          title: 'Model',
          description: 'Optional. Model id for the run(s), using the SAME shape as session spawn. Applies to every target; omit to use each backend\'s default model. Enumerate valid ids with the agents.models.available options source.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional. Per-run config options using the SAME vocabulary as session spawn, e.g. { "reasoning_effort": "high" }. Reasoning effort is the reasoning_effort option (values are backend-specific, e.g. Codex low|medium|high|xhigh). Merged with sessionConfigOptionOverrides; a conflicting value in both forms is rejected.',
          widget: 'text',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (account/pool)',
          description: 'Optional. Bind these runs to a connected account or pool instead of the runner\'s inherited account. Simple form: "openai-codex:group:<poolId>" (a pool — auto-rotates when autoSwitch is enabled), "openai-codex:<profileId>" (a single account), "openai-codex:native" (opt out), or a full { v:1, bindingsByServiceId } object. Applies to every target; omit to use each account\'s configured default exactly as stored (literal: a profile default binds to that profile, a pool default to that pool — no silent upgrade; to rotate, store a pool default or pass a pool selection).',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target',
          description: 'Optional per-target override, e.g. { "agent:codex": "openai-codex:group:<poolId>" }. A per-target entry wins over connectedServices for that target.',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Delegate the task."}' },
    },
	    surfaces: {
	      ui_button: true,
	      ui_slash_command: true,
	      voice_tool: true,
	      voice_action_block: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	    },
	    inputSchema: DelegateStartInputSchema,
	  },
  {
    id: 'voice_agent.start',
    title: 'Start voice agent run',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    slash: { tokens: ['/h.voice'] },
    bindings: { voiceClientToolName: 'startVoiceAgentRun', mcpToolName: 'voice_agent_start' },
    inputHints: {
      title: 'Start a voice agent run',
      description: 'Start a voice agent execution run (typically used by the voice control plane).',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Provider/backend targets',
          description: 'Select the agent provider/backend targets to use for the voice agent run.',
          widget: 'multiselect',
          required: true,
          optionsSourceId: 'execution.backends.enabled',
        },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'Initial instructions for the voice agent run.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'connectedServices',
          title: 'Connected services (account/pool)',
          description: 'Optional. Bind the run to a connected account or pool instead of the runner\'s inherited account. Simple form: "openai-codex:group:<poolId>" (a pool — auto-rotates when autoSwitch is enabled), "openai-codex:<profileId>" (a single account), "openai-codex:native" (opt out), or a full { v:1, bindingsByServiceId } object. Omit to use the account\'s configured default exactly as stored (literal: a profile default binds to that profile, a pool default to that pool — no silent upgrade; to rotate, store a pool default or pass a pool selection).',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
        {
          path: 'connectedServicesByBackendTargetKey',
          title: 'Connected services per target',
          description: 'Optional per-target override, e.g. { "agent:codex": "openai-codex:group:<poolId>" }. A per-target entry wins over connectedServices for that target.',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Start the voice assistant for this workspace."}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'execution.run.start',
    title: 'Start execution run',
    description: 'Start a new execution run within a session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: [],
    bindings: { mcpToolName: 'execution_run_start' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","intent":"voice_agent","backendTarget":{"kind":"builtInAgent","agentId":"codex"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Start a run',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'intent', title: 'Intent', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target (json)', widget: 'textarea', required: true },
        { path: 'instructions', title: 'Instructions', widget: 'textarea' },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
        { path: 'retentionPolicy', title: 'Retention policy', widget: 'text', required: true },
        { path: 'runClass', title: 'Run class', widget: 'text', required: true },
        { path: 'ioMode', title: 'IO mode', widget: 'text', required: true },
        { path: 'initialContextMode', title: 'Initial context mode', widget: 'text' },
        {
          path: 'modelId',
          title: 'Model',
          description: 'Optional. Model id for the run\'s backend, using the SAME shape as session spawn. Omit to use the backend\'s default model. Enumerate valid ids with the agents.models.available options source.',
          widget: 'text',
          optionsSourceId: 'agents.models.available',
        },
        {
          path: 'configOptions',
          title: 'Config options (e.g. reasoning effort)',
          description: 'Optional. Per-run config options using the SAME vocabulary as session spawn, e.g. { "reasoning_effort": "high" }. Reasoning effort is the reasoning_effort option (values are backend-specific, e.g. Codex low|medium|high|xhigh). Merged with sessionConfigOptionOverrides; a conflicting value in both forms is rejected.',
          widget: 'text',
        },
        {
          path: 'sessionConfigOptionOverrides',
          title: 'Config option overrides (canonical json)',
          description: 'Optional. Canonical AcpConfigOptionOverridesV1 object (same shape session spawn uses). Prefer the configOptions shorthand for simple cases like reasoning effort.',
          widget: 'textarea',
        },
        {
          path: 'connectedServices',
          title: 'Connected services (account/pool)',
          description: 'Optional. Bind the run to a connected account or pool instead of the runner\'s inherited account. Simple form: "openai-codex:group:<poolId>" (a pool — auto-rotates when autoSwitch is enabled), "openai-codex:<profileId>" (a single account), "openai-codex:native" (opt out), or a full { v:1, bindingsByServiceId } object. Omit to use the account\'s configured default exactly as stored (literal: a profile default binds to that profile, a pool default to that pool — no silent upgrade; to rotate, store a pool default or pass a pool selection).',
          widget: 'text',
          optionsSourceId: 'execution.runs.connected_services.available',
        },
      ],
    },
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    inputHints: {
      title: 'List execution runs',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'backendTarget', title: 'Backend target', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'running', label: 'Running' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timeout', label: 'Timeout' },
          ],
        },
        { path: 'limit', title: 'Max runs', widget: 'text' },
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","status":"running","limit":10}' },
    },
	    surfaces: {
	      ui_button: true,
	      ui_slash_command: true,
	      voice_tool: true,
	      voice_action_block: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	    },
	    inputSchema: ExecutionRunListRequestSchema.extend({
	      sessionId: z.string().min(1).optional(),
	    }),
	  },
  {
    id: 'execution.run.get',
    title: 'Get execution run',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get a run',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'toggle' },
      ],
    },
    inputSchema: ExecutionRunGetInputSchema,
  },
  {
    id: 'execution.run.send',
    title: 'Send to execution run',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['run_card'],
    bindings: { voiceClientToolName: 'sendExecutionRunMessage', mcpToolName: 'execution_run_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","message":"Continue and summarize what changed.","resume":false}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Send to run',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'toggle' },
      ],
    },
    inputSchema: ExecutionRunSendInputSchema,
  },
  {
    id: 'execution.run.stop',
    title: 'Stop execution run',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['run_card', 'run_list'],
    bindings: { voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui_button: true,
	      ui_slash_command: false,
	      voice_tool: true,
	      voice_action_block: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	    },
	    inputHints: {
	      title: 'Stop a run',
	      fields: [{ path: 'runId', title: 'Run id', widget: 'text', required: true }],
	    },
	    inputSchema: ExecutionRunIdInputSchema,
	  },
  {
    id: 'execution.run.action',
    title: 'Apply execution run action',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['run_card'],
    bindings: { voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Run action',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    inputSchema: ExecutionRunActionInputSchema,
  },
  {
    id: 'execution.run.wait',
    title: 'Wait for execution run',
    description: 'Wait until an execution run reaches a terminal status. Pass timeoutSeconds to bound the wait; omit it for no Happier-side deadline.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'execution_run_wait' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Wait for a run',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
        { path: 'pollIntervalMs', title: 'Poll interval (ms)', widget: 'text' },
      ],
    },
    inputSchema: ExecutionRunWaitInputSchema,
  },
  {
    id: 'session.open',
    title: 'Open session',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputHints: {
      title: 'Open a session',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    inputSchema: SessionOpenInputSchema,
  },
  {
    id: 'session.fork',
    title: 'Fork session',
    description: 'Create a new session from the latest state of the selected session.',
    safety: 'safe',
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate' },
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: { voiceClientToolName: 'forkSession' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputHints: {
      title: 'Fork a session',
      description: 'Forks from the latest message in the session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    inputSchema: SessionForkActionInputSchema,
  },
  {
    id: 'session.rollback',
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['session_action_menu', 'session_info'],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    inputSchema: SessionRollbackInputSchema,
  },
  {
    id: 'session.handoff',
    title: 'Hand off session',
    description: 'Move the current session to another machine while keeping the same session id.',
    safety: 'safe',
    operation: { version: 1, visibility: 'activity', progress: 'reported' },
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['session_action_menu', 'session_info'],
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputHints: {
      title: 'Hand off a session',
      description: 'Moves the current session to another machine.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
      ],
    },
    inputSchema: SessionHandoffInputSchema,
  },
  {
    id: 'session.spawn_new',
    title: 'Create session',
    safety: 'safe',
    operation: { version: 1, visibility: 'activity', progress: 'reported' },
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['command_palette', 'session_info', 'voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'spawnSession', mcpToolName: 'session_spawn_new' },
    examples: {
      voice: { argsExample: '{"tag":"voice-qa","agentId":"claude","modelId":"default","initialMessage":"Help me inspect this workspace."}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Create a new session',
      fields: [
        { path: 'tag', title: 'Tag', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text', optionsSourceId: 'agents.models.available' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text', optionsSourceId: 'agents.backends.enabled' },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text', optionsSourceId: 'sessions.spawn.paths.recent' },
        { path: 'machineId', title: 'Machine id', widget: 'text', optionsSourceId: 'sessions.spawn.machines.available' },
        { path: 'host', title: 'Host', widget: 'text' },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text' },
        { path: 'agentModeId', title: 'Agent mode id', widget: 'text', optionsSourceId: 'agents.session_modes.available' },
        { path: 'sessionConfigOptionOverrides', title: 'Config option overrides', widget: 'text', optionsSourceId: 'agents.config_options.available' },
        { path: 'profileId', title: 'Profile id', widget: 'text', optionsSourceId: 'sessions.spawn.profiles.available' },
        { path: 'connectedServices', title: 'Connected services', widget: 'text', optionsSourceId: 'sessions.spawn.connected_services.available' },
        { path: 'mcpSelection', title: 'MCP selection', widget: 'text', optionsSourceId: 'sessions.spawn.mcp_servers.preview' },
        { path: 'initialMessage', title: 'Initial message', widget: 'textarea' },
      ],
    },
    inputSchema: SessionSpawnNewInputSchema,
  },
  {
    id: 'session.spawn_picker',
    title: 'Create session (picker)',
    description: 'Open the in-app machine + directory picker and create a new session from the user selection.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'spawnSessionPicker' },
    examples: {
      voice: { argsExample: '{"tag":"voice-qa","agentId":"claude","modelId":"default","initialMessage":"Help me inspect this workspace."}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Create a new session (picker)',
      fields: [
        { path: 'tag', title: 'Tag', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'initialMessage', title: 'Initial message', widget: 'textarea' },
      ],
    },
    inputSchema: SessionSpawnPickerInputSchema,
  },
  {
    id: 'paths.list_recent',
    title: 'List recent paths',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    inputSchema: PathsListRecentInputSchema,
  },
  {
    id: 'machines.list',
    title: 'List machines',
    description: 'List machines available on the active server scope.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    inputSchema: MachinesListInputSchema,
  },
  {
    id: 'servers.list',
    title: 'List servers',
    description: 'List servers configured in the client.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    inputSchema: ServersListInputSchema,
  },
  {
    id: 'review.engines.list',
    title: 'List review engines',
    description: 'List review engines currently available for the active session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'toggle' },
      ],
    },
    inputSchema: ReviewEnginesListInputSchema,
  },
  {
    id: 'agents.backends.list',
    title: 'List agent backends',
    description: 'List available agent backends (providers) for spawning sessions.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'toggle' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsBackendsListInputSchema,
  },
  {
    id: 'agents.models.list',
    title: 'List agent models',
    description: 'List available models for an agent backend.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"backendTargetKey":"agent:claude","limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'agents.session_modes.list',
    title: 'List agent session modes',
    description: 'List available session modes for an agent backend.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentSessionModes', mcpToolName: 'agents_session_modes_list' },
    examples: {
      voice: { argsExample: '{"backendTargetKey":"agent:claude","limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List agent session modes',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsSessionModesListInputSchema,
  },
  {
    id: 'agents.config_options.list',
    title: 'List agent config options',
    description: 'List configurable session options for an agent backend without exposing secret values.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentConfigOptions', mcpToolName: 'agents_config_options_list' },
    examples: {
      voice: { argsExample: '{"backendTargetKey":"agent:claude","limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List agent config options',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsConfigOptionsListInputSchema,
  },
  {
    id: 'sessions.spawn.profiles.list',
    title: 'List spawn profiles',
    description: 'List backend profiles available for creating a new session without exposing environment values or secret bindings.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnProfiles', mcpToolName: 'sessions_spawn_profiles_list' },
    examples: {
      voice: { argsExample: '{"backendTargetKey":"agent:claude","limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List spawn profiles',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'includeDisabled', title: 'Include incompatible', widget: 'toggle' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: SessionsSpawnProfilesListInputSchema,
  },
  {
    id: 'sessions.spawn.connected_services.list',
    title: 'List spawn connected services',
    description: 'List non-secret connected-service profile and group choices available for creating a new session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnConnectedServices', mcpToolName: 'sessions_spawn_connected_services_list' },
    examples: {
      voice: { argsExample: '{"backendTargetKey":"agent:claude","includeUnavailable":false}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List spawn connected services',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'includeUnavailable', title: 'Include unavailable', widget: 'toggle' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: SessionsSpawnConnectedServicesListInputSchema,
  },
  {
    id: 'sessions.spawn.mcp_servers.preview',
    title: 'Preview spawn MCP servers',
    description: 'Preview the sanitized MCP server set that would be available to a new session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'previewSpawnMcpServers', mcpToolName: 'sessions_spawn_mcp_servers_preview' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","machineId":"{{machineId}}","path":"{{path}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Preview spawn MCP servers',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'serverId', title: 'Server id', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'mcpSelection', title: 'MCP selection', widget: 'text' },
      ],
    },
    inputSchema: SessionsSpawnMcpServersPreviewInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'permissionModeOverride', title: 'Permission mode override (optional)', widget: 'text' },
        { path: 'modelOverride', title: 'Model override (optional)', widget: 'text' },
        { path: 'wait', title: 'Wait for idle (optional)', widget: 'toggle' },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    inputSchema: SessionSendMessageInputSchema,
  },
  {
    id: 'session.stop',
    title: 'Stop session',
    description: 'Request that the local daemon stops the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_stop' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Stop a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.title.set',
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    inputSchema: SessionTitleSetInputSchema,
  },
  {
    id: 'session.permission_mode.set',
    title: 'Set session permission mode',
    description: 'Update the permission intent (read_only/workspace_write/etc) for the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
      ],
    },
    inputSchema: SessionPermissionModeSetInputSchema,
  },
  {
    id: 'session.model.set',
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
      ],
    },
    inputSchema: SessionModelSetInputSchema,
  },
  {
    id: 'session.archive',
    title: 'Archive session',
    description: 'Archive the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Archive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.unarchive',
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.status.get',
    title: 'Get session status',
    description: 'Get summary status for a session, optionally refreshing live agent state.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'toggle' },
      ],
    },
    inputSchema: SessionStatusGetInputSchema,
  },
  {
    id: 'session.work_state.get',
    title: 'Get session work state',
    description: 'Get the normalized current goal, task, and todo snapshot for a session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_work_state_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session work state',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.get',
    title: 'Get session goal',
    description: 'Get the editable session goal when the provider supports native goals.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_goal_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.goal.set',
    title: 'Set session goal',
    description: 'Set or update the native session goal.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_goal_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","objective":"Ship goal controls"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set session goal',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'objective', title: 'Objective', widget: 'textarea' },
        { path: 'status', title: 'Status', widget: 'text' },
        { path: 'tokenBudget', title: 'Token budget', widget: 'text' },
      ],
    },
    inputSchema: SessionGoalSetInputSchema,
  },
  {
    id: 'session.goal.clear',
    title: 'Clear session goal',
    description: 'Clear the native session goal.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_goal_clear' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Clear session goal',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.terminalComposer.clear',
    title: 'Clear terminal composer',
    description: 'Clear a live terminal composer draft after explicit user authorization.',
    safety: 'danger',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: true,
    },
    inputHints: {
      title: 'Clear terminal composer',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    inputSchema: SessionTerminalComposerClearRequestV1Schema,
  },
  {
    id: 'session.pendingInput.interruptAndRun',
    title: 'Interrupt and run now',
    description: 'Interrupt the live provider turn so its exact native queued prompt can run now.',
    safety: 'danger',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: true,
    },
    inputHints: {
      title: 'Interrupt and run now',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    inputSchema: SessionPendingInputInterruptAndRunRequestV1Schema,
  },
  {
    id: 'session.usageLimit.waitResume.enable',
    title: 'Enable usage-limit wait/resume',
    description: 'Arm a durable intent to continue a session when a provider usage limit is lifted.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_enable' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"usage-limit:s1:123"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Continue after usage limit',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'remember', title: 'Remember preference', widget: 'toggle' },
        { path: 'resumePromptMode', title: 'Resume prompt mode', widget: 'text' },
      ],
    },
    inputSchema: SessionUsageLimitWaitResumeEnableRequestV1Schema,
  },
  {
    id: 'session.usageLimit.waitResume.cancel',
    title: 'Cancel usage-limit wait/resume',
    description: 'Cancel the active usage-limit wait/resume intent for a session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_cancel' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"{{issueFingerprint}}","armedAtMs":1700000000000,"runtimeAuthRecoveryAttemptId":"{{runtimeAuthRecoveryAttemptId}}"}',
      },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Cancel usage-limit recovery',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'armedAtMs', title: 'Recovery armed timestamp', widget: 'text' },
        { path: 'runtimeAuthRecoveryAttemptId', title: 'Runtime recovery attempt id', widget: 'text' },
      ],
    },
    inputSchema: SessionUsageLimitWaitResumeCancelRequestV1Schema,
  },
  {
    id: 'session.usageLimit.checkNow',
    title: 'Check usage-limit recovery now',
    description: 'Ask the session runtime to perform a safe provider-owned usage-limit recovery check.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_check_now' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Check usage limit',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider/backend id used to match the active usage-limit issue.',
          widget: 'text',
        },
        {
          path: 'operation',
          title: 'Operation',
          widget: 'select',
          options: [
            { value: 'check_now', label: 'Check now' },
            { value: 'switch_account_now', label: 'Switch account now' },
          ],
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    inputSchema: SessionUsageLimitCheckNowRequestV1Schema,
  },
  {
    id: 'session.usageLimit.consumeResetCredit',
    title: 'Apply usage-limit reset credit',
    description: 'Ask the session runtime to spend a connected-service reset credit for usage-limit recovery.',
    safety: 'danger',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_consume_reset_credit' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Apply reset credit',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider/backend id used to match the active usage-limit issue.',
          widget: 'text',
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    inputSchema: SessionUsageLimitConsumeResetCreditRequestV1Schema,
  },
  {
    id: 'session.vendor_plugin_catalog.list',
    title: 'List session vendor plugins',
    description: 'List provider-owned vendor plugins available to the session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_vendor_plugin_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List vendor plugins',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.skill_catalog.list',
    title: 'List session skills',
    description: 'List provider-visible skills available to the session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_skill_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List skills',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    inputSchema: SessionCatalogListInputSchema,
  },
  {
    id: 'session.history.get',
    title: 'Get session history',
    description: 'Read visible session history as compact transcript rows or raw persisted rows for compatibility. Use session_transcript_get for semantic transcript pagination and session_events_get for diagnostics.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session history',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          options: [
            { value: 'compact', label: 'Compact' },
            { value: 'raw', label: 'Raw' },
          ],
        },
        { path: 'includeMeta', title: 'Include meta', widget: 'toggle' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'toggle' },
      ],
    },
    inputSchema: SessionHistoryGetInputSchema,
  },
  {
    id: 'session.transcript.get',
    title: 'Get session transcript',
    description: 'Read the semantic transcript for a session as clean user/assistant messages with optional tool/reasoning/event flags.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionTranscript', mcpToolName: 'session_transcript_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"roles":["user","assistant"],"maxCharsPerMessage":null}' },
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"roles":["user","assistant"],"maxCharsPerMessage":null}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before' },
            { value: 'after', label: 'After' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          options: [
            { value: 'main', label: 'Main' },
            { value: 'sidechain', label: 'Sidechain' },
            { value: 'all', label: 'All' },
          ],
        },
        { path: 'sidechainId', title: 'Sidechain id', widget: 'text' },
        {
          path: 'roles',
          title: 'Roles',
          widget: 'multiselect',
          options: [
            { value: 'user', label: 'User' },
            { value: 'assistant', label: 'Assistant' },
          ],
        },
        { path: 'includeTools', title: 'Include tools', widget: 'toggle' },
        { path: 'includeReasoning', title: 'Include reasoning', widget: 'toggle' },
        { path: 'includeEvents', title: 'Include events', widget: 'toggle' },
        { path: 'includeMeta', title: 'Include meta', widget: 'toggle' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'toggle' },
        { path: 'includeRaw', title: 'Include raw', widget: 'toggle' },
        {
          path: 'maxCharsPerMessage',
          title: 'Message truncation chars',
          description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
          widget: 'text',
        },
        { path: 'maxRawPayloadChars', title: 'Max raw payload chars', widget: 'text' },
      ],
    },
    inputSchema: SessionTranscriptGetInputSchema,
  },
  {
    id: 'session.events.get',
    title: 'Get session events',
    description: 'Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_events_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session events',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before' },
            { value: 'after', label: 'After' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          options: [
            { value: 'main', label: 'Main' },
            { value: 'sidechain', label: 'Sidechain' },
            { value: 'all', label: 'All' },
          ],
        },
        { path: 'sidechainId', title: 'Sidechain id', widget: 'text' },
        {
          path: 'roles',
          title: 'Roles',
          widget: 'multiselect',
          options: [
            { value: 'event', label: 'Event' },
            { value: 'agent', label: 'Agent' },
            { value: 'user', label: 'User' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
        { path: 'kinds', title: 'Kinds', widget: 'text_list', listSeparator: 'comma' },
        {
          path: 'format',
          title: 'Format',
          widget: 'select',
          options: [
            { value: 'compact', label: 'Compact' },
            { value: 'raw', label: 'Raw' },
          ],
        },
        { path: 'includeMeta', title: 'Include meta', widget: 'toggle' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'toggle' },
        { path: 'includeRaw', title: 'Include raw', widget: 'toggle' },
        { path: 'maxTextChars', title: 'Max text chars', widget: 'text' },
        { path: 'maxPayloadChars', title: 'Max payload chars', widget: 'text' },
      ],
    },
    inputSchema: SessionEventsGetInputSchema,
  },
  {
    id: 'session.wait.idle',
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: [],
    bindings: { mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    inputSchema: SessionWaitIdleInputSchema,
  },
  {
    id: 'session.permission.respond',
    title: 'Respond to permission request',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'processPermissionRequest', mcpToolName: 'session_permission_respond' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","decision":"allow"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Respond to permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        { path: 'requestId', title: 'Request id', widget: 'text' },
      ],
    },
    inputSchema: SessionPermissionRespondInputSchema,
  },
  {
    id: 'session.user_action.answer',
    title: 'Respond to user-action request',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","values":["Yes"]}]}',
      },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Respond to user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          description: 'Use approve or reject for general user actions, or request_changes when you need the coding assistant to revise something first.',
          widget: 'select',
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'request_changes', label: 'Request changes' },
          ],
        },
        {
          path: 'reason',
          title: 'Reason',
          description: 'Required when requesting changes. Optional extra context for a rejection.',
          widget: 'textarea',
        },
        {
          path: 'answers',
          title: 'Answers',
          description: 'Structured answers for question-style user-action requests such as AskUserQuestion.',
          widget: 'textarea',
        },
        {
          path: 'answers.[]',
          title: 'Answer entry',
          description: 'One question/answer pair for the pending request.',
          widget: 'textarea',
        },
        {
          path: 'answers.[].question',
          title: 'Question',
          description: 'The exact question text to answer.',
          widget: 'text',
          required: true,
        },
        {
          path: 'answers.[].values',
          title: 'Answer values',
          description: 'The exact ordered answer values to send back for that question.',
          widget: 'text',
          required: true,
        },
      ],
    },
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.mode.set',
    title: 'Set session mode',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set session mode',
      fields: [
        { path: 'sessionId', title: 'Session id', description: 'Optional when the active target session is already correct.', widget: 'text' },
        {
          path: 'modeId',
          title: 'Mode id',
          description: 'Use default to clear the override and return to the provider default mode.',
          widget: 'select',
          required: true,
          optionsSourceId: 'session.modes.available',
        },
      ],
    },
    inputSchema: SessionModeSetInputSchema,
  },
  {
    id: 'session.target.primary.set',
    title: 'Set primary action session',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set primary action session',
      fields: [
        { path: 'sessionId', title: 'Session id (or null)', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    inputSchema: SessionPrimaryTargetInputSchema,
  },
  {
    id: 'session.target.tracked.set',
    title: 'Set tracked sessions',
    description: 'Set which sessions should be treated as tracked for updates/snippets.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions', mcpToolName: 'session_target_tracked_set' },
    examples: {
      voice: { argsExample: '{"sessionIds":["{{sessionId}}"]}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Set tracked sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', listSeparator: 'comma', required: true }],
    },
    inputSchema: SessionTrackedTargetsInputSchema,
  },
  {
    id: 'session.list',
    title: 'List sessions',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'List sessions',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'toggle' },
        { path: 'includeRows', title: 'Include rows', widget: 'toggle' },
      ],
    },
    inputSchema: SessionListInputSchema,
  },
  {
    id: 'session.activity.get',
    title: 'Get session activity',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity', mcpToolName: 'session_activity_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    inputSchema: SessionActivityInputSchema,
  },
  {
    id: 'session.messages.recent.get',
    title: 'Get recent messages',
    description: 'DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputHints: {
      title: 'Get recent messages',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeUser', title: 'Include user', widget: 'toggle' },
        { path: 'includeAssistant', title: 'Include assistant', widget: 'toggle' },
      ],
    },
    inputSchema: SessionRecentMessagesInputSchema,
  },
  {
    id: 'ui.voice_global.reset',
    title: 'Reset voice agent',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent' },
    inputHints: {
      title: 'Reset voice agent',
      description: 'Reset the global voice agent state (clears the current voice conversation).',
      fields: [],
    },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.pet.choose',
    title: 'Choose pet',
    description: 'Open pet settings so the user can choose or manage their companion.',
    safety: 'safe',
    approval: APPROVAL_RESULT_NONE,
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Open pet settings.',
      fields: [],
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: true,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.voice_agent.teleport',
    title: 'Teleport voice agent to session root',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
    approval: APPROVAL_RESULT_OPTIONAL_DEFERRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'teleportVoiceAgentToSessionRoot' },
    inputHints: {
      title: 'Teleport voice agent',
      description: 'Teleport the active voice agent into a session root. Defaults to the current action session when omitted.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: OptionalSessionIdInputSchema,
  },
  {
    id: 'memory.search',
    title: 'Search memory',
    description: 'Search the local daemon memory index (opt-in).',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'memorySearch', mcpToolName: 'memory_search' },
    inputHints: {
      title: 'Search memory',
      description: 'Search across sessions using the daemon-local memory index.',
      fields: [
        {
          path: 'machineId',
          title: 'Machine id',
          description: 'Machine running the daemon memory index.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.query',
          title: 'Query',
          description: 'What to search for.',
          widget: 'text',
          required: true,
        },
        {
          path: 'query.mode',
          title: 'Mode',
          description: 'Which index to search.',
          widget: 'select',
          required: true,
          options: [
            { value: 'hints', label: 'Hints' },
            { value: 'deep', label: 'Deep' },
            { value: 'auto', label: 'Auto' },
          ],
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","query":{"v":1,"query":"openclaw","scope":{"type":"global"},"mode":"hints"}}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: false,
      cli: true,
    },
    inputSchema: MemorySearchInputSchema,
  },
  {
    id: 'memory.get_window',
    title: 'Get memory window',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryGetWindow', mcpToolName: 'memory_get_window' },
    inputHints: {
      title: 'Get memory window',
      description: 'Fetch and decrypt a message range from a specific session.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'seqFrom', title: 'Seq from', widget: 'text', required: true },
        { path: 'seqTo', title: 'Seq to', widget: 'text', required: true },
      ],
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: false,
      cli: true,
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    inputSchema: MemoryGetWindowInputSchema,
  },
  {
    id: 'memory.ensure_up_to_date',
    title: 'Ensure memory up to date',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
    approval: APPROVAL_RESULT_REQUIRED,
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryEnsureUpToDate', mcpToolName: 'memory_ensure_up_to_date' },
    inputHints: {
      title: 'Ensure memory up to date',
      description: 'Forces the daemon memory worker to process new transcript content.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id (optional)', widget: 'text' },
      ],
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      session_agent: true,
      mcp: false,
      cli: false,
    },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    inputSchema: MemoryEnsureUpToDateInputSchema,
  },
  {
    id: 'prompt_doc.update',
    title: 'Update prompt document',
    description: 'Update a prompt document stored in the Happier prompt library.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputSchema: PromptDocUpdateInputSchema,
    inputHints: {
      title: 'Update prompt document',
      fields: [
        { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_bundle.update',
    title: 'Update prompt bundle',
    description: 'Update a skill bundle stored in the Happier prompt library.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: PromptBundleUpdateInputSchema,
    inputHints: {
      title: 'Update prompt bundle',
      fields: [
        { path: 'artifactId', title: 'Bundle artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'skillMarkdown', title: 'SKILL.md markdown', widget: 'textarea', required: true },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  },
  {
    id: 'prompt_asset.export',
    title: 'Export prompt asset',
    description: 'Export a prompt doc or skill bundle from the Happier library to a provider-native asset.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: PromptAssetExportInputSchema,
    inputHints: {
      title: 'Export prompt asset',
      fields: [
        { path: 'artifactId', title: 'Artifact id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'assetTypeId', title: 'Asset type id', widget: 'text', required: true },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'directory', title: 'Project directory', widget: 'text' },
        { path: 'targetPath', title: 'Document path', widget: 'text' },
        { path: 'targetName', title: 'Skill name', widget: 'text' },
        {
          path: 'installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'prompt_registry.install',
    title: 'Install prompt registry skill',
    description: 'Import a skill bundle from a registry and optionally export it to an external skills location.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: false,
      cli: false,
    },
    inputSchema: PromptRegistryInstallInputSchema,
    inputHints: {
      title: 'Install prompt registry skill',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'configuredSources', title: 'Configured sources (json)', widget: 'textarea' },
        { path: 'installTarget.assetTypeId', title: 'Target asset type', widget: 'text' },
        {
          path: 'installTarget.scope',
          title: 'Target scope',
          widget: 'select',
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
          ],
        },
        { path: 'installTarget.directory', title: 'Project directory', widget: 'text' },
        { path: 'installTarget.targetName', title: 'Target skill name', widget: 'text' },
        {
          path: 'installTarget.installMode',
          title: 'Install mode',
          widget: 'select',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'symlink', label: 'Symlink' },
          ],
        },
      ],
    },
  },
  {
    id: 'approval.request.create',
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: true,
      mcp: true,
      cli: true,
    },
    inputSchema: ApprovalRequestCreateInputSchema,
    inputHints: {
      title: 'Request approval',
      description: 'Create an approval request in the global inbox.',
      fields: [
        { path: 'summary', title: 'Summary', widget: 'textarea', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'actionArgs', title: 'Action args (json)', widget: 'textarea', required: true },
      ],
    },
  },
  {
    id: 'approval.request.decide',
    title: 'Decide approval request',
    description: 'Approve or reject an approval request.',
    safety: 'danger',
    approval: APPROVAL_RESULT_NONE,
    placements: [],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      session_agent: false,
      mcp: true,
      cli: true,
    },
    inputSchema: ApprovalRequestDecideInputSchema,
    inputHints: {
      title: 'Approve or reject',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
          ],
        },
      ],
    },
  },
]);

export function listActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS;
}

export function getActionSpec(id: ActionId): ActionSpec {
  const spec = ACTION_SPECS.find((s) => s.id === id);
  if (!spec) {
    // This is a programmer error: all call sites should be type-safe and list-backed.
    throw new Error(`Unknown action spec: ${id}`);
  }
  return spec;
}

export function isActionSpecSurfacedOn(spec: ActionSpec, surface: keyof ActionSurfaces | null | undefined): boolean {
  if (!surface) return true;
  return spec.surfaces[surface] === true;
}

export function listActionSpecsForSurface(surface: keyof ActionSurfaces): readonly ActionSpec[] {
  return ACTION_SPECS.filter((spec) => isActionSpecSurfacedOn(spec, surface));
}

export function listVoiceToolActionSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice_tool').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function isVoicePromptHotPathSpec(spec: ActionSpec): boolean {
  return spec.prompting?.voiceHotPath === true;
}

export function listVoicePromptHotPathSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoicePromptHotPathSpec);
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice_action_block').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function listVoiceClientToolNames(): readonly string[] {
  const names = listVoiceToolActionSpecs()
    .map((spec) => String(spec.bindings?.voiceClientToolName ?? '').trim())
    .filter((name) => name.length > 0);
  names.sort();
  return names;
}

export function resolveVoiceClientToolNameAlias(value: string): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  for (const spec of listVoiceToolActionSpecs()) {
    const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
    if (!toolName) continue;
    if (toolName === normalized || spec.id === normalized) return toolName;
  }

  return null;
}
