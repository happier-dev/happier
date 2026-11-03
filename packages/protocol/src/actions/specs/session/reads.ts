import { SESSION_VIEW_INPUT_OPTIONS } from './state.js';
import type { ActionSpecSurfaceBindings, PreNormalizedActionSpec } from '../definition.js';
import { SessionStoredTranscriptRoleSchema, SessionTranscriptGetPublicInputSchema, SessionTranscriptGetExternalShareableInputV1Schema, SessionTranscriptGetInputSchema, SessionTranscriptGetExternalShareableResultV1Schema, SessionTranscriptGetResultSchema } from './transcript.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { z } from 'zod/mini';
import { SessionListQueryV1Schema } from '../../../sessions/listing/query.js';
import { QualifiedProjectKeyV1Schema } from '../../../workspaces/workspaceRefV1.js';
import { SESSION_LIST_AWARENESS_VIEW_V1, SessionActivityActionResultV1Schema, SessionListActionResultV1Schema, SessionListViewV1Schema } from '../../../sessions/awareness/action.js';
import { type ConversationTurnOriginV1 } from '../../../messages/structured/conversationTurnOriginV1.js';
import { SessionInputResultGetInputV1Schema, SessionInputResultGetResultV1Schema } from '../../../sessions/messages/sessionInputResultV1.js';
import { SkillCatalogItemV1Schema, SkillCatalogV1Schema } from '../../../runtime/catalog/skills.js';
import { VendorPluginCatalogItemV1Schema, VendorPluginCatalogV1Schema } from '../../../runtime/catalog/vendorPlugins.js';
import { SESSION_WAIT_IDLE_CLI_PROJECTION } from '../sessionCommandCli.js';
import { SESSION_LIST_CLI_PROJECTION } from './listCli.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';


export const SessionHistoryGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(250))),
  format: z.optional(z.enum(['compact', 'raw'])),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
}));

export const SessionEventsGetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  direction: z.optional(z.enum(['before', 'after'])),
  scope: z.optional(z.enum(['main', 'sidechain', 'all'])),
  sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  roles: z.optional(z.array(SessionStoredTranscriptRoleSchema)),
  kinds: z.optional(z.array(z.string().check(z.minLength(1)))),
  format: z.optional(z.enum(['compact', 'raw'])),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
  includeRaw: z.optional(z.boolean()),
  maxTextChars: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(4000))),
  maxPayloadChars: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(32768))),
}).check(z.superRefine((value, ctx) => {
  if (value.sidechainId && value.scope !== 'sidechain') {
    ctx.addIssue({
      code: "custom",
      message: 'scope must be sidechain when sidechainId is provided',
      path: ['scope'],
    });
  }
})));
export type SessionEventsGetInput = z.infer<typeof SessionEventsGetInputSchema>;
export type SessionEventsGetItem = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  storedMessageRole?: 'user' | 'agent' | 'event' | 'unknown';
  semanticRole: 'user' | 'assistant' | 'tool' | 'event' | 'reasoning' | 'unknown';
  kind: string;
  origin?: ConversationTurnOriginV1;
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

export const SessionWaitIdleInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3600))),
}));

export const SessionWaitIdlePublicInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(SessionWaitIdleInputSchema));

/** Exact result returned by the canonical Session idle waiter. */
export const SessionWaitIdleResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    sessionId: z.string().check(z.minLength(1)),
    idle: z.literal(true),
    observedAt: z.number().check(z.nonnegative()),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'session_not_found',
      'session_id_ambiguous',
      'session_lookup_timeout',
      'unsupported',
      'encryption_material_unavailable',
      'timeout',
    ]),
    candidates: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
  }),
]));

export const SessionCatalogListInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  cwd: z.optional(z.string().check(z.minLength(1))),
}));

export const SessionVendorPluginCatalogListOutputSchema = lazyZodSchema(() => z.looseObject({
  supported: z.optional(z.boolean()),
  unsupported: z.optional(z.literal(true)),
  vendorPlugins: z.readonly(z.array(VendorPluginCatalogItemV1Schema)),
  catalog: z.optional(VendorPluginCatalogV1Schema),
  diagnostic: z.optional(z.string().check(z.minLength(1))),
}));

export const SessionSkillCatalogListOutputSchema = lazyZodSchema(() => z.looseObject({
  supported: z.optional(z.boolean()),
  unsupported: z.optional(z.literal(true)),
  skills: z.readonly(z.array(SkillCatalogItemV1Schema)),
  catalog: z.optional(SkillCatalogV1Schema),
  diagnostic: z.optional(z.string().check(z.minLength(1))),
}));

/**
 * The one typed `session.list` caller contract. Exported so the Action executor parses the
 * admitted input through this owner instead of casting an untyped record into the listing
 * dependency's `SessionListQueryV1` parameter.
 */
