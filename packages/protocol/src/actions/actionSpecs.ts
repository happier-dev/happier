import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ActionInputPredicateSchema, type ActionInputPredicate } from './actionInputPredicates.js';
import { MemorySearchQueryV1Schema } from '../memory/memorySearch.js';
import { ApprovalRequestCreatedBySchema } from '../approvals/approvalRequestV1.js';
import { PromptRegistryConfiguredSourceV1Schema } from '../promptLibrary/promptRegistriesV1.js';
import { PromptAssetInstallModeV1Schema, PromptAssetScopeV1Schema } from '../promptLibrary/promptAssetsV1.js';
import { BackendTargetKeySchema } from '../backendTargets/backendTargetRef.js';
import { SessionRollbackTargetSchema } from '../sessionRollback.js';
import { SessionHandoffWorkspaceTransferSchema } from '../sessionControl/handoff/handoffSchemas.js';

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
  mcp: z.boolean(),
  session_control_cli: z.boolean(),
}).strict();
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
  /**
   * When set, the action can be routed through the approval queue even if the
   * action itself is marked as `safety='safe'`.
   *
   * This does not imply that the action always requires approvals; it only
   * signals eligibility for approval request wrappers.
   */
  requiresApprovalQueue: z.boolean().optional(),
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
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
}).passthrough();

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
}>;

const EmptyObjectSchema = z.object({}).strict();
const OptionalSessionIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
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
  path: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
}).passthrough();

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
  agentId: z.string().min(1),
  machineId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();

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
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).nullable().optional(),
  includeLastMessagePreview: z.boolean().optional(),
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
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: false,
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
      mcp: true,
      session_control_cli: false,
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
      mcp: true,
      session_control_cli: false,
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
      mcp: true,
      session_control_cli: true,
    },
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
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: true,
    },
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
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: true,
    },
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
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: true,
    },
    inputSchema: VoiceAgentStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/h.runs'] },
    bindings: { voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
    inputHints: {
      title: 'List execution runs',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: true,
    },
    inputSchema: z.object({ sessionId: z.string().min(1).optional() }).passthrough(),
  },
  {
    id: 'execution.run.get',
    title: 'Get execution run',
    safety: 'safe',
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
      mcp: true,
      session_control_cli: true,
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
      mcp: true,
      session_control_cli: true,
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
      mcp: true,
      session_control_cli: true,
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
      mcp: true,
      session_control_cli: true,
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
    id: 'session.open',
    title: 'Open session',
    safety: 'safe',
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
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
    },
    inputHints: {
      title: 'Fork a session',
      description: 'Forks from the latest message in the session.',
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text' }],
    },
    inputSchema: SessionForkInputSchema,
  },
  {
    id: 'session.rollback',
    title: 'Rollback conversation',
    description: 'Roll back conversation state in the selected session.',
    safety: 'danger',
    placements: ['session_action_menu', 'session_info'],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: false,
      session_control_cli: false,
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
    placements: ['session_action_menu', 'session_info'],
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","targetMachineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: false,
      session_control_cli: false,
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
    placements: ['command_palette', 'session_info', 'voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'spawnSession' },
    examples: {
      voice: { argsExample: '{"tag":"voice-qa","agentId":"claude","modelId":"default","initialMessage":"Help me inspect this workspace."}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: true,
    },
    inputHints: {
      title: 'Create a new session',
      fields: [
        { path: 'tag', title: 'Tag', widget: 'text' },
        { path: 'agentId', title: 'Agent id', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'host', title: 'Host', widget: 'text' },
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
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentModels' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","limit":10}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
    },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    requiresApprovalQueue: true,
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'sendSessionMessage' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes."}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
    },
    inputHints: {
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
      ],
    },
    inputSchema: SessionSendMessageInputSchema,
  },
  {
    id: 'session.permission.respond',
    title: 'Respond to permission request',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'processPermissionRequest' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","decision":"allow"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","answer":"Yes"}]}',
      },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    inputSchema: SessionUserActionAnswerInputSchema,
  },
  {
    id: 'session.mode.set',
    title: 'Set session mode',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
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
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession' },
    examples: {
      voice: { argsExample: '{"sessionTitle":"Session Setup"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions' },
    examples: {
      voice: { argsExample: '{"sessionIds":["{{sessionId}}"]}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null,"includeLastMessagePreview":true}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
    },
    inputHints: {
      title: 'List sessions',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'toggle' },
      ],
    },
    inputSchema: SessionListInputSchema,
  },
  {
    id: 'session.activity.get',
    title: 'Get session activity',
    description: 'Get a short activity digest for a session without transcript content.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionActivity' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
    description: 'Get a small slice of recent messages for a session (privacy guarded).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionRecentMessages' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
    },
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
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
      mcp: false,
      session_control_cli: false,
    },
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
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: false,
    },
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
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: false,
    },
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
      ui_button: false,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: false,
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
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: false,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: true,
      session_control_cli: false,
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
    placements: [],
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: false,
      voice_action_block: false,
      mcp: false,
      session_control_cli: false,
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
