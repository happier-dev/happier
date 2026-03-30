import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { killProcessTree } from '@/agent/acp/killProcessTree';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { getAgentModelConfig, getAgentStaticModels } from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';
import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
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
  modelOptions?: ReadonlyArray<ProbedAgentModelOption>;
}>;

export type ProbedAgentModelsResult = Readonly<{
  provider: CatalogAgentId;
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
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  modelOptions: z.array(z.unknown()).optional(),
});
const ProbeConfigOptionCandidateSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
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

        if (!line.startsWith('-') && !line.endsWith(':') && /^[a-z0-9._/:+-]+$/i.test(line)) {
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
  backend: AgentBackend;
  timeoutMs: number;
}): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  type ProbeModelsBackend = AgentBackend & Partial<{
    getSessionModelState: () => { availableModels?: unknown } | null;
    getSessionConfigOptionsState: () => unknown;
  }>;

  const backend: ProbeModelsBackend = params.backend;

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
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
}): Promise<ProbedAgentModelsResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const probeVariant = resolveAgentProbeVariant({
    agentId: params.agentId,
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
    const modelConfig = getAgentModelConfig(params.agentId);
    if (modelConfig.dynamicProbe === 'static-only') {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
      return fallback;
    }
    const entry = AGENTS[params.agentId];

    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODELS_TIMEOUT_MS;

    let configuredBackend: AgentBackend | null = null;
    try {
      configuredBackend = await createConfiguredAcpProbeBackend({
        agentId: params.agentId,
        backendTarget: params.backendTarget,
        cwd,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
      });
      if (configuredBackend) {
        const models = await probeModelsFromAcpBackend({ backend: configuredBackend, timeoutMs }).catch(() => null);
        if (models) {
          const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
          agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
          return res;
        }
        agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      }
    } catch {
      agentModelsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
      return fallback;
    } finally {
      if (configuredBackend) {
        await configuredBackend.dispose().catch(() => {});
      }
    }

    const preflightModelsAdapter = entry?.getPreflightSessionControlsProbeAdapter
      ? await entry.getPreflightSessionControlsProbeAdapter().catch(() => null)
      : null;
    if (preflightModelsAdapter?.probeModelsRaw) {
      const probePreflightModelsOnce = async (): Promise<ProbedAgentModel[] | null> => {
        const modelsRaw = await preflightModelsAdapter.probeModelsRaw!({
          backendTarget: params.backendTarget,
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
        }).catch(() => null);
        return normalizeDynamicModels(modelsRaw);
      };

      let models = await probePreflightModelsOnce();
      // If the provider marks the preflight probe as authoritative, retry once immediately to
      // avoid sticky "static fallback" UI states that require an explicit user refresh.
      if (!models && preflightModelsAdapter.failureCacheStrategy === 'retry') {
        models = await probePreflightModelsOnce();
      }
      if (models) {
        const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
        agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
        return res;
      }
      if (preflightModelsAdapter.failureCacheStrategy === 'retry') {
        // For providers where this probe is the primary/authoritative source (e.g. Codex app-server),
        // cache an error so subsequent calls retry instead of freezing the static fallback.
        agentModelsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODELS_FAILURE_TTL_MS });
        return fallback;
      }
    }

    // Prefer lightweight CLI preflight probes when the provider offers a `models` command.
    // This avoids needing to start a full ACP session just to populate a menu.
    const cliProbeArgs = preflightModelsAdapter?.cliModelsCommandArgs ?? null;
    if (Array.isArray(cliProbeArgs) && cliProbeArgs.length > 0) {
      const command =
        resolveProviderCliCommand(params.agentId)?.command
        ?? resolveCliPathOverride({ agentId: params.agentId })
        ?? params.agentId;
      const models = await probeModelsFromCliModelsCommand({ command, args: cliProbeArgs, cwd, timeoutMs }).catch(() => null);
      if (models) {
        const res: ProbedAgentModelsResult = { ...fallback, availableModels: models, source: 'dynamic' };
        agentModelsProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODELS_SUCCESS_TTL_MS });
        return res;
      }
    }

    if (!entry?.getAcpBackendFactory) {
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

    let backend: AgentBackend | null = null;
    try {
      const created = await createCatalogAcpBackend<any>(params.agentId, {
        cwd,
        env: {},
        mcpServers: {},
        permissionHandler,
        permissionMode: 'default',
      });
      backend = created.backend;

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
  });
}
