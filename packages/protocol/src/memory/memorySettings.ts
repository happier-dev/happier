import { z } from 'zod';

import { SecretStringV1Schema } from '../crypto/settingsSecretStringsV1.js';

const MemoryDefaultScopeV1Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).passthrough(),
  // Session scope defaults to "current session" at call time (no sessionId persisted).
  z.object({ type: z.literal('session') }).passthrough(),
]);

export const MemoryHintsSettingsV1Schema = z
  .object({
    summarizerBackendId: z.string().trim().min(1).default('claude'),
    summarizerModelId: z.string().trim().min(1).default('default'),
    summarizerPermissionMode: z.enum(['no_tools', 'read_only']).default('no_tools'),
    windowSizeMessages: z.number().int().min(5).max(500).default(40),
    maxShardChars: z.number().int().min(1_000).max(200_000).default(12_000),
    maxSummaryChars: z.number().int().min(50).max(50_000).default(500),
    paddingMessagesOnVerify: z.number().int().min(0).max(200).default(8),
    updateMode: z.enum(['onIdle', 'continuous']).default('onIdle'),
    idleDelayMs: z.number().int().min(0).max(3_600_000).default(15_000),
    maxRunsPerHour: z.number().int().min(1).max(1_000).default(12),
    failureBackoffBaseMs: z.number().int().min(0).max(604_800_000).default(60_000),
    failureBackoffMaxMs: z.number().int().min(0).max(604_800_000).default(3_600_000),
    maxShardsPerSession: z.number().int().min(1).max(10_000).default(250),
    maxKeywords: z.number().int().min(0).max(100).default(12),
    maxEntities: z.number().int().min(0).max(100).default(12),
    maxDecisions: z.number().int().min(0).max(100).default(12),
  })
  .passthrough();

export type MemoryHintsSettingsV1 = z.infer<typeof MemoryHintsSettingsV1Schema>;
const DEFAULT_MEMORY_HINTS_SETTINGS: MemoryHintsSettingsV1 = MemoryHintsSettingsV1Schema.parse({});

export const MemoryDeepSettingsV1Schema = z
  .object({
    recentDays: z.number().int().min(1).max(3650).default(30),
    maxChunkChars: z.number().int().min(500).max(200_000).default(12_000),
    maxChunkMessages: z.number().int().min(1).max(500).default(50),
    minChunkMessages: z.number().int().min(1).max(500).default(5),
    includeAssistantAcpMessage: z.boolean().default(true),
    includeToolOutput: z.boolean().default(false),
    candidateLimit: z.number().int().min(1).max(10_000).default(200),
    previewChars: z.number().int().min(32).max(10_000).default(800),
    failureBackoffBaseMs: z.number().int().min(0).max(604_800_000).default(60_000),
    failureBackoffMaxMs: z.number().int().min(0).max(604_800_000).default(3_600_000),
  })
  .passthrough();

export type MemoryDeepSettingsV1 = z.infer<typeof MemoryDeepSettingsV1Schema>;
const DEFAULT_MEMORY_DEEP_SETTINGS: MemoryDeepSettingsV1 = MemoryDeepSettingsV1Schema.parse({});

export const MemoryEmbeddingsSettingsV1Schema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['local_transformers', 'remote']).default('local_transformers'),
    modelId: z.string().trim().min(1).default('Xenova/all-MiniLM-L6-v2'),
    wFts: z.number().min(0).max(10).default(0.7),
    wEmb: z.number().min(0).max(10).default(0.3),
  })
  .passthrough();

export type MemoryEmbeddingsSettingsV1 = z.infer<typeof MemoryEmbeddingsSettingsV1Schema>;

export const MemoryEmbeddingsPresetIdSchema = z.enum(['balanced', 'long_context', 'quality']);
export type MemoryEmbeddingsPresetId = z.infer<typeof MemoryEmbeddingsPresetIdSchema>;

export const MemoryEmbeddingsModeSchema = z.enum(['disabled', 'preset', 'custom']);
export type MemoryEmbeddingsMode = z.infer<typeof MemoryEmbeddingsModeSchema>;

