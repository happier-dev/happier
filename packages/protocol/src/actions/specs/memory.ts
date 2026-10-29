import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ExternalSessionsRpcErrorCodeSchema } from '../../sessions/external/rpcErrorCodes.js';
import { MemorySearchQueryV1Schema, MemorySearchScopeSchema, MemoryDocumentSearchCoverageV1Schema, MemorySearchResultHitV1Schema, MemorySearchResultV1Schema } from '../../memory/memorySearch.js';
import { MemoryWindowV1Schema, MemoryWindowRequestV1Schema } from '../../memory/memoryWindow.js';
import { MemorySettingsV1Schema } from '../../memory/memorySettings.js';
import { MemoryStatusV1Schema } from '../../memory/memoryStatus.js';
import { ExternalSessionsSourceSchema, ExternalSessionCandidateV1Schema } from '../../sessions/external/daemonRpcV1.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const MemorySearchInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.string().check(z.minLength(1)),
  query: MemorySearchQueryV1Schema,
}));

export const MemoryMachineInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export const SearchSettingsSetInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  settings: MemorySettingsV1Schema,
}));
export const SearchConversationsInputV1Schema = lazyZodSchema(() => z.strictObject({
  // Conversation fanout and Home search retain their existing scope contract.
  // Project memory is queried through one selected daemon's memory.search.
  query: z.safeExtend(MemorySearchQueryV1Schema, { scope: z.discriminatedUnion('type', [
    MemorySearchScopeSchema._zod.def.options[0], MemorySearchScopeSchema._zod.def.options[1],
  ]) }),
  machineIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  mode: z._default(z.enum(['auto', 'indexed', 'standard']), 'auto'),
  retryUnreachableMachines: z.optional(z.boolean()),
}));
export type SearchConversationsInputV1 = z.infer<typeof SearchConversationsInputV1Schema>;
export const ConversationSearchSourceFailureV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string(), agentId: z.string(), sourceKey: z.string(),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  retryable: z.boolean(),
}));
export type ConversationSearchSourceFailureV1 = z.infer<typeof ConversationSearchSourceFailureV1Schema>;
export const SearchConversationsResultV1Schema = lazyZodSchema(() => z.strictObject({
  hits: z.array(z.discriminatedUnion('mode', [
    z.strictObject({ machineId: z.nullable(z.string()), mode: z.literal('indexed'), hit: MemorySearchResultHitV1Schema }),
    z.strictObject({ machineId: z.string(), mode: z.literal('standard'), agentId: z.string(), sourceKey: z.string(),
      source: ExternalSessionsSourceSchema, candidate: ExternalSessionCandidateV1Schema }),
  ])),
  machines: z.array(z.strictObject({ machineId: z.string(), status: z.enum(['ok', 'offline', 'outdated', 'partial', 'disabled-by-settings']),
    standardSearchEnabled: z.optional(z.boolean()), documents: z.optional(MemoryDocumentSearchCoverageV1Schema.shape.state) })),
  sources: z.optional(z.array(z.strictObject({ machineId: z.string(), agentId: z.string(), sourceKey: z.string(),
    source: ExternalSessionsSourceSchema, contentSearch: z.boolean(), indexReady: z.optional(z.boolean()),
    key: z.optional(z.string()), label: z.optional(z.string()), detail: z.optional(z.string()),
  }))),
  homeStatus: z.optional(z.enum(['ok', 'partial', 'unavailable'])),
  failures: z.optional(z.array(ConversationSearchSourceFailureV1Schema)),
  continuations: z.optional(z.array(z.strictObject({ machineId: z.nullable(z.string()), sourceKey: z.optional(z.string()), cursor: z.string() }))),
  resetSources: z.optional(z.array(z.strictObject({ machineId: z.string(), sourceKey: z.string() }))),
  completedStandardSources: z.optional(z.array(z.strictObject({ machineId: z.string(), agentId: z.string(), sourceKey: z.string() }))),
}));
export const MemoryClearIndexOutputSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));

export const MemoryGetWindowInputSchema = lazyZodSchema(() => z.union([
  z.safeExtend(MemoryWindowRequestV1Schema._zod.def.options[0], { machineId: z.string().check(z.minLength(1)) }),
  z.safeExtend(MemoryWindowRequestV1Schema._zod.def.options[1], { machineId: z.string().check(z.minLength(1)) }),
]));

export const MemoryEnsureUpToDateInputSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.string().check(z.minLength(1)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));

export const MemoryEnsureUpToDateOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
}));

