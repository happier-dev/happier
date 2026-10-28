import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { resolveAcpModelConfigOption, normalizeAcpConfigOptionChoices } from '@/agent/acp/configOptionChoiceNormalization';
import type { AgentBackend } from '@/agent/core';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { getAgentModelConfig, getAgentStaticModels } from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';
import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { normalizeContextWindowTokens } from '@/backends/modelCapabilities/contextWindowTokens';
import { applyObservedAcpModelOptions, isAcpModelScopedConfigOption } from '@/agent/acp/runtime/sessionModelsState';

type ProbedAgentModelOptionValue = string | number | boolean | null;

type ProbedAgentModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: ProbedAgentModelOptionValue;
  options?: ReadonlyArray<Readonly<{
    value: ProbedAgentModelOptionValue;
    name: string;
    description?: string;
  }>>;
}>;

export type ProbedAgentModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  extendedContextModelId?: string;
  modelOptions?: ReadonlyArray<ProbedAgentModelOption>;
}>;

export type ProbedAgentModelsResult = Readonly<{
  provider: CatalogAgentId;
  availableModels: ReadonlyArray<ProbedAgentModel>;
  supportsFreeform: boolean;
  source: 'dynamic' | 'static';
  cacheable?: boolean;
  observedAt?: number;
  refreshError?: boolean;
}>;

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 15_000;
const PROBE_MODELS_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_MODELS_FAILURE_TTL_MS = 60_000;
const agentModelsProbeCache = new AsyncTtlCache<ProbedAgentModelsResult>({
  successTtlMs: PROBE_MODELS_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_MODELS_FAILURE_TTL_MS,
});

const ProbeModelsObservationSchema = z.object({
  availableModels: z.array(z.unknown()),
  observedAt: z.number().finite().nonnegative().optional(),
  refreshError: z.boolean().optional(),
  source: z.enum(['dynamic', 'static']).optional(),
});
const ProbeNonEmptyStringSchema = z.string().trim().min(1);
const ProbeDescriptionSchema = z.string();
const ProbeOptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ProbeModelOptionChoiceInputSchema = z.object({
  value: z.unknown().optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});
const ProbeModelOptionInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  type: ProbeNonEmptyStringSchema,
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).optional(),
});
const ProbeDynamicModelInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  contextWindowTokens: z.unknown().optional(),
  extendedContextModelId: ProbeNonEmptyStringSchema.optional(),
  modelOptions: z.array(z.unknown()).optional(),
});
const ProbeConfigOptionCandidateSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).optional(),
});

export function resetAgentModelsProbeCacheForTests(): void {
  agentModelsProbeCache.clear();
}

function buildStatic(agentId: CatalogAgentId): ProbedAgentModelsResult {
  const cfg = getAgentModelConfig(agentId);
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
    provider: agentId,
    availableModels,
    supportsFreeform,
    source: 'static',
  };
}

function normalizeProbeOptionValue(value: unknown): ProbedAgentModelOptionValue {
  const parsed = ProbeOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeProbeModelOptionChoice(choiceRaw: unknown): NonNullable<ProbedAgentModelOption['options']>[number] | null {
  const parsed = ProbeModelOptionChoiceInputSchema.safeParse(choiceRaw);
  if (!parsed.success) return null;

  const { value, name, description } = parsed.data;
  return {
    value: normalizeProbeOptionValue(value),
    name,
    ...(description ? { description } : {}),
  };
}

function normalizeProbeModelOption(optionRaw: unknown): ProbedAgentModelOption | null {
  const parsed = ProbeModelOptionInputSchema.safeParse(optionRaw);
  if (!parsed.success) return null;

  const normalizedChoices = parsed.data.options
    ?.map((choice) => normalizeProbeModelOptionChoice(choice))
    .filter((choice): choice is NonNullable<typeof choice> => choice !== null);

  return {
    id: parsed.data.id,
    name: parsed.data.name,
    type: parsed.data.type,
    currentValue: normalizeProbeOptionValue(parsed.data.currentValue),
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(normalizedChoices && normalizedChoices.length > 0 ? { options: normalizedChoices } : {}),
  };
}

function normalizeProbeModel(modelRaw: unknown): ProbedAgentModel | null {
  const parsed = ProbeDynamicModelInputSchema.safeParse(modelRaw);
  if (!parsed.success) return null;

  const normalizedOptions = parsed.data.modelOptions
    ?.map((option) => normalizeProbeModelOption(option))
    .filter((option): option is NonNullable<typeof option> => option !== null);

  return {
    id: parsed.data.id,
    name: parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.extendedContextModelId
      ? { extendedContextModelId: parsed.data.extendedContextModelId }
      : {}),
    ...(normalizeContextWindowTokens(parsed.data.contextWindowTokens) !== undefined
      ? { contextWindowTokens: normalizeContextWindowTokens(parsed.data.contextWindowTokens) }
      : {}),
    ...(normalizedOptions && normalizedOptions.length > 0 ? { modelOptions: normalizedOptions } : {}),
  };
}

