import { z } from 'zod';

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

export const MemoryBudgetsSettingsV1Schema = z
  .object({
    maxDiskMbLight: z.number().int().min(1).max(1_000_000).default(250),
    maxDiskMbDeep: z.number().int().min(1).max(1_000_000).default(1500),
  })
  .passthrough();

export type MemoryBudgetsSettingsV1 = z.infer<typeof MemoryBudgetsSettingsV1Schema>;

export const MemoryWorkerSettingsV1Schema = z
  .object({
    tickIntervalMs: z.number().int().min(500).max(3_600_000).default(10_000),
    inventoryRefreshIntervalMs: z.number().int().min(5_000).max(3_600_000).default(60_000),
    maxSessionsPerTick: z.number().int().min(1).max(1_000).default(2),
    sessionListPageLimit: z.number().int().min(1).max(500).default(50),
  })
  .passthrough();

export type MemoryWorkerSettingsV1 = z.infer<typeof MemoryWorkerSettingsV1Schema>;

export const MemorySettingsV1Schema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean().default(false),
    indexMode: z.enum(['hints', 'deep']).default('hints'),
    defaultScope: MemoryDefaultScopeV1Schema.default({ type: 'global' }),
    backfillPolicy: z.enum(['new_only', 'last_30_days', 'all_history']).default('new_only'),
    deleteOnDisable: z.boolean().default(false),
    hints: MemoryHintsSettingsV1Schema.default({}),
    deep: MemoryDeepSettingsV1Schema.default({}),
    embeddings: MemoryEmbeddingsSettingsV1Schema.default({}),
    budgets: MemoryBudgetsSettingsV1Schema.default({}),
    worker: MemoryWorkerSettingsV1Schema.default({}),
  })
  .passthrough();

export type MemorySettingsV1 = z.infer<typeof MemorySettingsV1Schema>;

export const DEFAULT_MEMORY_SETTINGS: MemorySettingsV1 = MemorySettingsV1Schema.parse({ v: 1 });

export function normalizeMemorySettings(raw: unknown): MemorySettingsV1 {
  const parsed = MemorySettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MEMORY_SETTINGS;
}

