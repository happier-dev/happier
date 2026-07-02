import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { hasCatalogAcpBackendOwner } from '@/agent/acp/catalog/owner';
import { resolveCliPathOverride } from '@/agent/runtime/cli/resolveCliPathOverride';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentLookupId } from '@/backends/types';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { resolveProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import {
  getAgentModelConfig,
  getAgentStaticModels,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { probeConfiguredAcpBackend } from './probeConfiguredAcpBackend';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { spawn } from 'node:child_process';
import { z } from 'zod';

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
  modelOptions?: ReadonlyArray<ProbedAgentModelOption>;
}>;

export type ProbedAgentModelsResult = Readonly<{
  provider: CatalogAgentLookupId;
  availableModels: ReadonlyArray<ProbedAgentModel>;
  supportsFreeform: boolean;
  source: 'dynamic' | 'static';
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
  id: ProbeNonEmptyStringSchema.optional(),
  modelId: ProbeNonEmptyStringSchema.optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
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

function resolveAgentModelConfigForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentModelConfig(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentModelConfig();
  }
  throw new Error(`Unsupported agent model lookup id '${agentId}'`);
}

function resolveAgentStaticModelsForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentStaticModels(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return [] as const;
  }
  throw new Error(`Unsupported agent static model lookup id '${agentId}'`);
}

function buildStatic(agentId: CatalogAgentLookupId): ProbedAgentModelsResult {
  const cfg = resolveAgentModelConfigForLookupId(agentId);
  const supportsFreeform = cfg.supportsSelection === true && cfg.supportsFreeform === true;
  const seen = new Set<string>();
  const availableModels = (cfg.supportsSelection === true
    ? [
      { id: 'default', name: 'Default' },
      ...resolveAgentStaticModelsForLookupId(agentId).map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
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

  const id = parsed.data.id ?? parsed.data.modelId;
  if (!id) return null;

  const normalizedOptions = parsed.data.modelOptions
    ?.map((option) => normalizeProbeModelOption(option))
    .filter((option): option is NonNullable<typeof option> => option !== null);

  return {
    id,
    name: parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
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

async function probeModelsFromCliModelsCommand(params: {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  timeoutMs: number;
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
      env: { ...process.env, CI: '1' },
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

      const parsed = parseCliModelsOutput(stdout);
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
  credentials?: Credentials | null;
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
  });

  const cached = agentModelsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentModelsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentModelsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModelsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentModelsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    const modelConfig = resolveAgentModelConfigForLookupId(params.agentId);
    if (modelConfig.dynamicProbe === 'static-only') {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
      return fallback;
    }
    const entry = AGENTS[params.agentId];
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
          const modelsRaw = await probeModelsRaw({
            backendTarget: params.backendTarget,
            probeKind: 'models',
            cwd,
            timeoutMs,
            accountSettings: params.accountSettings ?? null,
          }).catch(() => null);
          return normalizeDynamicModels(modelsRaw);
        };

        const probeResult = await runPreflightSessionControlsProbe({
          adapter: preflightModelsAdapter,
          probeOnce: probePreflightModelsOnce,
        });
        if (probeResult.kind === 'success') {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: probeResult.value, source: 'dynamic' };
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
        if (probeResult.kind === 'retryable_failure') {
          // For providers where this probe is the primary/authoritative source (e.g. Codex app-server),
          // cache an error so subsequent calls retry instead of freezing the static fallback.
          agentModelsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
          return fallback;
        }
      }

      // Prefer lightweight CLI preflight probes when the provider offers a `models` command.
      // This avoids needing to start a full ACP session just to populate a menu.
      const cliProbeArgs = preflightModelsAdapter?.cliModelsCommandArgs;
      if (Array.isArray(cliProbeArgs) && cliProbeArgs.length > 0) {
        const launch = resolveProviderCliLaunchSpec(params.agentId);
        const models = launch
          ? await probeModelsFromCliModelsCommand({
            command: launch.command,
            args: [...launch.args, ...cliProbeArgs],
            cwd,
            timeoutMs,
          }).catch(() => null)
          : null;
        if (models) {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
      }

      if (!hasCatalogAcpBackendOwner(entry)) {
        agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      }

      const spawnValidation = await validateCatalogAcpProbeSpawn(params.agentId);
      if (!spawnValidation.ok) {
        agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      }

      const permissionHandler: AcpPermissionHandler = {
        handleToolCall: async () => ({ decision: 'abort' }),
      };

      let backend: AcpProbeBackend | null = null;
      try {
        const probeBackendOptions = entry.resolveModelsProbeBackendOptions?.({
          backendTarget: params.backendTarget,
          accountSettings: params.accountSettings,
        }) ?? {};
        const created = await createCatalogAcpBackend<any>(params.agentId, {
          cwd,
          env: {},
          mcpServers: {},
          permissionHandler,
          permissionMode: 'default',
          ...probeBackendOptions,
        });
        backend = created.backend;
        if (!backend) {
          agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
          return fallback;
        }

        const models = await probeModelsFromAcpBackend({ backend, timeoutMs }).catch(() => null);
        if (!models) {
          agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
          return fallback;
        }

        const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
        agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
        return res;
      } catch {
        agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      } finally {
        if (backend) {
          await backend.dispose().catch(() => {});
        }
      }
    } catch {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
      return fallback;
    }
  });
}
