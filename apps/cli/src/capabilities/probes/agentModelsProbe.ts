import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import {
  getAgentModelConfig,
  getAgentStaticModels,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import {
  normalizeProbedCatalogOption,
  type ProbedCatalogOption,
  type ProbedCatalogOptionValue,
} from './probedCatalogOption';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { probeConfiguredAcpBackend } from './probeConfiguredAcpBackend';
import { resolveProviderOwnedPreflightControlsProbeDecision } from './providerOwnedPreflightControlsProbePolicy';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import { z } from 'zod';

type ProbedAgentModelOptionValue = ProbedCatalogOptionValue;

type ProbedAgentModelOption = ProbedCatalogOption;

export type ProbedAgentModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  extendedContextModelId?: string;
  modelOptions?: ReadonlyArray<ProbedAgentModelOption>;
}>;

export type ProbedAgentModelsResult = Readonly<{
  agentId: CatalogAgentLookupId;
  availableModels: ReadonlyArray<ProbedAgentModel>;
  supportsFreeform: boolean;
  source: 'dynamic' | 'static' | 'unavailable';
}>;

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 15_000;
const PROBE_MODELS_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_MODELS_FAILURE_TTL_MS = 60_000;
const agentModelsProbeCache = new AsyncTtlCache<ProbedAgentModelsResult>({
  successTtlMs: PROBE_MODELS_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_MODELS_FAILURE_TTL_MS,
});

const ProbeNonEmptyStringSchema = z.string().trim().min(1);
const ProbeDescriptionSchema = z.string();
const ProbeModelOptionChoiceInputSchema = z.object({
  value: z.unknown().optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});
const ProbeDynamicModelInputSchema = z.object({
  id: ProbeNonEmptyStringSchema.optional(),
  modelId: ProbeNonEmptyStringSchema.optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  contextWindowTokens: z.number().int().positive().max(100_000_000).optional(),
  extendedContextModelId: ProbeNonEmptyStringSchema.optional(),
  modelOptions: z.array(z.unknown()).optional(),
});
const ProbeConfigOptionCandidateSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  options: z.array(z.unknown()).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resetAgentModelsProbeCacheForTests(): void {
  agentModelsProbeCache.clear();
}

/**
 * The bundled model facts an Agent contributes, or `null` when it contributes
 * none. An externally contributed Agent has no bundled model table, so it has
 * no static fallback rather than another Agent's models.
 */
function resolveAgentModelConfigForLookupId(agentId: CatalogAgentLookupId) {
  return getAgentModelConfig(agentId)
    ?? (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)
      ? legacyCustomAcpCompat.getLegacyCustomAcpAgentModelConfig()
      : null);
}

function hasStaticAgentModelsFallback(agentId: CatalogAgentLookupId): boolean {
  return resolveAgentModelConfigForLookupId(agentId) !== null;
}