export const MemoryEmbeddingsBlendSchema = z
  .object({
    ftsWeight: z.number().min(0).max(10).default(0.7),
    embeddingWeight: z.number().min(0).max(10).default(0.3),
  })
  .passthrough();
export type MemoryEmbeddingsBlend = z.infer<typeof MemoryEmbeddingsBlendSchema>;

export const MemoryEmbeddingsLocalTransformersConfigSchema = z
  .object({
    kind: z.literal('local_transformers'),
    modelId: z.string().trim().min(1).default('Xenova/all-MiniLM-L6-v2'),
    queryPrefix: z.string().trim().min(1).nullable().default(null),
    documentPrefix: z.string().trim().min(1).nullable().default(null),
  })
  .passthrough();
export type MemoryEmbeddingsLocalTransformersConfig = z.infer<typeof MemoryEmbeddingsLocalTransformersConfigSchema>;

export const MemoryEmbeddingsOpenAiCompatibleConfigSchema = z
  .object({
    kind: z.literal('openai_compatible'),
    baseUrl: z.string().trim().min(1).nullable().default(null),
    apiKey: SecretStringV1Schema.nullable().default(null),
    model: z.string().trim().min(1).default('text-embedding-3-small'),
    dimensions: z.number().int().min(1).max(30_720).nullable().default(null),
  })
  .passthrough();
export type MemoryEmbeddingsOpenAiCompatibleConfig = z.infer<typeof MemoryEmbeddingsOpenAiCompatibleConfigSchema>;

export const MemoryEmbeddingsCustomConfigSchema = z.discriminatedUnion('kind', [
  MemoryEmbeddingsLocalTransformersConfigSchema,
  MemoryEmbeddingsOpenAiCompatibleConfigSchema,
]);
export type MemoryEmbeddingsCustomConfig = z.infer<typeof MemoryEmbeddingsCustomConfigSchema>;

export const MemoryEmbeddingsSettingsV2Schema = z
  .object({
    mode: MemoryEmbeddingsModeSchema.default('disabled'),
    presetId: MemoryEmbeddingsPresetIdSchema.default('balanced'),
    custom: MemoryEmbeddingsCustomConfigSchema.nullable().default(null),
    blend: MemoryEmbeddingsBlendSchema.default({
      ftsWeight: 0.7,
      embeddingWeight: 0.3,
    }),
  })
  .passthrough();
export type MemoryEmbeddingsSettingsV2 = z.infer<typeof MemoryEmbeddingsSettingsV2Schema>;

const DEFAULT_MEMORY_EMBEDDINGS_SETTINGS: MemoryEmbeddingsSettingsV2 = MemoryEmbeddingsSettingsV2Schema.parse({});

function normalizeBlend(raw: Readonly<{ wFts?: unknown; wEmb?: unknown }>): MemoryEmbeddingsBlend {
  return MemoryEmbeddingsBlendSchema.parse({
    ftsWeight: raw.wFts,
    embeddingWeight: raw.wEmb,
  });
}

function normalizeLegacyCustomConfig(raw: MemoryEmbeddingsSettingsV1): MemoryEmbeddingsCustomConfig {
  if (raw.provider === 'remote') {
    return MemoryEmbeddingsOpenAiCompatibleConfigSchema.parse({
      kind: 'openai_compatible',
      model: raw.modelId,
    });
  }
  return MemoryEmbeddingsLocalTransformersConfigSchema.parse({
    kind: 'local_transformers',
    modelId: raw.modelId,
  });
}

function mapLegacyPresetId(raw: MemoryEmbeddingsSettingsV1): MemoryEmbeddingsPresetId | null {
  if (raw.provider !== 'local_transformers') return null;
  if (raw.modelId === 'Xenova/all-MiniLM-L6-v2') return 'balanced';
  if (raw.modelId === 'Xenova/jina-embeddings-v2-small-en') return 'long_context';
  if (raw.modelId === 'Alibaba-NLP/gte-modernbert-base') return 'quality';
  return null;
}

