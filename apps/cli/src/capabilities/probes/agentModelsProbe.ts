import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { AgentProbeModel, AgentModelsProbeObservation } from '@happier-dev/protocol/capabilities';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { AcpCatalogUnavailableError } from '@/agent/acp/catalog/configured/resolveBackend';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { readSessionModelStateFromConfigOptions } from '@/agent/acp/sessionSettings/sessionSettingsState';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import {
  getAgentModelConfig,
  getAgentStaticModels,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { ProviderModelDescriptorV1Schema, resolveModelStructuredOutputSupport } from '@happier-dev/protocol/models/descriptor';
import type { ProviderModelDescriptorV1, BackendTargetRefV1 } from '@happier-dev/protocol';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { StoredCredentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import {
  normalizeProbedCatalogOption,
  type ProbedCatalogOption,
  type ProbedCatalogOptionValue,
} from './probedCatalogOption';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { probeConfiguredAcpBackend } from './probeConfiguredAcpBackend';
import { probeAcpSessionControlsFromBackend } from './probeAcpCatalogs';
import { resolveProviderOwnedPreflightControlsProbeDecision } from './providerOwnedPreflightControlsProbePolicy';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import { isDynamicModelProbeEnabled } from '@/providers/probe/nativeCatalogCredential';
import { SpawnFailureError, type SpawnFailure } from '@/processes/spawnFailure/classifySpawnFailure';
import { SpawnFailureV1Schema } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { z } from 'zod/mini';

type ProbedAgentModelOptionValue = ProbedCatalogOptionValue;

type ProbedAgentModelOption = ProbedCatalogOption;

export type ProbedAgentModel = Readonly<AgentProbeModel>;

export type ProbedAgentModelsResult = Readonly<AgentModelsProbeObservation & {
  agentId: CatalogAgentLookupId;
  source: 'dynamic' | 'static' | 'unavailable';
}>;

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 15_000;
const PROBE_MODELS_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_MODELS_FAILURE_TTL_MS = 60_000;
const agentModelsProbeCache = new AsyncTtlCache<ProbedAgentModelsResult>({
  successTtlMs: PROBE_MODELS_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_MODELS_FAILURE_TTL_MS,
});

const ProbeModelsObservationSchema = lazyZodSchema(() => z.object({
  availableModels: z.array(z.unknown()),
  observedAt: z.optional(z.number().check(z.nonnegative())),
  refreshError: z.optional(z.boolean()),
  refreshErrorMessage: z.optional(z.string()),
  spawnFailure: z.optional(SpawnFailureV1Schema),
  source: z.optional(z.enum(['dynamic', 'static', 'unavailable'])),
  // A native inventory was read, but some eligibility could not be established.
  // Consume this raw producer fact here; it is not a published observation field.
  catalogObserved: z.optional(z.literal(true)),
}));
const ProbeDescriptionSchema = lazyZodSchema(() => z.string());
const ProbeDynamicModelInputSchema = lazyZodSchema(() => z.object({
  id: z.optional(NonBlankOpaqueIdentifierSchema),
  modelId: z.optional(NonBlankOpaqueIdentifierSchema),
  name: NonBlankOpaqueIdentifierSchema,
  description: z.optional(ProbeDescriptionSchema),
  contextWindowTokens: z.optional(z.number().check(z.int(), z.positive(), z.maximum(100_000_000))),
  extendedContextModelId: z.optional(NonBlankOpaqueIdentifierSchema),
  modelOptions: z.optional(z.array(z.unknown())),
  capabilities: ProviderModelDescriptorV1Schema.shape.capabilities,
  costTier: ProviderModelDescriptorV1Schema.shape.costTier,
}));

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

function buildDefaultModelPlaceholder(): ProbedAgentModel {
  // This selects the native default without claiming a concrete model identity.
  // The native projection applies its Agent's declared JSON contract; configured
  // ACP defaults keep their separately negotiated evidence below.
  return { id: 'default', name: 'Default' };
}

function buildStatic(
  agentId: CatalogAgentLookupId,
  cfg: NonNullable<ReturnType<typeof resolveAgentModelConfigForLookupId>>,
): ProbedAgentModelsResult {
  const supportsFreeform = cfg.supportsSelection === true && cfg.supportsFreeform === true;
  const seen = new Set<string>();
  const staticModels: ProbedAgentModel[] = cfg.supportsSelection === true
    ? getAgentStaticModels(agentId, { catalogOnly: true })
      .map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(typeof model.extendedContextModelId === 'string'
          ? { extendedContextModelId: model.extendedContextModelId }
          : {}),
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0 ? { modelOptions: model.modelOptions } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
        ...(model.costTier ? { costTier: model.costTier } : {}),
      })) : [];
  const availableModels = [
    staticModels.find(model => model.id === 'default') ?? buildDefaultModelPlaceholder(),
    ...staticModels.filter(model => model.id !== 'default'),
  ].filter((model) => {
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
  const config = resolveAgentModelConfigForLookupId(agentId);
  return {
    agentId,
    availableModels: [],
    // Discovery availability and the Agent's explicit-selection capability are
    // separate facts. Keep the declared recovery path when a catalog fails.
    supportsFreeform: config?.supportsSelection === true && config.supportsFreeform === true,
    source: 'unavailable',
  };
}

function resolveStaticFallback(agentId: CatalogAgentLookupId): ProbedAgentModelsResult {
  const cfg = resolveAgentModelConfigForLookupId(agentId);
  return cfg ? buildStatic(agentId, cfg) : buildUnavailable(agentId);
}

function resolveDynamicProbeFailureFallback(agentId: CatalogAgentLookupId): ProbedAgentModelsResult {
  const cfg = resolveAgentModelConfigForLookupId(agentId);
  if (!cfg || getAgentStaticModels(agentId, { catalogOnly: true }).length === 0) {
    return buildUnavailable(agentId);
  }
  return buildStatic(agentId, cfg);
}

function tryResolveAgentCliLaunchSpec(agentId: CatalogAgentLookupId, processEnv?: NodeJS.ProcessEnv) {
  try {
    return resolveAgentCliLaunchSpec(agentId, { processEnv });
  } catch {
    // An installed Agent without a current CLI runtime contribution must not borrow
    // a bundled Agent's metadata or turn an unavailable probe into a fallback.
    return null;
  }
}

function shouldFailClosedForMissingCli(params: {
  agentId: CatalogAgentLookupId;
  env?: NodeJS.ProcessEnv;
  backendTarget?: BackendTargetRefV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}): boolean {
  if (params.backendTarget?.kind === 'configuredAcpBackend') return false;
  if (!hasStaticAgentModelsFallback(params.agentId)) return false;
  return tryResolveAgentCliLaunchSpec(params.agentId, params.env) === null;
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
    ...(parsed.data.capabilities ? { capabilities: parsed.data.capabilities } : {}),
    ...(parsed.data.costTier ? { costTier: parsed.data.costTier } : {}),
  };
}

