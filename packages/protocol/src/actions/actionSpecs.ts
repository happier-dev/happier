import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ActionInputPredicateSchema, type ActionInputPredicate } from './actionInputPredicates.js';
import { MemorySearchQueryV1Schema } from '../memory/memorySearch.js';
import { ApprovalRequestCreatedBySchema, ApprovalRequestStatusSchema } from '../approvals/approvalRequestV1.js';
import {
  PromptRegistryConfiguredSourceV1Schema,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryScanSourceRequestV1Schema,
} from '../promptLibrary/promptRegistriesV1.js';
import {
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetInstallModeV1Schema,
  PromptAssetScopeV1Schema,
} from '../promptLibrary/promptAssetsV1.js';
import {
  DaemonFilesystemListDirectoryRequestSchema,
} from '../machineFileBrowser.js';
import { BackendTargetKeySchema } from '../backendTargets/backendTargetRef.js';
import { BackendTargetKeyV2Schema } from '../backendTargets/backendTargetRefV2.js';
import { ExecutionRunListRequestSchema } from '../executionRunListRequest.js';
import { ExecutionRunStartRequestSchema } from '../executionRunStartRequest.js';
import {
  DirectSessionAttachRequestSchema,
  DirectSessionAttachResponseSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionDetachResponseSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionFollowPolicySetResponseSchema,
  DirectSessionLinkEnsureRequestSchema,
  DirectSessionLinkEnsureResponseSchema,
  DirectSessionsCandidatesListRequestSchema,
  DirectSessionsCandidatesListResponseSchema,
  DirectSessionStatusGetRequestSchema,
  DirectSessionStatusGetResponseSchema,
  DirectTranscriptPageRequestSchema,
  DirectTranscriptPageResponseSchema,
  DirectTranscriptReadAfterRequestSchema,
  DirectTranscriptReadAfterResponseSchema,
} from '../sessions/external/daemonRpcV1.js';
import {
  ScmPullRequestCheckoutRequestSchema,
  ScmPullRequestCheckoutResponseSchema,
  ScmPullRequestGetRequestSchema,
  ScmPullRequestGetResponseSchema,
  ScmPullRequestListRequestSchema,
  ScmPullRequestListResponseSchema,
  ScmPullRequestOpenComposeRequestSchema,
  ScmPullRequestOpenComposeResponseSchema,
  ScmPullRequestOpenOrReuseRequestSchema,
  ScmPullRequestOpenOrReuseResponseSchema,
  ScmPullRequestPrepareWorktreeRequestSchema,
  ScmPullRequestPrepareWorktreeResponseSchema,
  ScmPullRequestRunStackedRequestSchema,
  ScmPullRequestRunStackedResponseSchema,
} from '../scmPullRequests.js';
import {
  ScmHostingRepositoryDescribePublishTargetsRequestSchema,
  ScmHostingRepositoryDescribePublishTargetsResponseSchema,
  ScmHostingRepositoryPublishRequestSchema,
  ScmHostingRepositoryPublishResponseSchema,
  ScmRepositoryInitRequestSchema,
  ScmRepositoryInitResponseSchema,
  ScmRepositoryRemoveIndexLockRequestSchema,
  ScmRepositoryRemoveIndexLockResponseSchema,
} from '../scmRepositoryProvisioning.js';
import {
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
} from '../scmDiffSummary.js';
import {
  ExternalSessionTakeoverInputV1Schema,
  ExternalSessionTakeoverResultV1Schema,
} from '../sessions/external/takeoverV1.js';
import {
  SubagentLifecycleDetailV1Schema,
  SubagentRefInputV1Schema,
  SubagentRefV1Schema,
  SubagentStatusV1Schema,
} from '../sessions/subagents/subagentRefV1.js';
import { SessionRollbackTargetSchema } from '../sessionRollback.js';
import {
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetResultGetRequestSchema,
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffStatusGetRequestSchema,
  SessionHandoffWorkspaceTransferSchema,
} from '../sessionControl/handoff/handoffSchemas.js';
import { SessionContinueWithReplayRpcParamsSchema } from '../sessionContinueWithReplay.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';

const ZodSchemaLike = z.custom<z.ZodTypeAny>((value) => {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return typeof v.safeParse === 'function' && typeof v.parse === 'function';
}, { message: 'Expected a Zod schema' });

export const ActionSurfaceSchema = z.object({
  ui: z.boolean(),
  voice: z.boolean(),
  session_agent: z.boolean(),
  mcp: z.boolean(),
  cli: z.boolean(),
  rpc: z.boolean(),
  sdk: z.boolean(),
}).passthrough();
export type ActionSurfaces = z.infer<typeof ActionSurfaceSchema>;

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
  .passthrough();
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
  .passthrough()
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
  .passthrough();
export type ActionInputHints = z.infer<typeof ActionInputHintsSchema>;

export const ActionPromptingSchema = z
  .object({
    voiceHotPath: z.boolean().optional(),
  })
  .passthrough();
export type ActionPrompting = z.infer<typeof ActionPromptingSchema>;

export const ActionSpecSchema = z.object({
  id: ActionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  safety: ActionSafetySchema,
  // UI placements where the action can appear when the relevant surface is enabled.
  placements: z.array(ActionUiPlacementSchema).default([]),
  // Optional stable slash command token for UI slash-command placement.
  slash: z.object({
    tokens: z.array(z.string().min(1)),
  }).passthrough().optional(),
  bindings: z.object({
    // Tool name the voice client is allowed to expose (surface.voice).
    voiceClientToolName: z.string().min(1).optional(),
    // Tool name for MCP surface (surface.mcp).
    mcpToolName: z.string().min(1).optional(),
    // SDK method exposed when surface.sdk is true.
    sdkMethod: z.string().min(1).optional(),
    // RPC method exposed when surface.rpc is true.
    rpcMethod: z.string().min(1).optional(),
    // Legacy wire aliases still accepted until their owning retirement packet removes them.
    rpcMethodAliases: z.array(z.string().min(1)).optional(),
  }).passthrough().optional(),
  outputSchema: ZodSchemaLike.optional(),
  execution: z
    .object({
      handler: z.string().min(1).optional(),
      transport: z.enum(['host', 'plugin', 'rpc', 'sdk']).optional(),
    })
    .passthrough()
    .optional(),
  sideEffectClass: z.enum(['none', 'read', 'write', 'external', 'danger']).optional(),
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
      sdk: z
        .object({
          codeExample: z.string().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  prompting: ActionPromptingSchema.optional(),
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.placements?.length ?? 0) > 0 && !value.surfaces.ui) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'placements require surface.ui',
      path: ['surfaces', 'ui'],
    });
  }
  if (value.surfaces.sdk && !value.bindings?.sdkMethod) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.sdk requires bindings.sdkMethod',
      path: ['bindings', 'sdkMethod'],
    });
  }
  if (value.surfaces.sdk && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.sdk requires outputSchema',
      path: ['outputSchema'],
    });
  }
  if (value.surfaces.rpc && !value.bindings?.rpcMethod) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.rpc requires bindings.rpcMethod',
      path: ['bindings', 'rpcMethod'],
    });
  }
  if (value.surfaces.mcp && !value.bindings?.mcpToolName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.mcp requires bindings.mcpToolName',
      path: ['bindings', 'mcpToolName'],
    });
  }
  if (value.surfaces.mcp && !value.outputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'surface.mcp requires outputSchema',
      path: ['outputSchema'],
    });
  }
});

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
}>;