function normalizeDynamicModels(modelsRaw: unknown): ProbedAgentModel[] | null {
  if (!Array.isArray(modelsRaw)) return null;
  // `null` is the adapter's failure signal. An actual empty array is a successful observation
  // with no provider-listed rows, so preserve that distinction and suppress stale static
  // membership while retaining Happier's explicit provider-default choice.
  if (modelsRaw.length === 0) return [{ id: 'default', name: 'Default' }];
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

async function probeModelsFromCliModelsCommand(params: {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  timeoutMs: number;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  const timeoutMs = Math.max(250, params.timeoutMs);
  const stdoutMaxBytes = 256 * 1024;

  return await new Promise((resolve) => {
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;

    const finish = (result: ReadonlyArray<ProbedAgentModel> | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const invocation = resolveWindowsCommandInvocation({
      command: params.command,
      args: params.args,
      resolveCommandOnPath: true,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...(params.processEnv ?? process.env), CI: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
      } else {
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutMaxBytes) {
          clearTimeout(timer);
          if (process.platform === 'win32') {
            void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
          } else {
            try { child.kill('SIGKILL'); } catch { /* best-effort */ }
          }
          finish(null);
          return;
        }
        stdout += chunk.toString('utf8');
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);

      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const parsed: ProbedAgentModel[] = [];
      for (const line of lines) {
        if (line.toLowerCase() === 'available models:' || line.toLowerCase() === 'available models') {
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

        const hyphen = line.match(/^([a-z0-9._/:+~][a-z0-9._/:+~-]*)\s+-\s+(.+?)\s*$/i);
        if (hyphen) {
          const id = String(hyphen[1] ?? '').trim();
          const name = String(hyphen[2] ?? '')
            .replace(/(?:\s*\((?:current|default)\))+$/iu, '')
            .trim();
          if (id && name) {
            parsed.push({ id, name });
          }
          continue;
        }

        if (!line.startsWith('-') && !line.endsWith(':') && /^[a-z0-9._/:+~-]+$/i.test(line)) {
          parsed.push({ id: line, name: line });
        }
      }

      if (parsed.length === 0) return finish(null);

      const models: ProbedAgentModel[] = [{ id: 'default', name: 'Default' }, ...parsed.filter((m) => m.id !== 'default')];

      const seen = new Set<string>();
      finish(
        models.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }),
      );
    });
  });
}

function normalizeProbeConfigOptions(configOptionsRaw: unknown[]) {
  return configOptionsRaw
    .map((option) => ProbeConfigOptionCandidateSchema.safeParse(option))
    .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success)
    .map((parsed) => parsed.data);
}