export const SessionListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  project: z.optional(QualifiedProjectKeyV1Schema),
  query: z.optional(z.lazy(() => SessionListQueryV1Schema)),
  underSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  view: z.optional(SessionListViewV1Schema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  includeLastMessagePreview: z.optional(z.boolean()),
  activeOnly: z.optional(z.boolean()),
  archivedOnly: z.optional(z.boolean()),
  includeSystem: z.optional(z.boolean()),
  resumableOnly: z.optional(z.boolean()),
  includeRows: z.optional(z.boolean()),
}).check(z.superRefine((value, ctx) => {
  if (value.query !== undefined) {
    for (const field of ['underSessionId', 'limit', 'cursor', 'activeOnly', 'archivedOnly', 'resumableOnly'] as const) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} cannot be combined with query` });
      }
    }
  }
  if (value.view === 'awareness' && Object.prototype.hasOwnProperty.call(value, 'includeLastMessagePreview')) {
    ctx.addIssue({ code: 'custom', path: ['includeLastMessagePreview'], message: 'Awareness does not include message previews' });
  }
})));

/**
 * The compatibility activity read shares `session.list`'s representation selector so Voice, agent,
 * MCP, UI and trusted plugin callers can ask this stable Action ID for canonical awareness instead
 * of reconstructing it. Omission keeps the released digest.
 */
export const SessionActivityInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)),
  view: z.optional(SessionListViewV1Schema),
  windowSeconds: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(86_400))),
}).check(z.superRefine((value, ctx) => {
  if (value.view === SESSION_LIST_AWARENESS_VIEW_V1 && value.windowSeconds !== undefined) {
    // `windowSeconds` only narrows the released retained-window message counts, and awareness has
    // no counts. Accepting both would silently ignore the window the caller asked for.
    ctx.addIssue({
      code: 'custom',
      path: ['windowSeconds'],
      message: 'Awareness does not include retained-window message counts',
    });
  }
})));

export const SessionRecentMessagesInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  includeUser: z.optional(z.boolean()),
  includeAssistant: z.optional(z.boolean()),
  maxCharsPerMessage: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(50_000)))),
}));

export const SESSION_READ_ACTION_SPECS = Object.freeze([
  {
    id: 'session.vendor_plugin_catalog.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List session vendor plugins',
    description: 'List provider-owned vendor plugins available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_vendor_plugin_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the agent plugins a session can use.',
      title: 'List vendor plugins',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionVendorPluginCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.skill_catalog.list', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'List session skills',
    description: 'List provider-visible skills available to the session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_skill_catalog_list' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'See the skills a session\'s agent can use.',
      title: 'List skills',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'cwd', title: 'Working directory', widget: 'text' },
      ],
    },
    outputSchema: SessionSkillCatalogListOutputSchema,
    inputSchema: SessionCatalogListInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.history.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session history',
    description: 'DEPRECATED: use session_events_get. Returns diagnostic session events with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_history_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"format":"compact"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Read a session\'s earlier events.',
      title: 'Get session history',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
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
        { path: 'includeMeta', title: 'Include meta', widget: 'boolean' },
        { path: 'includeStructuredPayload', title: 'Include structured payload', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionHistoryGetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.input.result.get', sideEffectClass: 'read', approval: { result: 'required' },
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Get Session input result',
    description: 'Read one original input’s host-proven native start and current result without waiting, or select projection: reply for its live Ask reply custody (including queued originals).',
    safety: 'safe', placements: [], bindings: { mcpToolName: 'session_input_result_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Input local id', prompt: 'Which original input?', widget: 'text', required: true },
      { path: 'projection', title: 'Projection', widget: 'select', options: [{ value: 'reply', label: 'Ask reply progress' }] },
    ] },
    inputSchema: SessionInputResultGetInputV1Schema, outputSchema: SessionInputResultGetResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.transcript.get', executionPlacement: 'machine', approval: {result: 'required'},
    originalExecution: { accountEncryptionCurrentness: true },
    title: 'Get session transcript',
    sideEffectClass: 'read',
    description: 'Read a semantic transcript page, or select one committed message by messageId, with optional tool/reasoning/event flags.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'getSessionTranscript', mcpToolName: 'session_transcript_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":20,"cursor":null,"direction":"before","roles":["user","assistant"],"maxCharsPerMessage":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Read a session\'s conversation.',
      title: 'Get session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'messageId', title: 'Committed message id', description: 'Select one message instead of paging.', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'direction',
          title: 'Direction',
          description: 'Page away from the cursor: before reads older items (the default), after reads newer ones.',
          widget: 'select',
          options: [
            { value: 'before', label: 'Before cursor (older)' },
            { value: 'after', label: 'After cursor (newer)' },
          ],
        },
        {
          path: 'maxCharsPerMessage',
          title: 'Message truncation chars',
          description: 'Optional per-message truncation budget. Omit or pass null for full message text.',
          widget: 'text',
        },
      ],
    },
    outputSchema: SessionTranscriptGetResultSchema,
    inputSchema: SessionTranscriptGetInputSchema,
    surfaceBindings: {
      api: {
        inputSchema: SessionTranscriptGetPublicInputSchema,
        outputSchema: SessionTranscriptGetResultSchema,
      },
      plugin: {
        inputSchema: SessionTranscriptGetExternalShareableInputV1Schema,
        outputSchema: SessionTranscriptGetExternalShareableResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.events.get', sideEffectClass: 'read', approval: {result: 'required'},
    title: 'Get session events',
    description: 'Inspect raw session events (tool calls, tool results, token counts, lifecycle, permission, stream, session events) for diagnostics. Use session_transcript_get for normal transcript reading.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_events_get' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","limit":50,"kinds":["tool_call","tool_result"]}' },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Look through everything that happened in a session, including tool calls, for troubleshooting.',
      title: 'Get session events',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionEventsGetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.wait.idle', approval: {result: 'required'},
    title: 'Wait for session idle',
    description: 'Wait until the session becomes idle or the timeout elapses.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { voiceClientToolName: 'session_wait_idle', mcpToolName: 'session_wait_idle' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","timeoutSeconds":300}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Wait until a session\'s agent has finished its turn.',
      title: 'Wait for idle',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'timeoutSeconds', title: 'Timeout seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionWaitIdleResultSchema,
    inputSchema: SessionWaitIdleInputSchema,
    cli: SESSION_WAIT_IDLE_CLI_PROJECTION,
    surfaceBindings: {
      api: {
        inputSchema: SessionWaitIdlePublicInputSchema,
        outputSchema: SessionWaitIdleResultSchema,
      },
    } satisfies ActionSpecSurfaceBindings,
  } satisfies PreNormalizedActionSpec,
] as const);


export const SESSION_DISCOVERY_ACTION_SPECS = Object.freeze([
  {
    id: 'session.list', approval: {result: 'required'},
    title: 'List sessions',
    sideEffectClass: 'read',
    description: 'List recent sessions the user can target.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSessions', mcpToolName: 'session_list' },
    examples: {
      voice: { argsExample: '{"limit":20,"cursor":null}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'See your recent sessions.',
      title: 'List sessions',
      fields: [
        {
          // The representation selector belongs to the canonical form hints so every generated
          // UI/CLI/SDK/MCP projection offers the same choice instead of adding a local control.
          path: 'view',
          title: 'View',
          description: 'Summary rows, or the marked operational awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'underSessionId', title: 'Session led subtree', widget: 'text' },
        { path: 'project', title: 'Project', description: 'Exact Home and accepted Project key.', widget: 'json' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeLastMessagePreview', title: 'Include last message preview', widget: 'boolean' },
      ],
    },
    outputSchema: SessionListActionResultV1Schema,
    inputSchema: SessionListActionInputV1Schema,
    cli: SESSION_LIST_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.activity.get', approval: {result: 'required'},
    title: 'Get session activity',
    sideEffectClass: 'read',
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
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'See a short summary of what a session has been doing.',
      title: 'Get session activity',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          // Same canonical selector as `session.list`: every generated UI/CLI/SDK/MCP projection
          // offers awareness here instead of a caller composing it from a local digest.
          path: 'view',
          title: 'View',
          description: 'The released activity digest, or the canonical awareness projection.',
          widget: 'select',
          options: SESSION_VIEW_INPUT_OPTIONS,
        },
        { path: 'windowSeconds', title: 'Window seconds', widget: 'text' },
      ],
    },
    outputSchema: SessionActivityActionResultV1Schema,
    inputSchema: SessionActivityInputSchema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionActivityInputSchema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return {
        sessionId,
        ...(parsed.data.windowSeconds !== undefined ? { windowSeconds: parsed.data.windowSeconds } : {}),
      };
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.messages.recent.get', sideEffectClass: 'read', approval: {result: 'required'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Get recent messages',
    description: 'DEPRECATED: use session_transcript_get. Returns semantic transcript items with cleaner pagination.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'getSessionRecentMessages', mcpToolName: 'session_messages_recent_get' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","limit":3,"cursor":null}' },
      },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Read a session\'s latest messages.',
      title: 'Get recent messages',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'includeUser', title: 'Include user', widget: 'boolean' },
        { path: 'includeAssistant', title: 'Include assistant', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionRecentMessagesInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

