import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { SecretStringV1Schema } from '../crypto/settingsSecretStringSchemasV1.js';

// Global product fallback. This is Protocol host policy rather than an Agent
// contribution, so activation order cannot redefine the Memory default.
const DEFAULT_MEMORY_SUMMARIZER_BACKEND_ID = 'claude';

const MemoryDefaultScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('global') }),
  // Session scope defaults to "current session" at call time (no sessionId persisted).
  z.looseObject({ type: z.literal('session') }),
]));

export const MemoryCoveragePolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('full') }),
  z.looseObject({
    type: z.literal('latest_messages'),
    maxSemanticMessagesPerSession: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100_000)), 1_000),
  }),
  z.looseObject({
    type: z.literal('latest_days'),
    days: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(3_650)), 30),
  }),
  z.looseObject({ type: z.literal('since_enabled') }),
]));
export type MemoryCoveragePolicyV1 = z.infer<typeof MemoryCoveragePolicyV1Schema>;
const DEFAULT_MEMORY_COVERAGE_POLICY: MemoryCoveragePolicyV1 = lazyDefinition(() => MemoryCoveragePolicyV1Schema.parse({ type: 'full' }));

export const MemoryContentPolicyV1Schema = lazyZodSchema(() => z.looseObject({
    includeUserMessages: z._default(z.boolean(), true),
    includeAssistantMessages: z._default(z.boolean(), true),
    includeReasoning: z._default(z.boolean(), false),
    includeToolSummaries: z._default(z.boolean(), false),
    includeToolOutputs: z._default(z.boolean(), false),
  }));
export type MemoryContentPolicyV1 = z.infer<typeof MemoryContentPolicyV1Schema>;
const DEFAULT_MEMORY_CONTENT_POLICY: MemoryContentPolicyV1 = lazyDefinition(() => MemoryContentPolicyV1Schema.parse({}));

/** Policy provenance stamped onto reconstructible daemon-memory artifacts. */
export const MemoryIndexPolicyV1Schema = lazyZodSchema(() => z.looseObject({
  coveragePolicy: MemoryCoveragePolicyV1Schema,
  contentPolicy: MemoryContentPolicyV1Schema,
  backfillPolicy: z.enum(['new_only', 'last_30_days', 'all_history']),
  enabledAtMs: z.number().check(z.int(), z.minimum(0)),
}));
export type MemoryIndexPolicyV1 = z.infer<typeof MemoryIndexPolicyV1Schema>;

export const MemoryHintsSettingsV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (
      !Object.prototype.hasOwnProperty.call(candidate, 'targetShardMessages') &&
      Object.prototype.hasOwnProperty.call(candidate, 'windowSizeMessages')
    ) {
      return {
        ...candidate,
        targetShardMessages: candidate.windowSizeMessages,
      };
    }
  }
  return value;
}), z.looseObject({
    enabled: z._default(z.boolean(), false),
    summarizerBackendId: z._default(z.string().check(z.trim(), z.minLength(1)), DEFAULT_MEMORY_SUMMARIZER_BACKEND_ID),
    summarizerModelId: z._default(z.string().check(z.trim(), z.minLength(1)), 'default'),
    summarizerPermissionMode: z._default(z.enum(['no_tools', 'read_only']), 'no_tools'),
    windowSizeMessages: z._default(z.number().check(z.int(), z.minimum(5), z.maximum(500)), 40),
    targetShardMessages: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 16),
    minShardMessages: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 1),
    targetShardChars: z._default(z.number().check(z.int(), z.minimum(1_000), z.maximum(200_000)), 8_000),
    maxShardChars: z._default(z.number().check(z.int(), z.minimum(1_000), z.maximum(200_000)), 12_000),
    maxSummaryChars: z._default(z.number().check(z.int(), z.minimum(50), z.maximum(50_000)), 500),
    paddingMessagesOnVerify: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(200)), 8),
    updateMode: z._default(z.enum(['onIdle', 'continuous']), 'onIdle'),
    idleDelayMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(3_600_000)), 15_000),
    maxRunsPerHour: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(1_000)), 12),
    failureBackoffBaseMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(604_800_000)), 60_000),
    failureBackoffMaxMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(604_800_000)), 3_600_000),
    maxShardsPerSession: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(10_000)), 250),
    maxKeywords: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(100)), 12),
    maxEntities: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(100)), 12),
    maxDecisions: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(100)), 12),
  })));

export type MemoryHintsSettingsV1 = z.infer<typeof MemoryHintsSettingsV1Schema>;
const DEFAULT_MEMORY_HINTS_SETTINGS: MemoryHintsSettingsV1 = lazyDefinition(() => MemoryHintsSettingsV1Schema.parse({}));

