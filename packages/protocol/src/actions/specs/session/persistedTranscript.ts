import type { PreNormalizedActionSpec } from '../definition.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionMessageV1Schema } from '../../../sessions/messages/sessionMessagesPageV1.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '../../../sessions/messages/sessionStoredMessageContent.js';
import { SessionSharedMetadataV1Schema } from '../../../sessions/metadata/sessionMetadataSchemasV1.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';


export const SessionLogTailInputSchema = lazyZodSchema(() => z.looseObject({
  path: z.string().check(z.minLength(1)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  offset: z.optional(z.number().check(z.int(), z.minimum(0))),
}));

export const TranscriptPageInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

export const TranscriptReadAfterInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  cursor: z.string().check(z.minLength(1)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

export const TranscriptFollowInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TranscriptReadAfterInputSchema, {
  waitForChanges: z.optional(z.boolean()),
  leaseId: z.optional(z.string().check(z.minLength(1))),
  idleTtlMs: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(3_600_000))),
  projection: z.optional(z.literal('openedMessagesV1')),
  agentStateVersion: z.optional(z.number().check(z.int(), z.minimum(-1))),
  sharedMetadataVersion: z.optional(z.number().check(z.int(), z.minimum(-1))),
})));

export const TranscriptUnfollowInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  leaseId: z.string().check(z.minLength(1)),
}));

export const TranscriptImportInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  importId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  items: z.array(StrictJsonValueSchema).check(z.minLength(1), z.maxLength(500)),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

export const TranscriptSearchInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  query: z.string().check(z.trim(), z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  maxReads: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
}));

export const TranscriptPageOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.optional(z.boolean()),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.nullable(z.string()),
  hasMore: z.optional(z.boolean()),
  tailCursor: z.optional(z.nullable(z.string())),
  truncated: z.boolean(),
}));

export const TranscriptReadAfterOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.optional(z.boolean()),
  items: z.array(StrictJsonValueSchema),
  nextCursor: z.nullable(z.string()),
  truncated: z.boolean(),
}));

/** Closed authoritative version envelope; the opened Agent-native JSON is opaque preserved content. */
export const TranscriptOpenedAgentStateV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.number().check(z.int(), z.minimum(0)),
  value: z.nullable(z.record(z.string(), StrictJsonValueSchema)),
}));
export type TranscriptOpenedAgentStateV1 = z.infer<typeof TranscriptOpenedAgentStateV1Schema>;

/** Only the canonical recipient-safe metadata envelope may cross this opened read. */
export const TranscriptOpenedSharedMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.number().check(z.int(), z.minimum(0)),
  value: SessionSharedMetadataV1Schema,
}));
export type TranscriptOpenedSharedMetadataV1 = z.infer<typeof TranscriptOpenedSharedMetadataV1Schema>;

// Reuse the canonical row projection. Only its stored-content arm changes for this daemon-opened read.
export const TranscriptOpenedMessageV1Schema = lazyZodSchema(() => z.union([
  z.extend(SessionMessageV1Schema, {
    content: z.extend(StrictSessionStoredMessageContentEnvelopeSchema._zod.def.options[1], {
      v: z.record(z.string(), StrictJsonValueSchema),
    }),
    openFailure: z.optional(z.never()),
  }),
  z.extend(SessionMessageV1Schema, {
    content: z.strictObject({ t: z.literal('plain'), v: z.null() }),
    openFailure: z.enum(['mode_mismatch', 'corrupt_or_unopenable']),
  }),
]));

/** Closed follow/cursor envelope; its canonical rows drop unknown presentation fields. */
export const TranscriptFollowChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('append') }),
  z.strictObject({ kind: z.literal('revision'), messageId: z.string().check(z.minLength(1)), seq: z.number().check(z.int(), z.minimum(1)) }),
  z.strictObject({ kind: z.literal('session') }),
  z.strictObject({ kind: z.literal('reset') }),
]));
export type TranscriptFollowChangeV1 = z.infer<typeof TranscriptFollowChangeV1Schema>;

