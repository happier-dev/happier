import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ActionInputPredicateSchema, type ActionInputPredicate } from './actionInputPredicates.js';
import { MemorySearchQueryV1Schema } from '../memory/memorySearch.js';

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

export const ActionSpecSchema = z.object({
  id: ActionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  safety: ActionSafetySchema,
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
  surfaces: ActionSurfaceSchema,
  inputSchema: ZodSchemaLike,
  inputHints: ActionInputHintsSchema.optional(),
}).passthrough();

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
}>;

const EmptyObjectSchema = z.object({}).strict();

const IntentStartCommonSchema = z.object({
  sessionId: z.string().min(1).optional(),
  backendIds: z.array(z.string().min(1)).min(1),
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
  sessionId: z.string().min(1),
}).passthrough();

const SessionSpawnNewInputSchema = z.object({
  tag: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
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

const WorkspacesListRecentInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
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

const AgentsBackendsListInputSchema = z.object({
  includeDisabled: z.boolean().optional(),
}).passthrough();

const AgentsModelsListInputSchema = z.object({
  agentId: z.string().min(1),
  machineId: z.string().min(1).optional(),
}).passthrough();

const SessionSendMessageInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
}).passthrough();

const SessionPermissionRespondInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']),
  requestId: z.string().min(1).optional(),
}).passthrough();

const SessionPrimaryTargetInputSchema = z.object({
  sessionId: z.string().min(1).nullable(),
}).passthrough();

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

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze([
  {
    id: 'review.start',
    title: 'Start review',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    slash: { tokens: ['/h.review'] },
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","engineIds":["codex"],"instructions":"Review this.","changeType":"committed","base":{"kind":"none"}}' },
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
    id: 'plan.start',
    title: 'Start plan run',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    slash: { tokens: ['/h.plan'] },
    bindings: { voiceClientToolName: 'startPlan', mcpToolName: 'plan_start' },
    inputHints: {
      title: 'Start a planning run',
      description: 'Start one or more parallel planning runs using selected backends.',
      fields: [
        {
          path: 'backendIds',
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendIds":["codex"],"instructions":"Plan the changes."}' },
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
    id: 'delegate.start',
    title: 'Start delegate run',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    slash: { tokens: ['/h.delegate'] },
    bindings: { voiceClientToolName: 'startDelegate', mcpToolName: 'delegate_start' },
    inputHints: {
      title: 'Start a delegation run',
      description: 'Start one or more parallel delegation runs using selected backends.',
      fields: [
        {
          path: 'backendIds',
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendIds":["codex"],"instructions":"Delegate the task."}' },
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
          path: 'backendIds',
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","backendIds":["codex"],"instructions":"..."}' },
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
    bindings: { voiceClientToolName: 'getExecutionRun', mcpToolName: 'execution_run_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"...","includeStructured":false}' },
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"...","message":"...","resume":false}' },
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"..."}' },
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
      voice: { argsExample: '{"sessionId":"{{sessionId}}","runId":"...","actionId":"...","input":{}}' },
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
      voice: { argsExample: '{"sessionId":"..."}' },
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
      fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true }],
    },
    inputSchema: SessionOpenInputSchema,
  },
  {
    id: 'session.spawn_new',
    title: 'Create session',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'spawnSession' },
    examples: {
      voice: { argsExample: '{"tag":"...optional...","workspaceId":"...optional...","agentId":"...optional...","modelId":"...optional...","path":"...optional...","host":"...optional...","initialMessage":"...optional..."}' },
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
        { path: 'workspaceId', title: 'Workspace id', widget: 'text' },
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
    bindings: { voiceClientToolName: 'spawnSessionPicker' },
    examples: {
      voice: { argsExample: '{"tag":"...optional...","agentId":"...optional...","modelId":"...optional...","initialMessage":"...optional..."}' },
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
    id: 'workspaces.list_recent',
    title: 'List recent workspaces',
    description: 'List recent workspace handles for discovery without exposing raw paths to remote providers.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentWorkspaces' },
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
      title: 'List recent workspaces',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    inputSchema: WorkspacesListRecentInputSchema,
  },
  {
    id: 'paths.list_recent',
    title: 'List recent paths',
    description: 'List recent workspace directory handles (optionally filtered to a machine).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listRecentPaths' },
    examples: {
      voice: { argsExample: '{"machineId":"...optional...","limit":10}' },
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
    id: 'agents.backends.list',
    title: 'List agent backends',
    description: 'List available agent backends (providers) for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentBackends' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false}' },
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
      fields: [{ path: 'includeDisabled', title: 'Include disabled', widget: 'toggle' }],
    },
    inputSchema: AgentsBackendsListInputSchema,
  },
  {
    id: 'agents.models.list',
    title: 'List agent models',
    description: 'List available models for an agent backend.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentModels' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","machineId":"...optional..."}' },
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
      ],
    },
    inputSchema: AgentsModelsListInputSchema,
  },
  {
    id: 'session.message.send',
    title: 'Send a message to a session',
    description: 'Send a user message to the AI coding assistant inside the specified session.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'sendSessionMessage' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"..."}' },
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
    bindings: { voiceClientToolName: 'processPermissionRequest' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","decision":"allow|deny","requestId":"...optional..."}' },
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
    id: 'session.target.primary.set',
    title: 'Set primary action session',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setPrimaryActionSession' },
    examples: {
      voice: { argsExample: '{"sessionId":"...|null"}' },
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
      fields: [{ path: 'sessionId', title: 'Session id (or null)', widget: 'text' }],
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
      voice: { argsExample: '{"sessionIds":["..."]}' },
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
      voice: { argsExample: '{"sessionId":"..."}' },
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
      voice: { argsExample: '{"sessionId":"...","limit":3,"cursor":null}' },
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
    id: 'memory.search',
    title: 'Search memory',
    description: 'Search the local daemon memory index (opt-in).',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette'],
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
    inputSchema: MemoryEnsureUpToDateInputSchema,
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

export function listVoiceToolActionSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS.filter((spec) => spec.surfaces.voice_tool === true && Boolean(spec.bindings?.voiceClientToolName));
}

export function listVoiceActionBlockSpecs(): readonly ActionSpec[] {
  return ACTION_SPECS.filter(
    (spec) => spec.surfaces.voice_action_block === true && Boolean(spec.bindings?.voiceClientToolName),
  );
}

export function listVoiceClientToolNames(): readonly string[] {
  const names = listVoiceToolActionSpecs()
    .map((spec) => String(spec.bindings?.voiceClientToolName ?? '').trim())
    .filter((name) => name.length > 0);
  names.sort();
  return names;
}