export const MEMORY_ACTION_SPECS = Object.freeze([
  {
    id: 'memory.search', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Search memory',
    sideEffectClass: 'read',
    description: 'Search the selected daemon memory index by global, Session, or qualified Project scope. Project search requires explicit support from that daemon and never falls back to global search.',
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
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: MemorySearchResultV1Schema,
    inputSchema: MemorySearchInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'search.settings.get', approval: {result: 'required'}, title: 'Read Search settings',
    description: 'Read the machine-local memory and conversation Search settings.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'search_settings_get', sdkMethod: 'conversationSearch.settings.get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemorySettingsV1Schema,
    inputHints: { title: 'Read Search settings', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'search.settings.set', approval: {result: 'required'}, title: 'Save Search settings',
    description: 'Save the canonical machine-local memory and conversation Search settings.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'search_settings_set', sdkMethod: 'conversationSearch.settings.set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: SearchSettingsSetInputSchema, outputSchema: MemorySettingsV1Schema,
    inputHints: { title: 'Save Search settings', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'settings', title: 'Settings', widget: 'json', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'memory.status', approval: {result: 'required'}, title: 'Read memory index status',
    description: 'Read readiness, indexing progress and coverage from the machine memory owner.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'machine', placements: [],
    bindings: { voiceClientToolName: 'memory_status', mcpToolName: 'memory_status' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemoryStatusV1Schema,
    inputHints: { title: 'Read memory index status', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'memory.clear_index', approvalPolicy: { uiConfirmation: 'policy' }, approval: {result: 'none'}, title: 'Clear memory index',
    confirmVerb: { key: 'common.reset', fallback: 'Reset' },
    description: 'Clear the machine-local derived memory index. Agent calls require approval by default.',
    sideEffectClass: 'danger', safety: 'danger', executionPlacement: 'machine', placements: [],
    bindings: { voiceClientToolName: 'memory_clear_index', mcpToolName: 'memory_clear_index' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MemoryMachineInputSchema, outputSchema: MemoryClearIndexOutputSchema,
    inputHints: { title: 'Clear memory index', fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'search.conversations', approval: {result: 'required'}, title: 'Search conversations across machines',
    description: 'Search the machines in scope through the connected app conversation-search owner; omitted machineIds selects all machines in scope.',
    sideEffectClass: 'read', safety: 'safe', executionPlacement: 'client', placements: [],
    bindings: { mcpToolName: 'search_conversations', sdkMethod: 'conversationSearch.search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputSchema: SearchConversationsInputV1Schema, outputSchema: SearchConversationsResultV1Schema,
    inputHints: { title: 'Search conversations across machines', fields: [
      { path: 'query', title: 'Memory search query', widget: 'json', required: true },
      { path: 'machineIds', title: 'Machine ids', widget: 'json' },
      { path: 'retryUnreachableMachines', title: 'Retry unreachable machines', widget: 'boolean' },
      { path: 'mode', title: 'Search mode', widget: 'select', options: [
        { value: 'auto', label: 'Best available' }, { value: 'indexed', label: 'Indexed' }, { value: 'standard', label: 'Standard' },
      ] },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'memory.get_window', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Get memory window',
    sideEffectClass: 'read',
    description: 'Fetch and decrypt a transcript window (used to verify/quote a memory hit).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryGetWindow', mcpToolName: 'memory_get_window' },
    inputHints: {
      title: 'Get memory window',
      description: 'Read a Happier Session range or a native hit using its source, sourceItemId and optional cursor.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'seqFrom', title: 'Seq from', widget: 'text' },
        { path: 'seqTo', title: 'Seq to', widget: 'text' },
        { path: 'source', title: 'Native transcript source', widget: 'json' },
        { path: 'sourceItemId', title: 'Native message id', widget: 'text' },
        { path: 'cursor', title: 'Native page cursor', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}","seqFrom":120,"seqTo":124}' },
    },
    outputSchema: MemoryWindowV1Schema,
    inputSchema: MemoryGetWindowInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'memory.ensure_up_to_date', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Ensure memory up to date',
    sideEffectClass: 'write',
    description: 'Trigger the daemon to sync memory hints for a session (or all active sessions).',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'memoryEnsureUpToDate', mcpToolName: 'memory_ensure_up_to_date' },
    inputHints: {
      title: 'Ensure memory up to date',
      description: 'Forces the daemon memory worker to process new transcript content.',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sessionId', title: 'Session id (optional)', prompt: 'Which session?', widget: 'text' },
      ],
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    examples: {
      voice: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
      mcp: { argsExample: '{"machineId":"{{machineId}}","sessionId":"{{sessionId}}"}' },
    },
    outputSchema: MemoryEnsureUpToDateOutputSchema,
    inputSchema: MemoryEnsureUpToDateInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

