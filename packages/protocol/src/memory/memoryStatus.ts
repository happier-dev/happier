import { z } from 'zod';

import {
  MemoryEmbeddingsModeSchema,
  MemoryEmbeddingsPresetIdSchema,
} from './memorySettings.js';

export const MemoryStatusV1Schema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean(),
    indexMode: z.enum(['hints', 'deep']),
    hintsIndexReady: z.boolean(),
    deepIndexReady: z.boolean(),
    activeIndexReady: z.boolean(),
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
  })
  .passthrough();

export type MemoryStatusV1 = z.infer<typeof MemoryStatusV1Schema>;
