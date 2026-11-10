import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { MemorySourceV1Schema, MemoryExternalTranscriptSourceV1Schema } from './memorySearch.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';

/** Fresh scope admission and exact-revision index coverage, never an accepted historical turn. */
export const MemoryDocumentStatusV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), facts: z.array(z.strictObject({
    ref: z.extend(PromptDocArtifactRefV1Schema, { serverId: z.string().check(z.minLength(1)) }),
    revision: ArtifactRevisionV1Schema,
    indexedFactCount: z.number().check(z.int(), z.nonnegative()),
    // Global scope has no single prepared Session. Omission is unavailable, not zero.
    loadedFactCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  })) }),
  z.strictObject({ state: z.literal('pending') }),
  z.strictObject({ state: z.literal('unavailable') }),
]));
export type MemoryDocumentStatusV1 = z.infer<typeof MemoryDocumentStatusV1Schema>;

/** Content-free diagnostics from the bounded native-reader owner, never vendor prose. */
export const MemoryNativeReadFailureReasonV1Schema = lazyZodSchema(() => z.string().check(z.regex(
  /^external_sessions_(?:operation_(?:type_error|range_error|syntax_error|rejected)|(?:failure_byte_budget|result_envelope|result_value|result_byte_budget|native_cursor_too_large|transcript_read_failed|transcript_cursor_invalid|transcript_item_json|transcript_page_envelope|transcript_page_item|transcript_page_diagnostics|transcript_page_continuation|transcript_page_byte_budget))$/u,
)));

/** Read projection: external readiness covers a configured source, not one native conversation. */
export const MemoryIndexSourceStatusV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.union([
    MemorySourceV1Schema._zod.def.options[0],
    z.omit(MemoryExternalTranscriptSourceV1Schema, { nativeSessionId: true }),
  ]),
  state: z.enum(['ready', 'indexing', 'disabled', 'error']),
  indexedThroughMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  errorReason: z.optional(MemoryNativeReadFailureReasonV1Schema),
}));
export type MemoryIndexSourceStatusV1 = z.infer<typeof MemoryIndexSourceStatusV1Schema>;

import {
  MemoryEmbeddingsModeSchema,
  MemoryEmbeddingsPresetIdSchema,
} from './memorySettings.js';

export const MemoryIndexContentStatusV1Schema = lazyZodSchema(() => z.looseObject({
    lightShardCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    lightTermCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    deepChunkCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    deepEmbeddingCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    searchableSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    lastIndexedAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    latestIndexedMessageAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  }));
export type MemoryIndexContentStatusV1 = z.infer<typeof MemoryIndexContentStatusV1Schema>;

export const MemoryWorkerStatusV1Schema = lazyZodSchema(() => z.looseObject({
    state: z._default(z.enum(['disabled', 'idle', 'inventorying', 'indexing', 'waiting', 'backoff', 'error']), 'idle'),
    lastTickAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    lastInventoryAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    currentSessionId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    currentPhase: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    /** Volatile child-owned grace; absent on older daemons, null outside grace. */
    idleGraceUntilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    /** Optional read diagnostics, projected from the incumbent operation set and cursors. */
    activeOperations: z.optional(z.array(z.strictObject({
      kind: z.enum(['transcript', 'documents']),
      sessionIds: z.array(z.string().check(z.minLength(1))),
    }))),
    sessionProgress: z.optional(z.array(z.strictObject({
      sessionId: z.string().check(z.minLength(1)),
      observedSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
      /** Checked/excluded inventory frontier; absent for the hints lane. */
      checkedSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
      indexedSeq: z.number().check(z.int(), z.nonnegative()),
    }))),
  }));
export type MemoryWorkerStatusV1 = z.infer<typeof MemoryWorkerStatusV1Schema>;

export const MemoryIndexQueueStatusV1Schema = lazyZodSchema(() => z.looseObject({
    selectedSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    queuedSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    indexingSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    indexedSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    emptySessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    failedSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    waitingSessionCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    oldestQueuedAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  }));
export type MemoryIndexQueueStatusV1 = z.infer<typeof MemoryIndexQueueStatusV1Schema>;

export const MemoryIndexLastRunStatusV1Schema = lazyZodSchema(() => z.looseObject({
    startedAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    finishedAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    sessionsConsidered: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    sessionsProcessed: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    rawRowsFetched: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    semanticRowsFound: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    lightShardsCreated: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    deepChunksCreated: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    failures: z._default(z.number().check(z.int(), z.nonnegative()), 0),
    skipReasons: z._default(z.record(z.string().check(z.minLength(1)), z.number().check(z.int(), z.nonnegative())), {}),
  }));
export type MemoryIndexLastRunStatusV1 = z.infer<typeof MemoryIndexLastRunStatusV1Schema>;

export const MemoryStatusV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    enabled: z.boolean(),
    indexMode: z.enum(['hints', 'deep']),
    hintsIndexReady: z.boolean(),
    hintsIndexHasContent: z._default(z.boolean(), false),
    deepIndexReady: z.boolean(),
    deepIndexHasContent: z._default(z.boolean(), false),
    activeIndexReady: z.boolean(),
    activeIndexSearchable: z._default(z.boolean(), false),
    embeddingsEnabled: z.boolean(),
    embeddingsMode: MemoryEmbeddingsModeSchema,
    embeddingsPresetId: z.nullable(MemoryEmbeddingsPresetIdSchema),
    embeddingsProviderKind: z.nullable(z.enum(['local_transformers', 'openai_compatible'])),
    embeddingsModelId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    embeddingsRuntimeState: z.enum(['ready', 'downloading', 'unavailable', 'error']),
    embeddingsUsingFallback: z.boolean(),
    tier1DbPath: z.nullable(z.string().check(z.minLength(1))),
    deepDbPath: z.nullable(z.string().check(z.minLength(1))),
    tier1DbBytes: z.nullable(z.number().check(z.int(), z.nonnegative())),
    deepDbBytes: z.nullable(z.number().check(z.int(), z.nonnegative())),
    indexContent: z.prefault(z.nullable(MemoryIndexContentStatusV1Schema), null),
    worker: z.prefault(z.nullable(MemoryWorkerStatusV1Schema), null),
    queue: z.prefault(z.nullable(MemoryIndexQueueStatusV1Schema), null),
    lastRun: z.prefault(z.nullable(MemoryIndexLastRunStatusV1Schema), null),
    /**
     * Archived-eligibility actually applied by this daemon. Absence means the
     * daemon does not advertise implementation support for
     * `MemorySettingsV1.includeArchivedSessions`, so a client must present an
     * update/unsupported state rather than claim the desired setting applies.
     */
    includeArchivedSessionsEffective: z.optional(z.boolean()),
    /**
     * Optional corpus negotiation for memory.search. Only explicit true permits
     * a document request; omission preserves old daemon transcript operation.
     */
    documentSearchSupported: z.optional(z.boolean()),
    /** Authority-bearing Project scope is usable only when this exact daemon advertises true. */
    projectSearchSupported: z.optional(z.boolean()),
    /** Scoped status only. Older daemons omit this projection and ignore the scope request. */
    documents: z.optional(MemoryDocumentStatusV1Schema),
    /** Omission is an older daemon, never proof that native sources are current. */
    sources: z.optional(z.array(MemoryIndexSourceStatusV1Schema)),
  }));

export type MemoryStatusV1 = z.infer<typeof MemoryStatusV1Schema>;