function buildStatic(
  agentId: CatalogAgentLookupId,
  cfg: NonNullable<ReturnType<typeof resolveAgentModelConfigForLookupId>>,
): ProbedAgentModelsResult {
  const supportsFreeform = cfg.supportsSelection === true && cfg.supportsFreeform === true;
  const seen = new Set<string>();
  const availableModels = (cfg.supportsSelection === true
    ? [
      { id: 'default', name: 'Default' },
      ...getAgentStaticModels(agentId).map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(typeof model.extendedContextModelId === 'string'
          ? { extendedContextModelId: model.extendedContextModelId }
          : {}),
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0 ? { modelOptions: model.modelOptions } : {}),
      })),
    ]
    : [{ id: 'default', name: 'Default' }]).filter((model) => {
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  return {
    agentId,
    availableModels,
    supportsFreeform,
    source: 'static',
  };
}

function buildUnavailable(agentId: CatalogAgentLookupId): ProbedAgentModelsResult {
  return {
    agentId,
    availableModels: [],
    supportsFreeform: false,
    source: 'unavailable',
  };
}

function resolveStaticFallback(agentId: CatalogAgentLookupId): ProbedAgentModelsResult {
  const cfg = resolveAgentModelConfigForLookupId(agentId);
  return cfg ? buildStatic(agentId, cfg) : buildUnavailable(agentId);
}

function tryResolveAgentCliLaunchSpec(agentId: CatalogAgentLookupId) {
  try {
    return resolveAgentCliLaunchSpec(agentId);
  } catch {
    // An installed Agent without a current CLI runtime contribution must not borrow
    // a bundled Agent's metadata or turn an unavailable probe into a fallback.
    return null;
  }
}

function shouldFailClosedForMissingCli(params: {
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
}): boolean {
  if (params.backendTarget?.kind === 'configuredAcpBackend') return false;
  if (!hasStaticAgentModelsFallback(params.agentId)) return false;
  return tryResolveAgentCliLaunchSpec(params.agentId) === null;
}

function normalizeProbeModel(modelRaw: unknown): ProbedAgentModel | null {
  const parsed = ProbeDynamicModelInputSchema.safeParse(modelRaw);
  if (!parsed.success) return null;

  const id = parsed.data.id ?? parsed.data.modelId;
  if (!id) return null;

  const normalizedOptions = parsed.data.modelOptions
    ?.map((option) => normalizeProbedCatalogOption(option))
    .filter((option): option is NonNullable<typeof option> => option !== null);

  return {
    id,
    name: parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: parsed.data.contextWindowTokens }),
    ...(parsed.data.extendedContextModelId === undefined
      ? {}
      : { extendedContextModelId: parsed.data.extendedContextModelId }),
    ...(normalizedOptions && normalizedOptions.length > 0 ? { modelOptions: normalizedOptions } : {}),
  };
}

function normalizeDynamicModels(modelsRaw: unknown): ProbedAgentModel[] | null {
  if (!Array.isArray(modelsRaw)) return null;
  const parsed = modelsRaw
    .map((model) => normalizeProbeModel(model))
    .filter((model): model is ProbedAgentModel => model !== null);

  if (parsed.length === 0) return null;

  const withDefault: ProbedAgentModel[] = [
    { id: 'default', name: 'Default' },
    ...parsed.filter((m) => m.id !== 'default'),
  ];

  const seen = new Set<string>();
  return withDefault.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function normalizePreflightDynamicModels(modelsRaw: unknown): ProbedAgentModel[] | null {
  if (typeof modelsRaw === 'string') {
    const parsed = parseCliModelsOutput(modelsRaw);
    return parsed.length > 0 ? normalizeDynamicModels(parsed) : null;
  }
  const models = normalizeDynamicModels(modelsRaw);
  if (models) return models;
  return Array.isArray(modelsRaw) && modelsRaw.length === 0 ? [] : null;
}

function isSimpleCliModelIdLine(line: string): boolean {
  return !line.startsWith('-') && !line.endsWith(':') && /^[a-z0-9._/:+-]+$/i.test(line);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readJsonObjectBlock(
  lines: ReadonlyArray<string>,
  startIndex: number,
): Readonly<{ value: unknown; endIndex: number }> | null {
  const firstLine = lines[startIndex];
  if (!firstLine?.startsWith('{')) return null;

  let raw = '';
  for (let index = startIndex; index < lines.length; index += 1) {
    raw = raw.length > 0 ? `${raw}\n${lines[index]}` : lines[index] ?? '';
    try {
      return { value: JSON.parse(raw) as unknown, endIndex: index };
    } catch {
      // Keep accumulating until the pretty-printed JSON object is complete.
    }
  }
  return null;
}

function formatProbeOptionChoiceName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeReasoningEffortOption(variantsRaw: unknown): ProbedAgentModelOption | null {
  if (!isRecord(variantsRaw)) return null;

  const options = Object.entries(variantsRaw)
    .map(([variantId, variantRaw]) => {
      const variant = isRecord(variantRaw) ? variantRaw : {};
      const effort = readNonEmptyString(variant.reasoningEffort) ?? readNonEmptyString(variantId);
      if (!effort) return null;
      return {
        value: effort,
        name: formatProbeOptionChoiceName(effort),
      };
    })
    .filter((option): option is Readonly<{ value: string; name: string }> => option !== null);

  if (options.length === 0) return null;

  const medium = options.find((option) => option.value === 'medium')?.value;
  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    type: 'enum',
    currentValue: medium ?? options[0]?.value ?? null,
    options,
  };
}

function normalizeVerboseCliModel(modelRaw: unknown, displayedId?: string): ProbedAgentModel | null {
  if (!isRecord(modelRaw)) return null;

  const modelId = readNonEmptyString(modelRaw.id);
  const providerId =
    readNonEmptyString(modelRaw.providerID)
    ?? readNonEmptyString(modelRaw.providerId)
    ?? readNonEmptyString(modelRaw.provider);
  const id = readNonEmptyString(displayedId) ?? (providerId && modelId ? `${providerId}/${modelId}` : modelId);
  if (!id) return null;

  const name = readNonEmptyString(modelRaw.name) ?? id;
  const description = readNonEmptyString(modelRaw.description);
  const reasoningEffortOption = normalizeReasoningEffortOption(modelRaw.variants);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(reasoningEffortOption ? { modelOptions: [reasoningEffortOption] } : {}),
  };
}