function normalizeModelsFromConfigOptions(configOptionsRaw: unknown, modelConfigOptionId?: string | null): ProbedAgentModel[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const configOptions = normalizeProbeConfigOptions(configOptionsRaw);
  if (configOptions.length === 0) return null;

  const candidate = resolveAcpModelConfigOption(configOptions, modelConfigOptionId);
  if (!candidate) return null;

  const optionsRaw = candidate.options ?? null;
  if (!optionsRaw) return null;

  const parsed = normalizeAcpConfigOptionChoices(optionsRaw, (value) => {
    const id = ProbeNonEmptyStringSchema.safeParse(value);
    return id.success ? id.data : null;
  }).map((choice) => ({
    id: choice.value,
    name: choice.name,
    ...(choice.description ? { description: choice.description } : {}),
  } satisfies ProbedAgentModel));

  if (optionsRaw.length > 0 && parsed.length === 0) return null;

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

function attachObservedModelOptions(
  models: ProbedAgentModel[],
  configOptionsRaw: unknown,
  currentModelId?: unknown,
  modelConfigOptionId?: string | null,
): ProbedAgentModel[] {
  if (!Array.isArray(configOptionsRaw)) return models;
  const configOptions = normalizeProbeConfigOptions(configOptionsRaw);
  const selector = resolveAcpModelConfigOption(configOptions, modelConfigOptionId);
  const observedModelId = typeof currentModelId === 'string'
    ? currentModelId
    : selector?.currentValue;
  const observedOptions = configOptions
    .filter((option) => option !== selector && isAcpModelScopedConfigOption(option))
    .map(normalizeProbeModelOption)
    .filter((option): option is ProbedAgentModelOption => option !== null);
  return applyObservedAcpModelOptions(models, observedModelId, observedOptions);
}

export async function probeModelsFromAcpBackend(params: {
  backend: AgentBackend;
  timeoutMs: number;
  modelConfigOptionId?: string | null;
}): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  type ProbeModelsBackend = AgentBackend & Partial<{
    getSessionModelState: () => { currentModelId?: unknown; availableModels?: unknown } | null;
    getSessionConfigOptionsState: () => unknown;
    /** Resolve false on failed discovery; a ready empty list is still a successful observation. */
    waitForSessionModels: () => Promise<boolean>;
  }>;

  const backend: ProbeModelsBackend = params.backend;

  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const modelsReady = await Promise.race([(async () => {
    await backend.startSession();
    // Session opening may deliberately return before optional model discovery. Both phases
    // consume this probe's existing deadline rather than granting discovery another timeout.
    return await backend.waitForSessionModels?.() ?? true;
  })(), timeoutPromise]).finally(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  });
  if (!modelsReady) return null;

  const configOptions = backend.getSessionConfigOptionsState?.();
  if (typeof backend.getSessionModelState === 'function') {
    const state = backend.getSessionModelState();
    const modelsRaw = state?.availableModels;
    const models = normalizeDynamicModels(modelsRaw);
    if (models) return attachObservedModelOptions(models, configOptions, state?.currentModelId, params.modelConfigOptionId);
  }

  if (typeof backend.getSessionConfigOptionsState === 'function') {
    const models = normalizeModelsFromConfigOptions(configOptions, params.modelConfigOptionId);
    if (models) return attachObservedModelOptions(models, configOptions, undefined, params.modelConfigOptionId);
  }

  return null;
}