export const MemoryDeepSettingsV1Schema = lazyZodSchema(() => z.looseObject({
    recentDays: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(3650)), 30),
    maxChunkChars: z._default(z.number().check(z.int(), z.minimum(500), z.maximum(200_000)), 8_000),
    targetChunkMessages: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 12),
    maxChunkMessages: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 25),
    minChunkMessages: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 1),
    includeAssistantAcpMessage: z._default(z.boolean(), true),
    includeToolOutput: z._default(z.boolean(), false),
    candidateLimit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(10_000)), 200),
    previewChars: z._default(z.number().check(z.int(), z.minimum(32), z.maximum(10_000)), 800),
    failureBackoffBaseMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(604_800_000)), 60_000),
    failureBackoffMaxMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(604_800_000)), 3_600_000),
  }));

export type MemoryDeepSettingsV1 = z.infer<typeof MemoryDeepSettingsV1Schema>;
const DEFAULT_MEMORY_DEEP_SETTINGS: MemoryDeepSettingsV1 = lazyDefinition(() => MemoryDeepSettingsV1Schema.parse({}));

export const MemoryEmbeddingsSettingsV1Schema = lazyZodSchema(() => z.looseObject({
    enabled: z._default(z.boolean(), false),
    provider: z._default(z.enum(['local_transformers', 'remote']), 'local_transformers'),
    modelId: z._default(z.string().check(z.trim(), z.minLength(1)), 'Xenova/all-MiniLM-L6-v2'),
    wFts: z._default(z.number().check(z.minimum(0), z.maximum(10)), 0.7),
    wEmb: z._default(z.number().check(z.minimum(0), z.maximum(10)), 0.3),
  }));

export type MemoryEmbeddingsSettingsV1 = z.infer<typeof MemoryEmbeddingsSettingsV1Schema>;

export const MemoryEmbeddingsPresetIdSchema = lazyZodSchema(() => z.enum(['balanced', 'long_context', 'quality']));
export type MemoryEmbeddingsPresetId = z.infer<typeof MemoryEmbeddingsPresetIdSchema>;

export const MemoryEmbeddingsModeSchema = lazyZodSchema(() => z.enum(['disabled', 'preset', 'custom']));
export type MemoryEmbeddingsMode = z.infer<typeof MemoryEmbeddingsModeSchema>;

export const MemoryEmbeddingsBlendSchema = lazyZodSchema(() => z.looseObject({
    ftsWeight: z._default(z.number().check(z.minimum(0), z.maximum(10)), 0.7),
    embeddingWeight: z._default(z.number().check(z.minimum(0), z.maximum(10)), 0.3),
  }));
export type MemoryEmbeddingsBlend = z.infer<typeof MemoryEmbeddingsBlendSchema>;

export const MemoryEmbeddingsLocalTransformersConfigSchema = lazyZodSchema(() => z.looseObject({
    kind: z.literal('local_transformers'),
    modelId: z._default(z.string().check(z.trim(), z.minLength(1)), 'Xenova/all-MiniLM-L6-v2'),
    queryPrefix: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1))), null),
    documentPrefix: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1))), null),
  }));
export type MemoryEmbeddingsLocalTransformersConfig = z.infer<typeof MemoryEmbeddingsLocalTransformersConfigSchema>;

export const MemoryEmbeddingsOpenAiCompatibleConfigSchema = lazyZodSchema(() => z.looseObject({
    kind: z.literal('openai_compatible'),
    baseUrl: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1))), null),
    apiKey: z._default(z.nullable(SecretStringV1Schema), null),
    model: z._default(z.string().check(z.trim(), z.minLength(1)), 'text-embedding-3-small'),
    dimensions: z._default(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(30_720))), null),
  }));
export type MemoryEmbeddingsOpenAiCompatibleConfig = z.infer<typeof MemoryEmbeddingsOpenAiCompatibleConfigSchema>;

export const MemoryEmbeddingsCustomConfigSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  MemoryEmbeddingsLocalTransformersConfigSchema,
  MemoryEmbeddingsOpenAiCompatibleConfigSchema,
]));
export type MemoryEmbeddingsCustomConfig = z.infer<typeof MemoryEmbeddingsCustomConfigSchema>;

export const MemoryEmbeddingsSettingsV2Schema = lazyZodSchema(() => z.looseObject({
    mode: z._default(MemoryEmbeddingsModeSchema, 'disabled'),
    presetId: z._default(MemoryEmbeddingsPresetIdSchema, 'balanced'),
    custom: z._default(z.nullable(MemoryEmbeddingsCustomConfigSchema), null),
    blend: z._default(MemoryEmbeddingsBlendSchema, {
      ftsWeight: 0.7,
      embeddingWeight: 0.3,
    }),
  }));
export type MemoryEmbeddingsSettingsV2 = z.infer<typeof MemoryEmbeddingsSettingsV2Schema>;

const DEFAULT_MEMORY_EMBEDDINGS_SETTINGS: MemoryEmbeddingsSettingsV2 = lazyDefinition(() => MemoryEmbeddingsSettingsV2Schema.parse({}));

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

export const MemoryBudgetsSettingsV1Schema = lazyZodSchema(() => z.looseObject({
    maxDiskMbLight: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000)), 250),
    maxDiskMbDeep: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(1_000_000)), 1500),
  }));