const DAEMON_ADMIN_RPC_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  session_agent: false,
  mcp: false,
  cli: false,
  rpc: true,
  sdk: false,
} satisfies ActionSurfaces);

const DAEMON_ADMIN_INPUT_HINTS = Object.freeze({
  fields: [],
} satisfies ActionInputHints);

const EmptyObjectSchema = z.object({}).strict();
const PassthroughEmptyObjectSchema = z.object({}).passthrough();
const DaemonFilesystemReadFileInputSchema = z.object({
  path: z.string().min(1),
}).passthrough();
const DaemonFilesystemWriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().nullable().optional(),
}).passthrough();
const DaemonFilesystemListDirectoryInputSchema = z.object({
  path: z.string().min(1),
}).passthrough();
const DaemonFilesystemGetDirectoryTreeInputSchema = z.object({
  path: z.string().min(1),
  maxDepth: z.number().int().min(0),
}).passthrough();
const BugReportGetLogTailInputSchema = z.object({
  path: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1024).max(1_000_000).optional(),
}).passthrough();
const BugReportUploadArtifactInputSchema = z.object({
  uploadUrl: z.string().optional(),
}).passthrough();
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
  modelId: z.string().trim().min(1),
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

const SessionWaitIdleInputSchema = z.object({
  sessionId: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough();

const IntentStartCommonSchema = z.object({
  sessionId: z.string().min(1).optional(),
  backendTargetKeys: z.array(BackendTargetKeySchema).min(1),
  instructions: z.string().trim().min(1),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough();

const PlanStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: z.string().min(1).default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const DelegateStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: z.string().min(1).default('workspace_write'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('bounded'),
  ioMode: z.enum(['request_response', 'streaming']).default('request_response'),
}).passthrough();

const VoiceAgentStartInputSchema = IntentStartCommonSchema.extend({
  permissionMode: z.string().min(1).default('read_only'),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).default('ephemeral'),
  runClass: z.enum(['bounded', 'long_lived']).default('long_lived'),
  ioMode: z.enum(['request_response', 'streaming']).default('streaming'),
}).passthrough();

const ExecutionRunIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1),
}).passthrough();

const ExecutionRunStartInputSchema = ExecutionRunStartRequestSchema.extend({
  sessionId: z.string().min(1).optional(),
}).passthrough();

const ExecutionRunGetInputSchema = ExecutionRunIdInputSchema.extend({
  includeStructured: z.boolean().optional(),
}).passthrough();

const ExecutionRunSendInputSchema = ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunEnsureInputSchema = ExecutionRunIdInputSchema.extend({
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunEnsureOrStartInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).nullable().optional(),
  start: ExecutionRunStartRequestSchema.optional(),
  resume: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId && !value.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start is required when runId is missing' });
  }
});

const ExecutionRunStreamStartInputSchema = ExecutionRunIdInputSchema.extend({
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  resume: z.boolean().optional(),
}).passthrough();

const ExecutionRunStreamReadInputSchema = ExecutionRunIdInputSchema.extend({
  streamId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(256).optional(),
}).passthrough();

const ExecutionRunStreamCancelInputSchema = ExecutionRunIdInputSchema.extend({
  streamId: z.string().min(1),
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

const SessionForkInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
}).passthrough();

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

const SessionSpawnNewInputSchema = z.object({
  tag: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  title: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

const SessionSpawnPickerInputSchema = z.object({
  tag: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
  initialMessage: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
});

function validateAgentIdAndBackendTargetKeySelection(
  value: Readonly<{ agentId?: string; backendTargetKey?: string }>,
  ctx: z.RefinementCtx,
): void {
  const resolved = resolveActionBackendTargetSelection(value);
  if (!resolved.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: resolved.message,
      path: [resolved.path],
    });
  }
}

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
  backendTargetKey: z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema]).optional(),
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
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
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
  permissionModeOverride: z.string().trim().min(1).optional(),
  modelOverride: z.union([z.string().trim().min(1), z.null()]).optional(),
  wait: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
}).passthrough();

const SessionPermissionRespondInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']),
  requestId: z.string().min(1).optional(),
}).passthrough();

const SessionUserActionAnswerItemSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
}).strict();

const SessionUserActionAnswerInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
  reason: z.string().trim().min(1).optional(),
  answers: z.array(SessionUserActionAnswerItemSchema).min(1).optional(),
  updatedPermissions: z.unknown().optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const decision = typeof value.decision === 'string' ? value.decision : null;
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

const SessionLogTailInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  offset: z.number().int().min(0).optional(),
}).passthrough();

const TranscriptPageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1).nullable().optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptReadAfterInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  cursor: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptFollowInputSchema = TranscriptReadAfterInputSchema.extend({
  leaseId: z.string().min(1).optional(),
  idleTtlMs: z.number().int().min(1).max(3_600_000).optional(),
}).passthrough();

const TranscriptImportInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  items: z.array(z.unknown()).min(1).max(500),
  maxItems: z.number().int().min(1).max(500).optional(),
}).passthrough();

const TranscriptSearchInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  query: z.string().trim().min(1),
  cursor: z.string().min(1).optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  maxReads: z.number().int().min(1).max(50).optional(),
}).passthrough();

const TranscriptPageOutputSchema = z.object({
  ok: z.boolean().optional(),
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean().optional(),
  tailCursor: z.string().nullable().optional(),
  truncated: z.boolean(),
}).passthrough();

const TranscriptReadAfterOutputSchema = z.object({
  ok: z.boolean().optional(),
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
}).passthrough();

const TranscriptFollowOutputSchema = TranscriptReadAfterOutputSchema.extend({
  leaseId: z.string().min(1).optional(),
}).passthrough();

const TranscriptImportOutputSchema = z.object({
  ok: z.boolean(),
  imported: z.number().int().min(0).optional(),
  cursor: z.string().nullable().optional(),
}).passthrough();

const SessionLogTailOutputSchema = z.object({
  success: z.boolean().optional(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  tail: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

const SubagentListInputSchema = z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const SubagentGetInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1).optional(),
}).passthrough();

const SubagentWatchInputSchema = z.object({
  parentSessionId: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
}).passthrough();

const SubagentStatusUpdateInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: SubagentStatusV1Schema,
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough();

const SubagentCompleteInputSchema = z.object({
  id: z.string().trim().min(1),
  parentSessionId: z.string().trim().min(1),
  status: z.enum(['completed', 'failed', 'aborted']).optional(),
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  completedAt: z.number().int().nonnegative().optional(),
}).passthrough();