function parseCliModelsOutput(stdout: string): ProbedAgentModel[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: ProbedAgentModel[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lowerLine = line.toLowerCase();
    if (lowerLine === 'available models:' || lowerLine === 'available models') {
      continue;
    }

    if (isSimpleCliModelIdLine(line)) {
      const jsonBlock = readJsonObjectBlock(lines, index + 1);
      if (jsonBlock) {
        const model = normalizeVerboseCliModel(jsonBlock.value, line);
        if (model) parsed.push(model);
        index = jsonBlock.endIndex;
        continue;
      }
    }

    const jsonBlock = readJsonObjectBlock(lines, index);
    if (jsonBlock) {
      const model = normalizeVerboseCliModel(jsonBlock.value);
      if (model) parsed.push(model);
      index = jsonBlock.endIndex;
      continue;
    }

    const bracket = line.match(/^[-*]?\s*(.*?)\s*\[([^\]]+)\]\s*$/);
    if (bracket) {
      const name = String(bracket[1] ?? '').trim();
      const id = String(bracket[2] ?? '').trim();
      if (id && name) {
        parsed.push({ id, name });
      }
      continue;
    }

    if (isSimpleCliModelIdLine(line)) {
      parsed.push({ id: line, name: line });
    }
  }

  return parsed;
}

function normalizeModelsFromConfigOptions(configOptionsRaw: unknown): ProbedAgentModel[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const configOptions = configOptionsRaw
    .map((optionRaw) => ProbeConfigOptionCandidateSchema.safeParse(optionRaw))
    .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success)
    .map((parsed) => parsed.data);
  if (configOptions.length === 0) return null;

  const candidate =
    configOptions.find((option) => option.id?.trim().toLowerCase() === 'model') ??
    configOptions.find((option) => option.name?.trim().toLowerCase() === 'model') ??
    null;
  if (!candidate) return null;

  const optionsRaw = candidate.options ?? null;
  if (!optionsRaw) return null;

  const parsed = optionsRaw
    .map((optionRaw) => {
      const parsedChoice = ProbeModelOptionChoiceInputSchema.safeParse(optionRaw);
      if (!parsedChoice.success) return null;

      const id = ProbeNonEmptyStringSchema.safeParse(parsedChoice.data.value);
      if (!id.success) return null;

      return {
        id: id.data,
        name: parsedChoice.data.name,
        ...(parsedChoice.data.description ? { description: parsedChoice.data.description } : {}),
      } satisfies ProbedAgentModel;
    })
    .filter((model): model is ProbedAgentModel => model !== null);

  if (parsed.length === 0) return null;

  const withDefault: ProbedAgentModel[] = [
    { id: 'default', name: 'Default' },
    ...parsed.filter((m) => m.id !== 'default'),
  ];

  const seen = new Set<string>();
  return withDefault.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export async function probeModelsFromAcpBackend(params: {
  backend: AcpProbeBackend;
  timeoutMs: number;
}): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  const backend = params.backend;

  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  await Promise.race([backend.startSession(), timeoutPromise]).finally(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  });

  if (typeof backend.getSessionModelState === 'function') {
    const state = backend.getSessionModelState();
    const modelsRaw = state?.availableModels;
    const models = normalizeDynamicModels(modelsRaw);
    if (models) return models;
  }

  if (typeof backend.getSessionConfigOptionsState === 'function') {
    const configOptions = backend.getSessionConfigOptionsState();
    const models = normalizeModelsFromConfigOptions(configOptions);
    if (models) return models;
  }

  return null;
}