export const TranscriptOpenedFollowOutputV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  leaseId: z.string().check(z.minLength(1)),
  projection: z.literal('openedMessagesV1'),
  items: z.array(TranscriptOpenedMessageV1Schema),
  nextCursor: z.nullable(z.string()),
  truncated: z.boolean(),
  agentState: z.nullable(TranscriptOpenedAgentStateV1Schema),
  sharedMetadata: z.nullable(TranscriptOpenedSharedMetadataV1Schema),
  changes: z.optional(z.array(TranscriptFollowChangeV1Schema)),
}));
export type TranscriptOpenedFollowOutputV1 = z.infer<typeof TranscriptOpenedFollowOutputV1Schema>;

export const TranscriptFollowOutputSchema = lazyZodSchema(() => z.union([(<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(TranscriptReadAfterOutputSchema, {
  changes: z.optional(z.array(TranscriptFollowChangeV1Schema)),
  leaseId: z.optional(z.string().check(z.minLength(1))),
  projection: z.optional(z.never()),
})), TranscriptOpenedFollowOutputV1Schema]));

export const TranscriptUnfollowOutputSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  released: z.boolean(),
}));

export const TranscriptImportOutputSchema = lazyZodSchema(() => z.looseObject({
  ok: z.boolean(),
  imported: z.optional(z.number().check(z.int(), z.minimum(0))),
  cursor: z.optional(z.nullable(z.string())),
}));

export const SessionLogTailOutputSchema = lazyZodSchema(() => z.looseObject({
  success: z.optional(z.boolean()),
  ok: z.optional(z.boolean()),
  path: z.optional(z.string()),
  tail: z.optional(z.string()),
  truncated: z.optional(z.boolean()),
  error: z.optional(z.string()),
}));

export const PERSISTED_TRANSCRIPT_ACTION_SPECS = Object.freeze([
  {
    id: 'session.log.tail', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Tail session log',
    description: 'Read a bounded byte tail from an allowed session log file.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.SESSION_LOG_TAIL },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: SessionLogTailOutputSchema,
    inputSchema: SessionLogTailInputSchema,
    inputHints: {
      description: 'Read the end of a session\'s log.',
      title: 'Tail session log',
      fields: [
        { path: 'path', title: 'Log path', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'offset', title: 'File offset', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.page', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Page session transcript',
    description: 'Read a bounded older transcript page using cursor-backed storage.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_PAGE },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptPageOutputSchema,
    inputSchema: TranscriptPageInputSchema,
    inputHints: {
      description: 'Read earlier parts of a session\'s conversation.',
      title: 'Page session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.readAfter', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Read session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_READ_AFTER },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptReadAfterInputSchema,
    inputHints: {
      description: 'Read what a session has said since a point in its conversation.',
      title: 'Read session transcript after cursor',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.follow', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Follow session transcript',
    description: 'Create or refresh a retained bounded transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_FOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptFollowOutputSchema,
    inputSchema: TranscriptFollowInputSchema,
    inputHints: {
      description: 'Keep up with a session\'s conversation as it happens.',
      title: 'Follow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'idleTtlMs', title: 'Idle TTL milliseconds', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.unfollow', executionPlacement: 'session', approval: {result: 'none'},
    title: 'Unfollow session transcript',
    description: 'Release a retained transcript follow lease.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_UNFOLLOW },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptUnfollowOutputSchema,
    inputSchema: TranscriptUnfollowInputSchema,
    inputHints: {
      description: 'Stop keeping up with a session\'s conversation.',
      title: 'Unfollow session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.import', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Import session transcript rows',
    description: 'Import a bounded batch of transcript rows through the session transcript writer owner.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_IMPORT },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: TranscriptImportOutputSchema,
    inputSchema: TranscriptImportInputSchema,
    inputHints: {
      description: 'Add messages to a session\'s conversation from another record of it.',
      title: 'Import session transcript rows',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'importId', title: 'Import id', widget: 'text' },
        { path: 'items', title: 'Transcript rows', widget: 'textarea', required: true },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'transcript.search', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Search session transcript',
    description: 'Search transcript rows through bounded forward cursor reads.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.TRANSCRIPT_SEARCH },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: TranscriptReadAfterOutputSchema,
    inputSchema: TranscriptSearchInputSchema,
    inputHints: {
      description: 'Search a session\'s conversation.',
      title: 'Search session transcript',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'query', title: 'Query', widget: 'text', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
        { path: 'maxReads', title: 'Maximum reads', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
] as const);