const SubagentWatchSnapshotOutputSchema = z.object({
  kind: z.literal('snapshot'),
  subagents: z.array(SubagentRefV1Schema),
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
  preview: z.unknown().optional(),
}).passthrough();

const ApprovalRequestListInputSchema = z.object({
  status: ApprovalRequestStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).passthrough();

const ApprovalRequestGetInputSchema = z.object({
  artifactId: z.string().min(1),
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

const ExternalSessionTakeoverActionInputSchema = ExternalSessionTakeoverInputV1Schema.extend({
  // Current direct-session wire callers still provide machineId; keep it as adapter context
  // until A.15.4 retires the direct-session aliases.
  machineId: z.string().min(1).optional(),
}).passthrough();

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze([
  {
    id: 'action.spec.search',
    title: 'Search action specs',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ActionSpecSearchInputSchema,
  },
  {
    id: 'action.spec.get',
    title: 'Get action spec',
    description: 'Get one Happier action spec with input hints and examples.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ActionSpecGetInputSchema,
  },
  {
    id: 'action.options.resolve',
    title: 'Resolve action options',
    description: 'Resolve valid options for an action field, including dynamic options sources.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: ActionOptionsResolveInputSchema,
  },
  {
    id: 'review.start',
    title: 'Start review',
    safety: 'safe',
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
          required: true,
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
          description: 'How to define the review base for engines that need it.',
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
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
    inputSchema: ReviewStartInputSchema,
  },
  {
    id: 'subagents.plan.start',
    title: 'Start plan run',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'subagents_plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start one or more parallel planning runs using selected backends.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Backends',
          description: 'Select one or more backends. Each backend runs as its own execution run.',
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
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Plan the changes."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      sdk: false,
	      },
	    outputSchema: z.unknown(),
	    inputSchema: PlanStartInputSchema,
	  },
  {
    id: 'subagents.delegate.start',
    title: 'Start delegate run',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'subagents_delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start one or more parallel delegation runs using selected backends.',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Backends',
          description: 'Select one or more backends. Each backend runs as its own execution run.',
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
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Delegate the task."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	      rpc: false,
	      sdk: false,
	      },
	    outputSchema: z.unknown(),
	    inputSchema: DelegateStartInputSchema,
	  },
  {
    id: 'voice_agent.start',
    title: 'Start voice agent run',
    safety: 'safe',
    placements: ['voice_panel'],
    slash: { tokens: ['/h.voice'] },
    bindings: { voiceClientToolName: 'startVoiceAgentRun', mcpToolName: 'voice_agent_start' },
    inputHints: {
      title: 'Start a voice agent run',
      description: 'Start a voice agent execution run (typically used by the voice control plane).',
      fields: [
        {
          path: 'backendTargetKeys',
          title: 'Backends',
          description: 'Select one or more backends.',
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
      ],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendTargetKeys":["agent:codex"],"instructions":"Start the voice assistant for this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'sessions.subagents.list',
    title: 'List session subagents',
    description: 'Return bounded provider-neutral subagent projections for a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_LIST },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: z.array(SubagentRefV1Schema),
    inputSchema: SubagentListInputSchema,
    inputHints: {
      title: 'List session subagents',
      description: 'Reads a bounded provider-neutral subagent projection snapshot.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'groupId', title: 'Group id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.get',
    title: 'Get session subagent',
    description: 'Return one provider-neutral subagent projection by id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_GET },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: SubagentRefV1Schema.nullable(),
    inputSchema: SubagentGetInputSchema,
    inputHints: {
      title: 'Get session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.watch',
    title: 'Watch session subagents',
    description: 'Register the bounded host subagent watcher path and return its initial typed projection snapshot.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_WATCH },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: SubagentWatchSnapshotOutputSchema,
    inputSchema: SubagentWatchInputSchema,
    inputHints: {
      title: 'Watch session subagents',
      description: 'Uses the bounded host subagent watcher path and returns the initial snapshot for the RPC caller.',
      fields: [
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text' },
        { path: 'id', title: 'Subagent id', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.upsert',
    title: 'Upsert session subagent',
    description: 'Create or replace a provider-neutral subagent projection with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentRefInputV1Schema,
    inputHints: {
      title: 'Upsert session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'origin', title: 'Origin', widget: 'text', required: true },
        { path: 'kind', title: 'Kind', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.updateStatus',
    title: 'Update session subagent status',
    description: 'Update subagent lifecycle status with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentStatusUpdateInputSchema,
    inputHints: {
      title: 'Update session subagent status',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Status', widget: 'text', required: true },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.subagents.complete',
    title: 'Complete session subagent',
    description: 'Mark a subagent terminal with owner-authority enforcement.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    outputSchema: SubagentRefV1Schema,
    inputSchema: SubagentCompleteInputSchema,
    inputHints: {
      title: 'Complete session subagent',
      fields: [
        { path: 'id', title: 'Subagent id', widget: 'text', required: true },
        { path: 'parentSessionId', title: 'Parent session id', widget: 'text', required: true },
        { path: 'status', title: 'Terminal status', widget: 'text' },
        { path: 'completedAt', title: 'Completed at', widget: 'text' },
      ],
    },
  },
  {
    id: 'execution.run.start',
    title: 'Start execution run',
    description: 'Start a new execution run within a session.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_START, mcpToolName: 'execution_run_start' },
    sideEffectClass: 'write',
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","intent":"voice_agent","backendTarget":{"kind":"backend","backendId":"codex","sourceKind":"built_in"},"instructions":"Summarize recent changes.","permissionMode":"read_only","retentionPolicy":"ephemeral","runClass":"bounded","ioMode":"request_response"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
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
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    sideEffectClass: 'read',
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
	      ui: true,
	      voice: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      sdk: false,
	      },
	    outputSchema: z.unknown(),
	    inputSchema: ExecutionRunListRequestSchema.extend({
	      sessionId: z.string().min(1).optional(),
	    }),
	  },
  {
    id: 'execution.run.get',
    title: 'Get execution run',
    safety: 'safe',
    placements: ['run_list', 'run_card', 'command_palette'],
    prompting: { voiceHotPath: true },
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_GET, voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    sideEffectClass: 'read',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","includeStructured":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Get a run',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'includeStructured', title: 'Include structured output', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunGetInputSchema,
  },
  {
    id: 'execution.run.send',
    title: 'Send to execution run',
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_SEND, voiceClientToolName: 'sendExecutionRunMessage', mcpToolName: 'execution_run_send' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","message":"Continue and summarize what changed.","resume":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Send to run',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunSendInputSchema,
  },
  {
    id: 'execution.run.ensure',
    title: 'Ensure execution run',
    description: 'Ensure an existing execution run is active or resumable.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    inputHints: {
      title: 'Ensure a run',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'resume', title: 'Resume if needed', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunEnsureInputSchema,
  },
  {
    id: 'execution.run.ensure_or_start',
    title: 'Ensure or start execution run',
    description: 'Ensure an existing execution run, or start a new one when no run id is supplied.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    inputHints: {
      title: 'Ensure or start a run',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text' },
        { path: 'start', title: 'Start request (json)', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunEnsureOrStartInputSchema,
  },
  {
    id: 'execution.run.stream.start',
    title: 'Start execution run stream',
    description: 'Start a bounded streaming turn for an execution run.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    inputHints: {
      title: 'Start a run stream',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'displayMessage', title: 'Display message', widget: 'textarea' },
        { path: 'resume', title: 'Resume if needed', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunStreamStartInputSchema,
  },
  {
    id: 'execution.run.stream.read',
    title: 'Read execution run stream',
    description: 'Read bounded deltas from an execution-run stream cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ },
    sideEffectClass: 'read',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    inputHints: {
      title: 'Read a run stream',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxEvents', title: 'Max events', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunStreamReadInputSchema,
  },
  {
    id: 'execution.run.stream.cancel',
    title: 'Cancel execution run stream',
    description: 'Cancel a bounded streaming turn for an execution run.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL },
    sideEffectClass: 'write',
    surfaces: {
      ui: false,
      voice: false,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    inputHints: {
      title: 'Cancel a run stream',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'streamId', title: 'Stream id', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunStreamCancelInputSchema,
  },
  {
    id: 'execution.run.stop',
    title: 'Stop execution run',
    safety: 'safe',
    placements: ['run_card', 'run_list'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, voiceClientToolName: 'stopExecutionRun', mcpToolName: 'execution_run_stop' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      session_agent: true,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      sdk: false,
	      },
	    inputHints: {
	      title: 'Stop a run',
	      fields: [{ path: 'runId', title: 'Run id', widget: 'text', required: true }],
	    },
	    outputSchema: z.unknown(),
	    inputSchema: ExecutionRunIdInputSchema,
	  },
  {
    id: 'execution.run.action',
    title: 'Apply execution run action',
    safety: 'safe',
    placements: ['run_card'],
    bindings: { rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, voiceClientToolName: 'actionExecutionRun', mcpToolName: 'execution_run_action' },
    sideEffectClass: 'write',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123","actionId":"voice_agent.commit","input":{"maxChars":1200}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Run action',
      fields: [
        { path: 'runId', title: 'Run id', widget: 'text', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Input (JSON)', widget: 'textarea' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunActionInputSchema,
  },
  {
    id: 'execution.run.wait',
    title: 'Wait for execution run',
    description: 'Wait until an execution run reaches a terminal status. Pass timeoutSeconds to bound the wait; omit it for no Happier-side deadline.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'execution_run_wait' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","runId":"run_123"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: ExecutionRunWaitInputSchema,
  },
  {
    id: 'session.open',
    title: 'Open session',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'openSession' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Open a session',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionOpenInputSchema,
  },
  {
    id: 'session.fork',
    title: 'Fork session',
    description: 'Create a new session from the latest state of the selected session.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info', 'command_palette', 'slash_command', 'voice_panel', 'agent_input_chips'],
    slash: { tokens: ['fork'] },
    bindings: { voiceClientToolName: 'forkSession', rpcMethod: 'session.fork' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Fork a session',
      description: 'Forks from the latest message in the session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionForkInputSchema,
  },
  {
    id: 'session.continue_with_replay',
    title: 'Continue session with replay',
    description: 'Create a continuation session from a replay seed while preserving the existing RPC wire contract.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.continueWithReplay' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Continue with replay',
      fields: [
        { path: 'directory', title: 'Directory', widget: 'text', required: true },
        { path: 'backendTarget', title: 'Backend target', widget: 'text', required: true },
        { path: 'replay', title: 'Replay seed', widget: 'textarea', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionContinueWithReplayRpcParamsSchema,
  },
  {
    id: 'session.rollback',
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: ['session_action_menu', 'session_info'],
    bindings: { rpcMethod: 'session.rollback' },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Rollback a session conversation',
      description: 'Rewinds conversation state for the selected session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionRollbackInputSchema,
  },
  {
    id: 'session.handoff',
    title: 'Hand off session',
    description: 'Move the current session to another machine while keeping the same session id.',
    safety: 'safe',
    placements: ['session_action_menu', 'session_info'],
    bindings: { rpcMethod: 'daemon.sessionHandoff.start' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Hand off a session',
      description: 'Moves the current session to another machine.',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'targetMachineId', title: 'Target machine id', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffInputSchema,
  },
  {
    id: 'session.handoff.prepare_target',
    title: 'Prepare session handoff target',
    description: 'Prepare a target machine to receive an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.prepareTarget' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Prepare handoff target',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'sourceMachineId', title: 'Source machine id', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffPrepareTargetRequestSchema,
  },
  {
    id: 'session.handoff.prepare_target_result.get',
    title: 'Get session handoff target preparation result',
    description: 'Read the prepared-target result for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.prepareTargetResult.get' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Get handoff prepare-target result',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffPrepareTargetResultGetRequestSchema,
  },
  {
    id: 'session.handoff.commit',
    title: 'Commit session handoff',
    description: 'Finalize a prepared session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.commit' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Commit handoff',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffCommitRequestSchema,
  },
  {
    id: 'session.handoff.abort',
    title: 'Abort session handoff',
    description: 'Cancel an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.abort' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Abort handoff',
      fields: [
        { path: 'handoffId', title: 'Handoff id', widget: 'text', required: true },
        { path: 'reason', title: 'Reason', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffAbortRequestSchema,
  },
  {
    id: 'session.handoff.status.get',
    title: 'Get session handoff status',
    description: 'Read scalar status for an in-progress session handoff.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.sessionHandoff.status.get' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Get handoff status',
      fields: [{ path: 'handoffId', title: 'Handoff id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionHandoffStatusGetRequestSchema,
  },
  {
    id: 'session.spawn_new',
    title: 'Create session',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'spawnSession', mcpToolName: 'session_spawn_new', rpcMethod: 'spawn-happy-session' },
    examples: {
      voice: { argsExample: '{"tag":"voice-qa","agentId":"claude","modelId":"default","initialMessage":"Help me inspect this workspace."}' },
    },
	    surfaces: {
	      ui: true,
	      voice: true,
	      session_agent: false,
	      mcp: true,
	      cli: true,
	      rpc: true,
	      sdk: false,
	      },
	    inputHints: {
	      title: 'Create a new session',
	      fields: [
	        { path: 'tag', title: 'Tag', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'host', title: 'Host', widget: 'text' },
        { path: 'initialMessage', title: 'Initial message', widget: 'textarea' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionSpawnNewInputSchema,
  },
  {
    id: 'session.spawn_picker',
    title: 'Create session (picker)',
    description: 'Open the in-app machine + directory picker and create a new session from the user selection.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'spawnSessionPicker', mcpToolName: 'session_spawn_picker' },
    examples: {
      voice: { argsExample: '{"tag":"voice-qa","agentId":"claude","modelId":"default","initialMessage":"Help me inspect this workspace."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Create a new session (picker)',
      fields: [
        { path: 'tag', title: 'Tag', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'initialMessage', title: 'Initial message', widget: 'textarea' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionSpawnPickerInputSchema,
  },
  {
    id: 'paths.list_recent',
    title: 'List recent paths',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths', mcpToolName: 'paths_list_recent' },
    examples: {
      voice: { argsExample: '{"limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List recent paths',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: PathsListRecentInputSchema,
  },
  {
    id: 'machines.list',
    title: 'List machines',
    description: 'List machines available on the active server scope.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listMachines' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List machines',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: z.unknown(),
    inputSchema: MachinesListInputSchema,
  },
  {
    id: 'servers.list',
    title: 'List servers',
    description: 'List servers configured in the client.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: z.unknown(),
    inputSchema: ServersListInputSchema,
  },
  {
    id: 'review.engines.list',
    title: 'List review engines',
    description: 'List review engines currently available for the active session.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: ReviewEnginesListInputSchema,
  },
  {
    id: 'agents.backends.list',
    title: 'List agent backends',
    description: 'List available agent backends (providers) for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10,"machineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'toggle' },
        { path: 'limit', title: 'Max results', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: AgentsBackendsListInputSchema,
  },
  {
    id: 'agents.models.list',
    title: 'List agent models',
    description: 'List available models for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:plugin-review-bot","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: SessionSendMessageInputSchema,
  },
  {
    id: 'session.stop',
    title: 'Stop session',
    description: 'Request that the local daemon stops the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_stop', rpcMethod: 'stop-session' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Stop a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.title.set',
    title: 'Set session title',
    description: 'Set the title (summary text) shown for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_title_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","title":"Fix flaky tests"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Set title',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionTitleSetInputSchema,
  },
  {
    id: 'session.permission_mode.set',
    title: 'Set session permission mode',
    description: 'Update the permission intent (read_only/workspace_write/etc) for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_permission_mode_set', rpcMethod: 'session.permission_mode.set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","permissionMode":"read_only"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    inputHints: {
      title: 'Set permission mode',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'permissionMode', title: 'Permission mode', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionPermissionModeSetInputSchema,
  },
  {
    id: 'session.model.set',
    title: 'Set session model',
    description: 'Set the model override for the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_model_set' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","modelId":"default"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Set session model',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'modelId', title: 'Model id', widget: 'text', required: true },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionModelSetInputSchema,
  },
  {
    id: 'session.archive',
    title: 'Archive session',
    description: 'Archive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_archive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Archive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.unarchive',
    title: 'Unarchive session',
    description: 'Unarchive the specified session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_unarchive' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Unarchive a session',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionIdRequiredInputSchema,
  },
  {
    id: 'session.status.get',
    title: 'Get session status',
    description: 'Get summary status for a session, optionally refreshing live agent state.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_status_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","live":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Get session status',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'live', title: 'Live', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionStatusGetInputSchema,
  },
  {
    id: 'session.history.get',
    title: 'Get session history',
    description: 'Fetch a slice of session history/transcript records.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: SessionHistoryGetInputSchema,
  },
  {
    id: 'session.wait.idle',
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionWaitIdleInputSchema,
  },
  {
    id: 'session.permission.respond',
    title: 'Respond to permission request',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'processPermissionRequest', mcpToolName: 'session_permission_respond', rpcMethod: 'session.permission.respond' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","decision":"allow"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: SessionPermissionRespondInputSchema,
  },
  {
    id: 'session.user_action.answer',
    title: 'Respond to user-action request',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer', rpcMethod: 'session.user_action.answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","answer":"Yes"}]}',
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
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
          path: 'answers.[].answer',
          title: 'Answer',
          description: 'The answer text to send back for that question.',
          widget: 'text',
          required: true,
        },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.mode.set',
    title: 'Set session mode',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode', mcpToolName: 'session_mode_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: SessionModeSetInputSchema,
  },
  {
    id: 'session.target.primary.set',
    title: 'Set primary action session',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Set primary action session',
      fields: [
        { path: 'sessionId', title: 'Session id (or null)', widget: 'text' },
        { path: 'sessionTitle', title: 'Session title', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionPrimaryTargetInputSchema,
  },
  {
    id: 'session.target.tracked.set',
    title: 'Set tracked sessions',
    description: 'Set which sessions should be treated as tracked for updates/snippets.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions', mcpToolName: 'session_target_tracked_set' },
    examples: {
      voice: { argsExample: '{"sessionIds":["{{sessionId}}"]}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Set tracked sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', listSeparator: 'comma', required: true }],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionTrackedTargetsInputSchema,
  },
  {
    id: 'session.list',
    title: 'List sessions',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null,"includeLastMessagePreview":true}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'List sessions',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'toggle' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionListInputSchema,
  },
  {
    id: 'session.activity.get',
    title: 'Get session activity',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity', mcpToolName: 'session_activity_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    inputHints: {
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    outputSchema: z.unknown(),
    inputSchema: SessionActivityInputSchema,
  },
  {
    id: 'session.messages.recent.get',
    title: 'Get recent messages',
    description: 'Get a small slice of recent messages for a session (privacy guarded).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
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
    outputSchema: z.unknown(),
    inputSchema: SessionRecentMessagesInputSchema,
  },
  {
    id: 'ui.voice_global.reset',
    title: 'Reset voice agent',
    safety: 'safe',
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
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.pet.choose',
    title: 'Choose pet',
    description: 'Open pet settings so the user can choose or manage their companion.',
    safety: 'safe',
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Open pet settings.',
      fields: [],
    },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
    },
    outputSchema: z.unknown(),
    inputSchema: EmptyObjectSchema,
  },
  {
    id: 'ui.voice_agent.teleport',
    title: 'Teleport voice agent to session root',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
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
      ui: true,
      voice: true,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
    inputSchema: OptionalSessionIdInputSchema,
  },
  {
    id: 'memory.search',
    title: 'Search memory',
    description: 'Search the local daemon memory index (opt-in).',
    safety: 'safe',
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
      ui: true,
      voice: true,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
    inputSchema: MemorySearchInputSchema,
  },
  {
    id: 'memory.get_window',
    title: 'Get memory window',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
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
      ui: true,
      voice: true,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    outputSchema: z.unknown(),
    inputSchema: MemoryGetWindowInputSchema,
  },
  {
    id: 'memory.ensure_up_to_date',
    title: 'Ensure memory up to date',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
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
      ui: true,
      voice: true,
      session_agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    outputSchema: z.unknown(),
    inputSchema: MemoryEnsureUpToDateInputSchema,
  },
  {
    id: 'prompt_doc.update',
    title: 'Update prompt document',
    description: 'Update a prompt document stored in the Happier prompt library.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_update' },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
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
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
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
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
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
    placements: [],
    bindings: { mcpToolName: 'approval_request_create' },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      },
    outputSchema: z.unknown(),
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
    id: 'daemon.promptAssets.discover',
    title: 'Discover prompt assets',
    description: 'Discover provider-native prompt assets through the daemon prompt asset adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.discover' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: PromptAssetDiscoverRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptAssets.delete',
    title: 'Delete prompt asset',
    description: 'Delete a provider-native prompt asset through the daemon prompt asset adapter registry.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptAssets.delete' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: z.unknown(),
    inputSchema: PromptAssetDeleteRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.scanSource',
    title: 'Scan prompt registry source',
    description: 'Scan a configured prompt registry source through the daemon prompt registry adapter registry.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.scanSource' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: PromptRegistryScanSourceRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.promptRegistry.install',
    title: 'Install prompt registry asset',
    description: 'Install a prompt registry item through bundle-capable prompt asset adapters.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'daemon.promptRegistry.install' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: z.unknown(),
    inputSchema: PromptRegistryInstallRequestV1Schema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.readFile',
    title: 'Read file',
    description: 'Read a bounded file through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'readFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: DaemonFilesystemReadFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.writeFile',
    title: 'Write file',
    description: 'Write a bounded file through daemon filesystem path authorization.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: 'writeFile' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'danger',
    outputSchema: z.unknown(),
    inputSchema: DaemonFilesystemWriteFileInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listDirectory',
    title: 'List directory',
    description: 'List a directory through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: DaemonFilesystemListDirectoryInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.getDirectoryTree',
    title: 'Get directory tree',
    description: 'Read a bounded directory tree through daemon filesystem path authorization.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'getDirectoryTree' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: DaemonFilesystemGetDirectoryTreeInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.listRoots',
    title: 'List filesystem roots',
    description: 'List bounded machine file-browser roots resolved from daemon filesystem access policy.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listRoots' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: EmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'daemon.filesystem.browseDirectory',
    title: 'Browse filesystem directory',
    description: 'List a machine file-browser directory constrained to a configured browse root.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'daemon.filesystem.listDirectory' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: DaemonFilesystemListDirectoryRequestSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.collectDiagnostics',
    title: 'Collect bug report diagnostics',
    description: 'Collect bounded, redacted daemon diagnostics for a bug report.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.collectDiagnostics' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: PassthroughEmptyObjectSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.getLogTail',
    title: 'Read bug report log tail',
    description: 'Read a bounded daemon log tail from diagnostics-approved candidate paths.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.getLogTail' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: BugReportGetLogTailInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'bugreport.uploadArtifact',
    title: 'Upload bug report artifact',
    description: 'Return daemon-side bug report artifact upload availability without exposing secret material.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'bugreport.uploadArtifact' },
    surfaces: DAEMON_ADMIN_RPC_SURFACES,
    sideEffectClass: 'none',
    outputSchema: z.unknown(),
    inputSchema: BugReportUploadArtifactInputSchema,
    inputHints: DAEMON_ADMIN_INPUT_HINTS,
  },
  {
    id: 'approval.request.list',
    title: 'List approval requests',
    description: 'List approval queue entries from targeted approval artifact headers.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.list' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: ApprovalRequestListInputSchema,
    inputHints: {
      title: 'List approval requests',
      description: 'Reads bounded approval queue metadata from artifact headers without transcript hydration.',
      fields: [
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'executed', label: 'Executed' },
            { value: 'failed', label: 'Failed' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  },
  {
    id: 'approval.request.get',
    title: 'Get approval request',
    description: 'Fetch one approval request by approval artifact id.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'approval.request.get' },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
      },
    sideEffectClass: 'read',
    outputSchema: z.unknown(),
    inputSchema: ApprovalRequestGetInputSchema,
    inputHints: {
      title: 'Get approval request',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'approval.request.create',
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'approval_request_create', rpcMethod: 'approval.request.create' },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    sideEffectClass: 'write',
    outputSchema: z.unknown(),
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
    placements: [],
    bindings: { mcpToolName: 'approval_request_decide', rpcMethod: 'approval.request.decide' },
    surfaces: {
      ui: true,
      voice: false,
      session_agent: false,
      mcp: true,
      cli: true,
      rpc: true,
      sdk: false,
      },
    sideEffectClass: 'write',
    outputSchema: z.unknown(),
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
  {
    id: 'session.log.tail',
    title: 'Tail session log',
    description: 'Read a bounded byte tail from an allowed session log file.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSION_LOG_TAIL },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: SessionLogTailOutputSchema,
    inputSchema: SessionLogTailInputSchema,
    inputHints: {
      title: 'Tail session log',
      fields: [
        { path: 'path', title: 'Log path', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'offset', title: 'File offset', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.page',
    title: 'Page session transcript',
    description: 'Read a bounded older transcript page using cursor-backed storage.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_PAGE },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptPageOutputSchema,
    inputSchema: TranscriptPageInputSchema,
    inputHints: {
      title: 'Page session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.readAfter',
    title: 'Read session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_READ_AFTER },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptReadAfterInputSchema,
    inputHints: {
      title: 'Read session transcript after cursor',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.follow',
    title: 'Follow session transcript',
    description: 'Create or refresh a retained bounded transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_FOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptFollowOutputSchema,
    inputSchema: TranscriptFollowInputSchema,
    inputHints: {
      title: 'Follow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'idleTtlMs', title: 'Idle TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.import',
    title: 'Import session transcript rows',
    description: 'Import a bounded batch of transcript rows through the session transcript writer owner.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_IMPORT },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptImportOutputSchema,
    inputSchema: TranscriptImportInputSchema,
    inputHints: {
      title: 'Import session transcript rows',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'items', title: 'Transcript rows', widget: 'textarea', required: true },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'transcript.search',
    title: 'Search session transcript',
    description: 'Search transcript rows through bounded forward cursor reads.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_SEARCH },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptSearchInputSchema,
    inputHints: {
      title: 'Search session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'query', title: 'Query', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'maxReads', title: 'Maximum reads', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.candidates.list',
    title: 'List external session candidates',
    description: 'List attachable external session candidates through the external-session machine RPC.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY],
      sdkMethod: 'sessions.external.listCandidates',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: DirectSessionsCandidatesListResponseSchema,
    inputSchema: DirectSessionsCandidatesListRequestSchema,
    inputHints: {
      title: 'List external session candidates',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'searchTerm', title: 'Search term', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.link.ensure',
    title: 'Ensure external session link',
    description: 'Create or reuse the Happier link for an external provider session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'write',
    outputSchema: DirectSessionLinkEnsureResponseSchema,
    inputSchema: DirectSessionLinkEnsureRequestSchema,
    inputHints: {
      title: 'Ensure external session link',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'titleHint', title: 'Title hint', widget: 'text' },
        { path: 'directoryHint', title: 'Directory hint', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.attach',
    title: 'Attach external session lease',
    description: 'Attach an ephemeral follow lease to an external session link.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'write',
    outputSchema: DirectSessionAttachResponseSchema,
    inputSchema: DirectSessionAttachRequestSchema,
    inputHints: {
      title: 'Attach external session lease',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'ttlMs', title: 'Lease TTL milliseconds', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.detach',
    title: 'Detach external session lease',
    description: 'Detach an external-session follow lease.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'write',
    outputSchema: DirectSessionDetachResponseSchema,
    inputSchema: DirectSessionDetachRequestSchema,
    inputHints: {
      title: 'Detach external session lease',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.followPolicy.set',
    title: 'Set external session follow policy',
    description: 'Enable or disable background following for an external session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'write',
    outputSchema: DirectSessionFollowPolicySetResponseSchema,
    inputSchema: DirectSessionFollowPolicySetRequestSchema,
    inputHints: {
      title: 'Set external session follow policy',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'enabled', title: 'Enabled', widget: 'toggle', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.status.get',
    title: 'Get external session status',
    description: 'Read bounded status and takeover readiness for a linked external session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY],
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: false,
    },
    sideEffectClass: 'read',
    outputSchema: DirectSessionStatusGetResponseSchema,
    inputSchema: DirectSessionStatusGetRequestSchema,
    inputHints: {
      title: 'Get external session status',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.page',
    title: 'Page external session transcript',
    description: 'Read a bounded transcript page for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY],
      sdkMethod: 'sessions.external.pageTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: DirectTranscriptPageResponseSchema,
    inputSchema: DirectTranscriptPageRequestSchema,
    inputHints: {
      title: 'Page external session transcript',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'direction', title: 'Direction', widget: 'select', required: true, options: [
          { value: 'older', label: 'Older' },
          { value: 'newer', label: 'Newer' },
        ] },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.transcript.readAfter',
    title: 'Read external session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY],
      sdkMethod: 'sessions.external.readAfterTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: DirectTranscriptReadAfterResponseSchema,
    inputSchema: DirectTranscriptReadAfterRequestSchema,
    inputHints: {
      title: 'Read external session transcript after cursor',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'providerId', title: 'Provider id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  },
  {
    id: 'sessions.external.takeover',
    title: 'Take over external session',
    description: 'Move a linked external session into a Happier-managed terminal runtime.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
      rpcMethodAliases: [
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ],
      sdkMethod: 'sessions.external.takeover',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionTakeoverResultV1Schema,
    inputSchema: ExternalSessionTakeoverActionInputSchema,
    inputHints: {
      title: 'Take over external session',
      fields: [
        { path: 'linkedSessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'targetRuntimeMode', title: 'Target runtime mode', widget: 'select', required: true, options: [
          { value: 'terminal', label: 'Terminal' },
        ] },
        { path: 'storageMode', title: 'Storage mode', widget: 'select', required: true, options: [
          { value: 'external-linked', label: 'External linked' },
          { value: 'persisted', label: 'Persisted' },
        ] },
        { path: 'forceStop', title: 'Force stop conflicting owner', widget: 'toggle' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.list',
    title: 'List pull requests',
    description: 'List pull requests for the current source-control repository.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.list',
      sdkMethod: 'scm.pullRequest.list',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestListResponseSchema,
    inputSchema: ScmPullRequestListRequestSchema,
    inputHints: {
      title: 'List pull requests',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text' },
        { path: 'head', title: 'Head branch', widget: 'text' },
        {
          path: 'state',
          title: 'State',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
            { value: 'merged', label: 'Merged' },
            { value: 'draft', label: 'Draft' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.pullRequest.get',
    title: 'Get pull request',
    description: 'Read one pull request by number, URL, or head branch.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.get',
      sdkMethod: 'scm.pullRequest.get',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestGetResponseSchema,
    inputSchema: ScmPullRequestGetRequestSchema,
    inputHints: {
      title: 'Get pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.openOrReuse',
    title: 'Open or reuse pull request',
    description: 'Create a pull request or return an existing one for the current branch.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.openOrReuse',
      sdkMethod: 'scm.pullRequest.openOrReuse',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmPullRequestOpenOrReuseResponseSchema,
    inputSchema: ScmPullRequestOpenOrReuseRequestSchema,
    inputHints: {
      title: 'Open or reuse pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text', required: true },
        { path: 'head', title: 'Head branch', widget: 'text' },
        { path: 'title', title: 'Title', widget: 'text' },
        { path: 'body', title: 'Body', widget: 'textarea' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.openCompose',
    title: 'Open pull-request compose URL',
    description: 'Build a provider-approved compose URL for the current branch.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.openCompose',
      sdkMethod: 'scm.pullRequest.openCompose',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmPullRequestOpenComposeResponseSchema,
    inputSchema: ScmPullRequestOpenComposeRequestSchema,
    inputHints: {
      title: 'Open pull-request compose URL',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'providerId', title: 'Provider id', widget: 'text' },
        { path: 'base', title: 'Base branch', widget: 'text', required: true },
        { path: 'head', title: 'Head branch', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'scm.pullRequest.checkout',
    title: 'Check out pull request',
    description: 'Check out a pull request reference in the current repository.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.checkout',
      sdkMethod: 'scm.pullRequest.checkout',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmPullRequestCheckoutResponseSchema,
    inputSchema: ScmPullRequestCheckoutRequestSchema,
    inputHints: {
      title: 'Check out pull request',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.pullRequest.prepareWorktree',
    title: 'Prepare pull-request worktree',
    description: 'Prepare a local worktree for a pull request reference.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.prepareWorktree',
      sdkMethod: 'scm.pullRequest.prepareWorktree',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmPullRequestPrepareWorktreeResponseSchema,
    inputSchema: ScmPullRequestPrepareWorktreeRequestSchema,
    inputHints: {
      title: 'Prepare pull-request worktree',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        { path: 'sourcePath', title: 'Source path', widget: 'text', required: true },
        { path: 'prReference.number', title: 'Pull request number', widget: 'text' },
        { path: 'prReference.url', title: 'Pull request URL', widget: 'text' },
        { path: 'prReference.headBranch', title: 'Head branch', widget: 'text' },
        {
          path: 'mode',
          title: 'Mode',
          widget: 'select',
          options: [
            { value: 'local', label: 'Local checkout' },
            { value: 'worktree', label: 'Worktree' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.pullRequest.runStacked',
    title: 'Run stacked pull-request workflow',
    description: 'Run a structured branch, commit, push, and pull-request workflow.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.pullRequest.runStacked',
      sdkMethod: 'scm.pullRequest.runStacked',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ScmPullRequestRunStackedResponseSchema,
    inputSchema: ScmPullRequestRunStackedRequestSchema,
    inputHints: {
      title: 'Run stacked pull-request workflow',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text' },
        {
          path: 'action',
          title: 'Action',
          widget: 'select',
          required: true,
          options: [
            { value: 'commit', label: 'Commit' },
            { value: 'push', label: 'Push' },
            { value: 'openOrReuse', label: 'Open or reuse pull request' },
            { value: 'commitAndPush', label: 'Commit and push' },
            { value: 'pushAndOpenOrReuse', label: 'Push and open or reuse pull request' },
            { value: 'commitPushAndOpenOrReuse', label: 'Commit, push, and open or reuse pull request' },
          ],
        },
        { path: 'commitMessage', title: 'Commit message', widget: 'textarea' },
        { path: 'featureBranch', title: 'Feature branch', widget: 'text' },
        { path: 'filePaths', title: 'File paths', widget: 'text_list', listSeparator: 'newline' },
        { path: 'base', title: 'Base branch', widget: 'text' },
        { path: 'head', title: 'Head branch', widget: 'text' },
        { path: 'title', title: 'Pull request title', widget: 'text' },
        { path: 'body', title: 'Pull request body', widget: 'textarea' },
        {
          path: 'defaultBranchPushPolicy',
          title: 'Default-branch push policy',
          widget: 'select',
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'requires-feature-branch', label: 'Require feature branch' },
            { value: 'deny', label: 'Deny' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.repository.init',
    title: 'Initialize source-control repository',
    description: 'Initialize source control for a directory through the SCM provisioning route.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.repository.init',
      sdkMethod: 'scm.repository.init',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'write',
    outputSchema: ScmRepositoryInitResponseSchema,
    inputSchema: ScmRepositoryInitRequestSchema,
    inputHints: {
      title: 'Initialize source-control repository',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        { path: 'initialBranch', title: 'Initial branch', widget: 'text' },
      ],
    },
  },
  {
    id: 'scm.repository.removeIndexLock',
    title: 'Remove stale source-control index lock',
    description: 'Remove a confirmed stale Git index lock using backend-owned path resolution.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.repository.removeIndexLock',
      sdkMethod: 'scm.repository.removeIndexLock',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ScmRepositoryRemoveIndexLockResponseSchema,
    inputSchema: ScmRepositoryRemoveIndexLockRequestSchema,
    inputHints: {
      title: 'Remove stale source-control index lock',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        { path: 'confirmed', title: 'Confirm stale index-lock removal', widget: 'checkbox', required: true },
        { path: 'confirmationToken', title: 'Confirmation token', widget: 'text', required: true },
      ],
    },
  },
  {
    id: 'scm.hostingRepository.describePublishTargets',
    title: 'Describe hosting repository publish targets',
    description: 'Describe authenticated hosting-provider targets that can receive a repository publish.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: 'scm.hostingRepository.describePublishTargets',
      sdkMethod: 'scm.hostingRepository.describePublishTargets',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'read',
    outputSchema: ScmHostingRepositoryDescribePublishTargetsResponseSchema,
    inputSchema: ScmHostingRepositoryDescribePublishTargetsRequestSchema,
    inputHints: {
      title: 'Describe hosting repository publish targets',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'providerKind',
          title: 'Hosting provider',
          widget: 'select',
          options: [
            { value: 'github', label: 'GitHub' },
            { value: 'gitlab', label: 'GitLab' },
            { value: 'bitbucket', label: 'Bitbucket' },
            { value: 'custom', label: 'Custom' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
      ],
    },
  },
  {
    id: 'scm.hostingRepository.publish',
    title: 'Publish repository to hosting provider',
    description: 'Create or bind a hosting repository and publish the active source-control state.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: 'scm.hostingRepository.publish',
      sdkMethod: 'scm.hostingRepository.publish',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmHostingRepositoryPublishResponseSchema,
    inputSchema: ScmHostingRepositoryPublishRequestSchema,
    inputHints: {
      title: 'Publish repository to hosting provider',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'providerKind',
          title: 'Hosting provider',
          widget: 'select',
          required: true,
          options: [
            { value: 'github', label: 'GitHub' },
            { value: 'gitlab', label: 'GitLab' },
            { value: 'bitbucket', label: 'Bitbucket' },
            { value: 'custom', label: 'Custom' },
            { value: 'unknown', label: 'Unknown' },
          ],
        },
        { path: 'owner', title: 'Owner', widget: 'text', required: true },
        {
          path: 'ownerKind',
          title: 'Owner kind',
          widget: 'select',
          options: [
            { value: 'user', label: 'User' },
            { value: 'org', label: 'Organization' },
          ],
        },
        { path: 'repositoryName', title: 'Repository name', widget: 'text', required: true },
        {
          path: 'visibility',
          title: 'Visibility',
          widget: 'select',
          required: true,
          options: [
            { value: 'private', label: 'Private' },
            { value: 'public', label: 'Public' },
            { value: 'internal', label: 'Internal' },
          ],
        },
        { path: 'description', title: 'Description', widget: 'textarea' },
        { path: 'remoteName', title: 'Remote name', widget: 'text' },
        {
          path: 'remoteUrlKind',
          title: 'Remote URL kind',
          widget: 'select',
          options: [
            { value: 'https', label: 'HTTPS' },
            { value: 'ssh', label: 'SSH' },
          ],
        },
        {
          path: 'remoteConflictStrategy',
          title: 'Remote conflict strategy',
          widget: 'select',
          options: [
            { value: 'fail', label: 'Fail' },
            { value: 'set-url', label: 'Set URL' },
          ],
        },
        { path: 'pushCurrentBranch', title: 'Push current branch', widget: 'checkbox' },
      ],
    },
  },
  {
    id: 'scm.diffSummary.generate',
    title: 'Generate source-control diff summary',
    description: 'Generate a buffered AI summary for checkpoint-backed or working-tree source-control changes.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
      sdkMethod: 'scm.diffSummary.generate',
    },
    surfaces: {
      ui: false,
      voice: false,
      session_agent: false,
      mcp: false,
      cli: false,
      rpc: true,
      sdk: true,
    },
    sideEffectClass: 'external',
    outputSchema: ScmDiffSummaryGenerateOutputSchema,
    inputSchema: ScmDiffSummaryGenerateInputSchema,
    inputHints: {
      title: 'Generate diff summary',
      description: 'Summaries for turn checkpoints must resolve CHKPT-2 TurnChangeSet evidence by turn id or checkpoint receipt.',
      fields: [
        { path: 'cwd', title: 'Repository directory', widget: 'text', required: true },
        {
          path: 'source.kind',
          title: 'Summary source',
          widget: 'select',
          required: true,
          options: [
            { value: 'turnCheckpoint', label: 'Turn checkpoint' },
            { value: 'workingTree', label: 'Working tree' },
          ],
        },
        { path: 'turnId', title: 'Turn id', widget: 'text' },
        { path: 'checkpointReceiptId', title: 'Checkpoint receipt id', widget: 'text' },
        { path: 'modelSelector.profileId', title: 'Model profile id', widget: 'text' },
        { path: 'modelSelector.modelId', title: 'Model id', widget: 'text' },
        { path: 'modelSelector.backendTargetKey', title: 'Backend target key', widget: 'text' },
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
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
}

export function isVoicePromptHotPathSpec(spec: ActionSpec): boolean {
  return spec.prompting?.voiceHotPath === true;
}

export function listVoicePromptHotPathSpecs(): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter(isVoicePromptHotPathSpec);
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return listActionSpecsForSurface('voice').filter((spec) => Boolean(spec.bindings?.voiceClientToolName));
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