export function normalizeMemoryEmbeddingsSettings(raw: unknown): MemoryEmbeddingsSettingsV2 {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const legacyCandidate = raw as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(legacyCandidate, 'enabled') ||
      Object.prototype.hasOwnProperty.call(legacyCandidate, 'provider') ||
      Object.prototype.hasOwnProperty.call(legacyCandidate, 'modelId')
    ) {
      const parsedV1 = MemoryEmbeddingsSettingsV1Schema.safeParse(raw);
      if (parsedV1.success) {
        const legacy = parsedV1.data;
        const presetId = mapLegacyPresetId(legacy);
        if (legacy.enabled !== true) {
          return {
            ...DEFAULT_MEMORY_EMBEDDINGS_SETTINGS,
            blend: normalizeBlend(legacy),
          };
        }

        if (presetId) {
          return MemoryEmbeddingsSettingsV2Schema.parse({
            mode: 'preset',
            presetId,
            blend: normalizeBlend(legacy),
          });
        }

        return MemoryEmbeddingsSettingsV2Schema.parse({
          mode: 'custom',
          custom: normalizeLegacyCustomConfig(legacy),
          blend: normalizeBlend(legacy),
        });
      }
    }
  }

  const parsedV2 = MemoryEmbeddingsSettingsV2Schema.safeParse(raw);
  if (parsedV2.success) {
    return parsedV2.data;
  }
  return DEFAULT_MEMORY_EMBEDDINGS_SETTINGS;
}

export const MemoryBudgetsSettingsV1Schema = z
  .object({
    maxDiskMbLight: z.number().int().min(1).max(1_000_000).default(250),
    maxDiskMbDeep: z.number().int().min(1).max(1_000_000).default(1500),
  })
  .passthrough();

export type MemoryBudgetsSettingsV1 = z.infer<typeof MemoryBudgetsSettingsV1Schema>;
const DEFAULT_MEMORY_BUDGETS_SETTINGS: MemoryBudgetsSettingsV1 = MemoryBudgetsSettingsV1Schema.parse({});

export const MemoryWorkerSettingsV1Schema = z
  .object({
    tickIntervalMs: z.number().int().min(500).max(3_600_000).default(10_000),
    inventoryRefreshIntervalMs: z.number().int().min(5_000).max(3_600_000).default(60_000),
    maxSessionsPerTick: z.number().int().min(1).max(1_000).default(2),
    sessionListPageLimit: z.number().int().min(1).max(500).default(50),
  })
  .passthrough();

export type MemoryWorkerSettingsV1 = z.infer<typeof MemoryWorkerSettingsV1Schema>;
const DEFAULT_MEMORY_WORKER_SETTINGS: MemoryWorkerSettingsV1 = MemoryWorkerSettingsV1Schema.parse({});

export const MemorySettingsV1Schema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean().default(false),
    enabledAtMs: z.number().int().min(0).default(0),
    indexMode: z.enum(['hints', 'deep']).default('hints'),
    defaultScope: MemoryDefaultScopeV1Schema.default({ type: 'global' }),
    backfillPolicy: z.enum(['new_only', 'last_30_days', 'all_history']).default('new_only'),
    deleteOnDisable: z.boolean().default(false),
    hints: MemoryHintsSettingsV1Schema.prefault(DEFAULT_MEMORY_HINTS_SETTINGS),
    deep: MemoryDeepSettingsV1Schema.prefault(DEFAULT_MEMORY_DEEP_SETTINGS),
    embeddings: z.preprocess(
      (value) => normalizeMemoryEmbeddingsSettings(value),
      MemoryEmbeddingsSettingsV2Schema,
    ).prefault(DEFAULT_MEMORY_EMBEDDINGS_SETTINGS),
    budgets: MemoryBudgetsSettingsV1Schema.prefault(DEFAULT_MEMORY_BUDGETS_SETTINGS),
    worker: MemoryWorkerSettingsV1Schema.prefault(DEFAULT_MEMORY_WORKER_SETTINGS),
  })
  .passthrough();

export type MemorySettingsV1 = z.infer<typeof MemorySettingsV1Schema>;

export const DEFAULT_MEMORY_SETTINGS: MemorySettingsV1 = MemorySettingsV1Schema.parse({ v: 1 });

export function normalizeMemorySettings(raw: unknown): MemorySettingsV1 {
  const parsed = MemorySettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MEMORY_SETTINGS;
}
