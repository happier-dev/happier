import { z } from 'zod';

import {
  MemoryEmbeddingsModeSchema,
  MemoryEmbeddingsPresetIdSchema,
} from './memorySettings.js';

export const MemoryIndexContentStatusV1Schema = z
  .object({
    lightShardCount: z.number().int().nonnegative().default(0),
    lightTermCount: z.number().int().nonnegative().default(0),
    deepChunkCount: z.number().int().nonnegative().default(0),
    deepEmbeddingCount: z.number().int().nonnegative().default(0),
    searchableSessionCount: z.number().int().nonnegative().default(0),
    lastIndexedAtMs: z.number().int().nonnegative().nullable().default(null),
    latestIndexedMessageAtMs: z.number().int().nonnegative().nullable().default(null),
  })
  .passthrough();
export type MemoryIndexContentStatusV1 = z.infer<typeof MemoryIndexContentStatusV1Schema>;

export const MemoryWorkerStatusV1Schema = z
  .object({
    state: z.enum(['disabled', 'idle', 'inventorying', 'indexing', 'waiting', 'backoff', 'error']).default('idle'),
    lastTickAtMs: z.number().int().nonnegative().nullable().default(null),
    lastInventoryAtMs: z.number().int().nonnegative().nullable().default(null),
    currentSessionId: z.string().min(1).nullable().default(null),
    currentPhase: z.string().min(1).nullable().default(null),
  })
  .passthrough();
export type MemoryWorkerStatusV1 = z.infer<typeof MemoryWorkerStatusV1Schema>;

export const MemoryIndexQueueStatusV1Schema = z
  .object({
    selectedSessionCount: z.number().int().nonnegative().default(0),
    queuedSessionCount: z.number().int().nonnegative().default(0),
    indexingSessionCount: z.number().int().nonnegative().default(0),
    indexedSessionCount: z.number().int().nonnegative().default(0),
    emptySessionCount: z.number().int().nonnegative().default(0),
    failedSessionCount: z.number().int().nonnegative().default(0),
    waitingSessionCount: z.number().int().nonnegative().default(0),
    oldestQueuedAtMs: z.number().int().nonnegative().nullable().default(null),
  })
  .passthrough();
export type MemoryIndexQueueStatusV1 = z.infer<typeof MemoryIndexQueueStatusV1Schema>;

export const MemoryIndexLastRunStatusV1Schema = z
  .object({
    startedAtMs: z.number().int().nonnegative().nullable().default(null),
    finishedAtMs: z.number().int().nonnegative().nullable().default(null),
    sessionsConsidered: z.number().int().nonnegative().default(0),
    sessionsProcessed: z.number().int().nonnegative().default(0),
    rawRowsFetched: z.number().int().nonnegative().default(0),
    semanticRowsFound: z.number().int().nonnegative().default(0),
    lightShardsCreated: z.number().int().nonnegative().default(0),
    deepChunksCreated: z.number().int().nonnegative().default(0),
    failures: z.number().int().nonnegative().default(0),
    skipReasons: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
  })
  .passthrough();
export type MemoryIndexLastRunStatusV1 = z.infer<typeof MemoryIndexLastRunStatusV1Schema>;

export const MemoryStatusV1Schema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean(),
    indexMode: z.enum(['hints', 'deep']),
    hintsIndexReady: z.boolean(),
    hintsIndexHasContent: z.boolean().default(false),
    deepIndexReady: z.boolean(),
    deepIndexHasContent: z.boolean().default(false),
    activeIndexReady: z.boolean(),
    activeIndexSearchable: z.boolean().default(false),
    embeddingsEnabled: z.boolean(),
    embeddingsMode: MemoryEmbeddingsModeSchema,
    embeddingsPresetId: MemoryEmbeddingsPresetIdSchema.nullable(),
    embeddingsProviderKind: z.enum(['local_transformers', 'openai_compatible']).nullable(),
    embeddingsModelId: z.string().trim().min(1).nullable(),
    embeddingsRuntimeState: z.enum(['ready', 'downloading', 'unavailable', 'error']),
    embeddingsUsingFallback: z.boolean(),
    tier1DbPath: z.string().min(1).nullable(),
    deepDbPath: z.string().min(1).nullable(),
    tier1DbBytes: z.number().int().nonnegative().nullable(),
    deepDbBytes: z.number().int().nonnegative().nullable(),
    indexContent: MemoryIndexContentStatusV1Schema.nullable().prefault(null),
    worker: MemoryWorkerStatusV1Schema.nullable().prefault(null),
    queue: MemoryIndexQueueStatusV1Schema.nullable().prefault(null),
    lastRun: MemoryIndexLastRunStatusV1Schema.nullable().prefault(null),
  })
  .passthrough();

export type MemoryStatusV1 = z.infer<typeof MemoryStatusV1Schema>;