function normalizeDynamicModels(modelsRaw: unknown): ProbedAgentModel[] | null {
  if (!Array.isArray(modelsRaw)) return null;
  const parsed = modelsRaw
    .map((model) => normalizeProbeModel(model))
    .filter((model): model is ProbedAgentModel => model !== null);

  if (parsed.length === 0) return null;

  const withDefault: ProbedAgentModel[] = [
    parsed.find((model) => model.id === 'default') ?? buildDefaultModelPlaceholder(),
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
  const capabilities = ProviderModelDescriptorV1Schema.shape.capabilities.safeParse(modelRaw.capabilities);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(reasoningEffortOption ? { modelOptions: [reasoningEffortOption] } : {}),
    ...(capabilities.success && capabilities.data ? { capabilities: capabilities.data } : {}),
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

export function normalizeAcpModelsSnapshot(modelsRaw: unknown, configOptionsRaw: unknown, modelConfigOptionId?: string): ProbedAgentModel[] | null {
  let models = normalizeDynamicModels(modelsRaw);
  if (!models) {
    const configModels = readSessionModelStateFromConfigOptions({ configOptions: configOptionsRaw }, modelConfigOptionId)?.availableModels;
    models = normalizeDynamicModels(configModels)
      ?? (Array.isArray(modelsRaw) && modelsRaw.length === 0 || configModels?.length === 0 ? [] : null);
  }
  return models?.map(model => model.id === 'default' && model.capabilities?.structuredOutput === undefined
    ? { ...model, capabilities: { ...model.capabilities, structuredOutput: 'unknown' as const } }
    : model) ?? null;
}

export async function probeModelsFromAcpBackend(params: {
  backend: AcpProbeBackend;
  timeoutMs: number;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
}): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  const controls = await probeAcpSessionControlsFromBackend(params);

  // The backend already resolved its declared selector. Reinterpreting raw config
  // here would turn its refused/missing declared selector into an inferred one.
  return normalizeAcpModelsSnapshot(
    controls.models,
    null,
  );
}

async function probeAgentModels(params: {
  bypassCache?: boolean;
  /** Admission reads the existing observation without starting native work. */
  currentOnly?: boolean;
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  registrySnapshot?: ResolvedContributionRegistry;
  runtimeCacheKey?: string;
  signal?: AbortSignal;
  deadlineSignal?: AbortSignal;
  cleanupScope?: PreflightCatalogCleanupScope;
  backendTarget?: BackendTargetRefV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  secretSources?: Parameters<typeof probeConfiguredAcpBackend>[0]['secretSources'];
  pluginSettings?: AgentCliSessionCommandPluginSettingsV1;
  credentials?: StoredCredentials | null;
  env?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionCacheKey?: string | null;
  profileCacheKey?: string | null;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
}): Promise<ProbedAgentModelsResult> {
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const modelConfig = resolveAgentModelConfigForLookupId(params.agentId);
  const configuredAcp = params.backendTarget?.kind === 'configuredAcpBackend';
  if (!configuredAcp && !isDynamicModelProbeEnabled({
    modelConfig,
    accountSettings: params.accountSettings ?? null,
    environment: params.env ?? process.env,
  })) {
    return { ...resolveStaticFallback(params.agentId), refreshError: false };
  }
  const nowMs = Date.now();
  const probeVariant = await resolveAgentProbeVariant({
    agentId: params.agentId,
    catalogEntry: params.catalogEntry,
    runtimeCacheKey: params.runtimeCacheKey,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
    runtimeKindOverride: params.runtimeKindOverride,
    probeKind: 'models',
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
    acpCatalogSnapshot: params.acpCatalogSnapshot,
    pluginSettings: params.pluginSettings,
    env: params.env,
  });
  const cacheKey = buildAgentProbeCacheKey({
    agentId: params.agentId,
    cwd,
    backendTarget: params.backendTarget,
    variant: probeVariant,
    connectedServiceSelection: params.connectedServiceSelectionCacheKey,
    profile: params.profileCacheKey,
    configOptionOverrides: params.configOptionOverrides,
  });

  const cached = agentModelsProbeCache.get(cacheKey);
  if (!params.bypassCache && cached?.kind === 'success' && agentModelsProbeCache.isFresh(cached, nowMs)) return cached.value;
  if (params.currentOnly) return cached?.kind === 'success'
    ? { ...cached.value, refreshError: true, cacheable: false }
    : buildUnavailable(params.agentId);

  return await agentModelsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModelsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (!params.bypassCache && cached2?.kind === 'success' && agentModelsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = configuredAcp
      ? buildUnavailable(params.agentId)
      : resolveDynamicProbeFailureFallback(params.agentId);
    let spawnFailure: SpawnFailure | undefined;
    const observeFailure = (error: unknown) => {
      if (error instanceof SpawnFailureError) spawnFailure = error.spawnFailure;
      return null;
    };
    const failedResult = (cold: ProbedAgentModelsResult, ttlMs = PROBE_MODELS_FAILURE_TTL_MS, catalogObserved = false): ProbedAgentModelsResult => {
      const lastGood = cached2?.kind === 'success' && cached2.value.source !== 'unavailable' ? cached2.value : null;
      // A successful setter can replace this scope's catalog before a later
      // setter fails. Its actual accepted observation outranks the older cache;
      // an ordinary failed refresh still retains the last good observation.
      // A native inventory refusal also replaces rows from an older auth route.
      const acceptedScopeObservation = params.configOptionOverrides
        && Object.keys(params.configOptionOverrides).length > 0 && cold.source === 'dynamic' && cold.observedAt !== undefined;
      const { spawnFailure: _previousFailure, refreshErrorMessage: _previousMessage, ...observation } = catalogObserved || acceptedScopeObservation ? cold : lastGood ?? cold;
      const result = { ...observation, refreshError: true, cacheable: false,
        ...(cold.refreshErrorMessage === undefined ? {} : { refreshErrorMessage: cold.refreshErrorMessage }),
        ...(spawnFailure ? { spawnFailure } : {}) };
      agentModelsProbeCache.setSuccess(cacheKey, result, { nowMs: Date.now(), ttlMs });
      return result;
    };
    if (shouldFailClosedForMissingCli(params)) {
      const unavailable = buildUnavailable(params.agentId);
      return failedResult(unavailable);
    }
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODELS_TIMEOUT_MS;

    try {
      const configuredAcpProbe = await probeConfiguredAcpBackend({
        agentId: params.agentId,
        backendTarget: params.backendTarget,
        cwd,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        acpCatalogSnapshot: params.acpCatalogSnapshot,
        savedSecretOperationContext: params.savedSecretOperationContext,
        machineAdmission: params.machineAdmission,
        secretSources: params.secretSources,
        processEnv: params.env,
        signal: params.signal,
        cleanupScope: params.cleanupScope,
        onBackend: async (backend) => {
          const controls = await probeAcpSessionControlsFromBackend({ backend, timeoutMs, signal: params.signal,
            configOptionOverrides: params.configOptionOverrides });
          return { models: normalizeAcpModelsSnapshot(controls.models, null), refreshError: controls.refreshError,
            refreshErrorMessage: controls.refreshErrorMessage, observedAt: controls.observedAt };
        },
      });
      if (configuredAcpProbe.kind === 'present') {
        const { models, refreshError, refreshErrorMessage, observedAt } = configuredAcpProbe.result;
        if (models) {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic',
            ...(observedAt === undefined ? refreshError ? {} : { observedAt: Date.now() } : { observedAt }) };
          if (refreshError) return failedResult({ ...res, ...(refreshErrorMessage === undefined ? {} : { refreshErrorMessage }) });
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
        return failedResult({ ...fallback, ...(refreshErrorMessage === undefined ? {} : { refreshErrorMessage }) });
      }

      const preflightModelsAdapter = await resolvePreflightSessionControlsProbeAdapter(params.agentId, params.catalogEntry);
      const probeModelsRaw = preflightModelsAdapter?.probeModelsRaw;
      if (probeModelsRaw) {
        let catalogObserved = false;
        let provenance: Partial<Pick<ProbedAgentModelsResult, 'observedAt' | 'refreshError' | 'refreshErrorMessage' | 'source' | 'spawnFailure'>> = {};
        const probePreflightModelsOnce = async (): Promise<ProbedAgentModel[] | null> => {
          provenance = {};
          catalogObserved = false;
          const modelsRaw = await withPreflightSessionControlsProbeEnvironment({
            modelConfig,
            registrySnapshot: params.registrySnapshot ?? readCurrentContributionRegistry(),
            catalogEntry: params.catalogEntry,
            agentId: params.agentId,
            processEnv: params.env ?? process.env,
            materializedEnv: params.materializedEnv,
          }, async ({ env }) => await probeModelsRaw({
            backendTarget: params.backendTarget,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.deadlineSignal ? { deadlineSignal: params.deadlineSignal } : {}),
            ...(params.cleanupScope ? { cleanupScope: params.cleanupScope } : {}),
            runtimeDescriptorV1: params.runtimeDescriptorV1,
            runtimeKindOverride: params.runtimeKindOverride,
            probeKind: 'models',
            bypassCache: params.bypassCache,
            cwd,
            timeoutMs,
            accountSettings: params.accountSettings ?? null,
            pluginSettings: params.pluginSettings,
            configOptionOverrides: params.configOptionOverrides,
            env,
          })).catch(observeFailure);
          const envelope = ProbeModelsObservationSchema.safeParse(modelsRaw);
          if (envelope.success) {
            catalogObserved = envelope.data.catalogObserved === true;
            spawnFailure = envelope.data.spawnFailure;
            provenance = {
              ...(envelope.data.observedAt !== undefined ? { observedAt: envelope.data.observedAt } : {}),
              ...(envelope.data.refreshError !== undefined ? { refreshError: envelope.data.refreshError } : {}),
              ...(envelope.data.refreshErrorMessage === undefined ? {} : { refreshErrorMessage: envelope.data.refreshErrorMessage }),
              ...(envelope.data.spawnFailure ? { spawnFailure: envelope.data.spawnFailure } : {}),
              ...(envelope.data.source ? { source: envelope.data.source } : {}),
            };
            return normalizePreflightDynamicModels(envelope.data.availableModels);
          }
          return normalizePreflightDynamicModels(modelsRaw);
        };

        const probeResult = await runPreflightSessionControlsProbe({
          adapter: preflightModelsAdapter,
          probeOnce: probePreflightModelsOnce,
        });
        const decision = resolveProviderOwnedPreflightControlsProbeDecision({
          probeResult,
          emptySuccess: 'success',
        });
        if (decision.kind === 'success') {
          if (provenance.refreshError || provenance.spawnFailure) {
            return failedResult({ ...fallback, availableModels: decision.value, source: 'dynamic', ...provenance }, PROBE_MODELS_FAILURE_TTL_MS, catalogObserved);
          }
          const res: ProbedAgentModelsResult = {
            ...fallback, availableModels: decision.value, source: 'dynamic',
            ...(provenance.source !== 'static' ? { observedAt: Date.now() } : {}),
            ...provenance,
          };
          agentModelsProbeCache.setSuccess(cacheKey, res, {
            nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS,
          });
          return res;
        }
        const res = buildUnavailable(params.agentId);
        return failedResult(res, preflightModelsAdapter.failureCacheStrategy === 'retry' ? 0 : PROBE_MODELS_FAILURE_TTL_MS);
      }

      return failedResult(fallback);
    } catch (error) {
      if (error instanceof AcpCatalogUnavailableError) throw error;
      observeFailure(error);
      return failedResult(fallback);
    }
  });
}

export async function probeAgentModelsBestEffort(
  params: Parameters<typeof probeAgentModels>[0],
): Promise<ProbedAgentModelsResult> {
  const result = await probeAgentModels(params);
  // Configured ACP targets have their own negotiated model evidence. They never
  // inherit the native Agent's prompted-JSON publication contract.
  if (params.backendTarget?.kind === 'configuredAcpBackend' || result.source === 'unavailable') return result;
  const formats = readAgentStructuredOutputCapabilities(
    (params.registrySnapshot ?? readAgentCatalogSnapshot()).agentDefinitionsById.get(params.agentId)?.richDefinition?.definition,
  )?.formats;
  return {
    ...result,
    availableModels: result.availableModels.map((model) => {
      const support = resolveModelStructuredOutputSupport({ model, catalogModel: true, agentFormats: formats });
      return support === 'unknown' && model.capabilities?.structuredOutput === undefined && model.id !== 'default'
        ? model
        : { ...model, capabilities: { ...model.capabilities, structuredOutput: support } };
    }),
  };
}