export async function probeAgentModelsBestEffort(params: {
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials | null;
  env?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionCacheKey?: string | null;
}): Promise<ProbedAgentModelsResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const probeVariant = await resolveAgentProbeVariant({
    agentId: params.agentId,
    probeKind: 'models',
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
  });
  const cacheKey = buildAgentProbeCacheKey({
    agentId: params.agentId,
    cwd,
    backendTarget: params.backendTarget,
    variant: probeVariant,
    connectedServiceSelection: params.connectedServiceSelectionCacheKey,
  });

  const cached = agentModelsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentModelsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentModelsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModelsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentModelsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = resolveStaticFallback(params.agentId);
    if (shouldFailClosedForMissingCli(params)) {
      const unavailable = buildUnavailable(params.agentId);
      agentModelsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
      return unavailable;
    }
    const modelConfig = resolveAgentModelConfigForLookupId(params.agentId);
    if (modelConfig?.dynamicProbe === 'static-only') {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
      return fallback;
    }
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODELS_TIMEOUT_MS;

    try {
      const configuredAcpProbe = await probeConfiguredAcpBackend({
        agentId: params.agentId,
        backendTarget: params.backendTarget,
        cwd,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        onBackend: async (backend) => await probeModelsFromAcpBackend({ backend, timeoutMs }).catch(() => null),
      });
      if (configuredAcpProbe.kind === 'present') {
        const models = configuredAcpProbe.result;
        if (models) {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
        agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      }

      const preflightModelsAdapter = await resolvePreflightSessionControlsProbeAdapter(params.agentId);
      const probeModelsRaw = preflightModelsAdapter?.probeModelsRaw;
      if (probeModelsRaw) {
        const probePreflightModelsOnce = async (): Promise<ProbedAgentModel[] | null> => {
          const modelsRaw = await withPreflightSessionControlsProbeEnvironment({
            agentId: params.agentId,
            processEnv: params.env ?? process.env,
            materializedEnv: params.materializedEnv,
          }, async ({ env }) => await probeModelsRaw({
            backendTarget: params.backendTarget,
            probeKind: 'models',
            cwd,
            timeoutMs,
            accountSettings: params.accountSettings ?? null,
            env,
          })).catch(() => null);
          return normalizePreflightDynamicModels(modelsRaw);
        };

        const probeResult = await runPreflightSessionControlsProbe({
          adapter: preflightModelsAdapter,
          probeOnce: probePreflightModelsOnce,
        });
        const decision = resolveProviderOwnedPreflightControlsProbeDecision({
          probeResult,
          emptySuccess: 'unavailable',
        });
        if (decision.kind === 'success') {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: decision.value, source: 'dynamic' };
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
        const res = buildUnavailable(params.agentId);
        agentModelsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return res;
      }

      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
      return fallback;
    } catch {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
      return fallback;
    }
  });
}
