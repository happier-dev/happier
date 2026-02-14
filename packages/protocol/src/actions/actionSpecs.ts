import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';
import { ExecutionRunIntentSchema } from '../executionRuns.js';

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
}).passthrough();

export type ActionSpec = z.infer<typeof ActionSpecSchema> & Readonly<{
  placements: readonly ActionUiPlacement[];
}>;

const EmptyObjectSchema = z.object({}).strict();

const ExecutionRunStartInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  instructions: z.string().optional(),
  permissionMode: z.string().optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough();

const ExecutionRunIdInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1),
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
  path: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
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

export const ACTION_SPECS: readonly ActionSpec[] = Object.freeze([
  {
    id: 'execution.run.start',
    title: 'Start execution run',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    slash: { tokens: ['/h.review', '/h.plan', '/h.delegate', '/h.voice'] },
    bindings: { voiceClientToolName: 'startExecutionRun', mcpToolName: 'execution_run_start' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","intent":"review","backendId":"claude","instructions":"..."}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: true,
      voice_tool: true,
      voice_action_block: true,
      mcp: true,
      session_control_cli: true,
    },
    inputSchema: ExecutionRunStartInputSchema,
  },
  {
    id: 'execution.run.list',
    title: 'List execution runs',
    safety: 'safe',
    placements: ['run_list', 'command_palette', 'slash_command', 'voice_panel'],
    slash: { tokens: ['/h.runs'] },
    bindings: { voiceClientToolName: 'listExecutionRuns', mcpToolName: 'execution_run_list' },
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
    inputSchema: ExecutionRunIdInputSchema,
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
    inputSchema: SessionOpenInputSchema,
  },
  {
    id: 'session.spawn_new',
    title: 'Create session',
    safety: 'safe',
    placements: ['command_palette', 'session_info', 'voice_panel'],
    bindings: { voiceClientToolName: 'spawnSession' },
    examples: {
      voice: { argsExample: '{"tag":"...optional...","path":"...optional...","host":"...optional...","initialMessage":"...optional..."}' },
    },
    surfaces: {
      ui_button: true,
      ui_slash_command: false,
      voice_tool: true,
      voice_action_block: true,
      mcp: false,
      session_control_cli: true,
    },
    inputSchema: SessionSpawnNewInputSchema,
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
    inputSchema: SessionRecentMessagesInputSchema,
  },
  {
    id: 'ui.voice_global.reset',
    title: 'Reset voice agent',
    safety: 'safe',
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent' },
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