export type MemoryBudgetsSettingsV1 = z.infer<typeof MemoryBudgetsSettingsV1Schema>;
const DEFAULT_MEMORY_BUDGETS_SETTINGS: MemoryBudgetsSettingsV1 = lazyDefinition(() => MemoryBudgetsSettingsV1Schema.parse({}));

export const MemoryWorkerSettingsV1Schema = lazyZodSchema(() => z.looseObject({
    tickIntervalMs: z._default(z.number().check(z.int(), z.minimum(500), z.maximum(3_600_000)), 10_000),
    inventoryRefreshIntervalMs: z._default(z.number().check(z.int(), z.minimum(5_000), z.maximum(3_600_000)), 60_000),
    maxSessionsPerTick: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(1_000)), 2),
    sessionListPageLimit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(500)), 50),
  }));

export type MemoryWorkerSettingsV1 = z.infer<typeof MemoryWorkerSettingsV1Schema>;
const DEFAULT_MEMORY_WORKER_SETTINGS: MemoryWorkerSettingsV1 = lazyDefinition(() => MemoryWorkerSettingsV1Schema.parse({}));

/** Search executes on this Machine and shares its daemon-local Memory settings. */
export const ConversationSearchSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  standardSearch: z.prefault(z.strictObject({ enabled: z._default(z.boolean(), true) }), {}),
  indexExternal: z.prefault(z.strictObject({
    enabled: z._default(z.boolean(), false),
    // Empty selects no Agents; opt-in never silently expands to a new Agent.
    agents: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
    // Null includes all history; there is no independent scan/index budget here.
    historyDays: z._default(z.nullable(z.number().check(z.int(), z.positive())), null),
    includeToolOutput: z._default(z.boolean(), false),
  }), {}),
}));
export type ConversationSearchSettingsV1 = z.infer<typeof ConversationSearchSettingsV1Schema>;

export const MemorySettingsV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.indexMode !== 'hints') return value;
  const hints = candidate.hints;
  if (hints !== undefined && (!hints || typeof hints !== 'object' || Array.isArray(hints))) return value;
  const hintsSettings = hints as Record<string, unknown> | undefined;
  if (hintsSettings && Object.prototype.hasOwnProperty.call(hintsSettings, 'enabled')) return value;
  // The predecessor's explicit hints mode was its summarizer opt-in. Current
  // writes persist the independent switch, so an explicit false always wins.
  return { ...candidate, hints: { ...hintsSettings, enabled: true } };
}), z.looseObject({
    v: z.literal(1),
    enabled: z._default(z.boolean(), true),
    enabledAtMs: z._default(z.number().check(z.int(), z.minimum(0)), 0),
    indexMode: z._default(z.enum(['hints', 'deep']), 'deep'),
    defaultScope: z._default(MemoryDefaultScopeV1Schema, { type: 'global' }),
    backfillPolicy: z._default(z.enum(['new_only', 'last_30_days', 'all_history']), 'new_only'),
    /**
     * Opt-in eligibility of archived Sessions for daemon-local memory
     * indexing and search. Off by default: the archived inventory is never
     * requested and a Session that becomes archived leaves the daemon search
     * projection. Older daemons preserve this additive field while ignoring
     * it, so a desired-settings readback is not proof it is applied; the
     * daemon advertises actual support through
     * `MemoryStatusV1.includeArchivedSessionsEffective`.
     */
    includeArchivedSessions: z._default(z.boolean(), false),
    conversationSearch: z.prefault(ConversationSearchSettingsV1Schema, {}),
    coveragePolicy: z.prefault(MemoryCoveragePolicyV1Schema, DEFAULT_MEMORY_COVERAGE_POLICY),
    contentPolicy: z.prefault(MemoryContentPolicyV1Schema, DEFAULT_MEMORY_CONTENT_POLICY),
    deleteOnDisable: z._default(z.boolean(), false),
    hints: z.prefault(MemoryHintsSettingsV1Schema, DEFAULT_MEMORY_HINTS_SETTINGS),
    deep: z.prefault(MemoryDeepSettingsV1Schema, DEFAULT_MEMORY_DEEP_SETTINGS),
    embeddings: z.prefault((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => normalizeMemoryEmbeddingsSettings(value)), MemoryEmbeddingsSettingsV2Schema), DEFAULT_MEMORY_EMBEDDINGS_SETTINGS),
    budgets: z.prefault(MemoryBudgetsSettingsV1Schema, DEFAULT_MEMORY_BUDGETS_SETTINGS),
    worker: z.prefault(MemoryWorkerSettingsV1Schema, DEFAULT_MEMORY_WORKER_SETTINGS),
  })));

export type MemorySettingsV1 = z.infer<typeof MemorySettingsV1Schema>;

export const DEFAULT_MEMORY_SETTINGS: MemorySettingsV1 = lazyDefinition(() => MemorySettingsV1Schema.parse({ v: 1 }));

export function normalizeMemorySettings(raw: unknown): MemorySettingsV1 {
  const parsed = MemorySettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MEMORY_SETTINGS;
}