export async function probeAgentModelsBestEffort(params: {
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  profileId?: string | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  processEnv?: NodeJS.ProcessEnv;
  connectedServiceSelectionCacheKey?: string | null;
  bypassCache?: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
  onNativeCleanup?: import('./catalogProbeLifecycle').RegisterNativeCatalogCleanup;
}): Promise<ProbedAgentModelsResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const profileId = typeof params.profileId === 'string' && params.profileId.trim().length > 0
    ? params.profileId.trim()
    : null;
  const baseProbeVariant = resolveAgentProbeVariant({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
    connectedServices: params.connectedServices ?? null,
    processEnv: params.processEnv,
  });
  const probeVariant = params.connectedServiceSelectionCacheKey
    ? `${baseProbeVariant}|connected:${params.connectedServiceSelectionCacheKey}`
    : baseProbeVariant;
  const cacheKey = buildAgentProbeCacheKey({
    agentId: params.agentId,
    cwd,
    backendTarget: params.backendTarget,
    variant: profileId ? `${probeVariant}|profile:${profileId}` : probeVariant,
  });
  const entry = AGENTS[params.agentId];
  const preflightModelsAdapter = entry?.getPreflightSessionControlsProbeAdapter
    ? await entry.getPreflightSessionControlsProbeAdapter().catch(() => null)
    : null;
  const usesProviderOwnedCache = preflightModelsAdapter?.modelProbeCachePolicy === 'provider-owned';

  const cached = agentModelsProbeCache.get(cacheKey);
  if (!params.bypassCache && !usesProviderOwnedCache && cached?.kind === 'success' && agentModelsProbeCache.isFresh(cached, nowMs)) return cached.value;

  const runProbe = async (): Promise<ProbedAgentModelsResult> => {
    params.signal?.throwIfAborted();
    const cached2 = agentModelsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (!params.bypassCache && !usesProviderOwnedCache && cached2?.kind === 'success' && agentModelsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    const failedResult = (): ProbedAgentModelsResult => {
      const lastGood = cached2?.kind === 'success' && cached2.value.source === 'dynamic' ? cached2.value : fallback;
      const result: ProbedAgentModelsResult = { ...lastGood, refreshError: true, cacheable: false };
      if (!usesProviderOwnedCache) {
        agentModelsProbeCache.setSuccess(cacheKey, result, {
          ttlMs: preflightModelsAdapter?.failureCacheStrategy === 'retry' ? 0 : PROBE_MODELS_FAILURE_TTL_MS,
        });
      }
      return result;
    };
    const modelConfig = getAgentModelConfig(params.agentId);
    if (modelConfig.dynamicProbe === 'static-only') {
      if (!usesProviderOwnedCache) {
        agentModelsProbeCache.setSuccess(cacheKey, { ...fallback, refreshError: false }, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
      }
      return { ...fallback, refreshError: false };
    }

    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODELS_TIMEOUT_MS;

    let configuredBackend: AgentBackend | null = null;
    try {
      configuredBackend = await createConfiguredAcpProbeBackend({
        agentId: params.agentId,
        backendTarget: params.backendTarget,
        cwd,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        processEnv: params.processEnv,
      });
      if (configuredBackend) {
        const ownedBackend = configuredBackend;
        params.onNativeCleanup?.(() => ownedBackend.dispose());
        params.signal?.throwIfAborted();
        const models = await probeModelsFromAcpBackend({ backend: configuredBackend, timeoutMs, modelConfigOptionId: modelConfig.acpModelConfigOptionId }).catch(() => null);
        if (models) {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic', observedAt: Date.now() };
          if (!usesProviderOwnedCache) {
            agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          }
          return res;
        }
        return failedResult();
      }
    } catch {
      return failedResult();
    } finally {
      if (configuredBackend) {
        await configuredBackend.dispose().catch(() => {});
      }
    }

    if (preflightModelsAdapter?.probeModelsRaw) {
      let provenance: { observedAt?: number; refreshError?: boolean; source?: 'dynamic' | 'static' } = {};
      const probePreflightModelsOnce = async (): Promise<ProbedAgentModel[] | null> => {
        const modelsRaw = await preflightModelsAdapter.probeModelsRaw!({
          backendTarget: params.backendTarget,
          bypassCache: params.bypassCache,
          cwd,
          timeoutMs,
          deadlineAt: params.deadlineAt,
          signal: params.signal,
          onNativeCleanup: params.onNativeCleanup,
          profileId,
          accountSettings: params.accountSettings ?? null,
          credentials: params.credentials ?? null,
          connectedServices: params.connectedServices ?? null,
          processEnv: params.processEnv,
        }).catch(() => null);
        const envelope = ProbeModelsObservationSchema.safeParse(modelsRaw);
        if (envelope.success) {
          provenance = {
            ...(envelope.data.observedAt !== undefined ? { observedAt: envelope.data.observedAt } : {}),
            ...(envelope.data.refreshError !== undefined ? { refreshError: envelope.data.refreshError } : {}),
            ...(envelope.data.source ? { source: envelope.data.source } : {}),
          };
          return normalizeDynamicModels(envelope.data.availableModels);
        }
        return normalizeDynamicModels(modelsRaw);
      };

      let models = await probePreflightModelsOnce();
      // If the provider marks the preflight probe as authoritative, retry once immediately to
      // avoid sticky "static fallback" UI states that require an explicit user refresh.
      if (!models && preflightModelsAdapter.failureCacheStrategy === 'retry') {
        models = await probePreflightModelsOnce();
      }
      if (models) {
        if (provenance.source === 'static' && provenance.refreshError
          && cached2?.kind === 'success' && cached2.value.source === 'dynamic') {
          return failedResult();
        }
        const res: ProbedAgentModelsResult = {
          ...fallback, availableModels: models, source: 'dynamic',
          ...(provenance.source !== 'static' ? { observedAt: Date.now() } : {}),
          ...provenance,
          ...(provenance.refreshError ? { cacheable: false } : {}),
        };
        if (!usesProviderOwnedCache) {
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: provenance.refreshError ? PROBE_MODELS_FAILURE_TTL_MS : PROBE_MODELS_SUCCESS_TTL_MS });
        }
        return res;
      }
      // A raw hook owns the provider's complete discovery and any runtime-specific
      // fallback. Failure must not silently start a second catalog observation.
      return failedResult();
    }

    // Prefer lightweight CLI preflight probes when the provider offers a `models` command.
    // This avoids needing to start a full ACP session just to populate a menu.
    const cliProbeArgs = preflightModelsAdapter?.cliModelsCommandArgs ?? null;
    if (Array.isArray(cliProbeArgs) && cliProbeArgs.length > 0) {
      const command =
        resolveProviderCliCommand(params.agentId, { processEnv: params.processEnv ?? process.env })?.command
        ?? resolveCliPathOverride({ agentId: params.agentId })
        ?? params.agentId;
      const models = await probeModelsFromCliModelsCommand({
        command,
        args: cliProbeArgs,
        cwd,
        timeoutMs,
        processEnv: params.processEnv,
      }).catch(() => null);
      if (models) {
        const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic', observedAt: Date.now() };
        if (!usesProviderOwnedCache) {
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
        }
        return res;
      }
    }

    if (!entry?.getAcpBackendFactory) {
      return failedResult();
    }

    const spawnValidation = await validateCatalogAcpProbeSpawn(params.agentId, { processEnv: params.processEnv, cwd });
    if (!spawnValidation.ok) {
      return failedResult();
    }

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'abort' }),
    };

    let backend: AgentBackend | null = null;
    try {
      const probeBackendOptions = entry.resolveModelsProbeBackendOptions?.({
        backendTarget: params.backendTarget,
        accountSettings: params.accountSettings,
        processEnv: params.processEnv,
      }) ?? {};
      const created = await createCatalogAcpBackend<any>(params.agentId, {
        cwd,
        env: params.processEnv ?? process.env,
        mcpServers: {},
        permissionHandler,
        permissionMode: 'default',
        ...probeBackendOptions,
        readinessOnly: true,
      });
      backend = created.backend;
      const ownedBackend = backend;
      params.onNativeCleanup?.(() => ownedBackend.dispose());
      params.signal?.throwIfAborted();

      const models = await probeModelsFromAcpBackend({ backend, timeoutMs, modelConfigOptionId: modelConfig.acpModelConfigOptionId }).catch(() => null);
      if (!models) {
        return failedResult();
      }

      const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic', observedAt: Date.now() };
      if (!usesProviderOwnedCache) {
        agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
      }
      return res;
    } catch {
      return failedResult();
    } finally {
      if (backend) {
        await backend.dispose().catch(() => {});
      }
    }
  };

  const result = usesProviderOwnedCache || params.signal
    ? await runProbe()
    : await agentModelsProbeCache.runDedupe(cacheKey, runProbe);
  return usesProviderOwnedCache ? { ...result, cacheable: false } : result;
}
