import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { getAgentModelConfig } from '@happier-dev/agents';
import { AsyncTtlCache } from '@happier-dev/protocol';
import { spawn } from 'node:child_process';

export type ProbedAgentModel = Readonly<{ id: string; name: string; description?: string }>;

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

function buildAgentModelsProbeCacheKey(agentId: CatalogAgentId, cwd: string): string {
  const normalizedCwd = String(cwd ?? '').trim();
  return `${agentId}:${normalizedCwd}`;
}

function buildStatic(agentId: CatalogAgentId): ProbedAgentModelsResult {
  const cfg = getAgentModelConfig(agentId);
  const supportsFreeform = cfg.supportsSelection === true && cfg.supportsFreeform === true;
  const allowedModes = cfg.supportsSelection === true && Array.isArray(cfg.allowedModes) ? cfg.allowedModes : [];
  const allowed = cfg.supportsSelection === true ? ['default', ...allowedModes] : ['default'];
  const unique = Array.from(new Set(allowed));
  return {
    provider: agentId,
    availableModels: unique.map((id) => ({ id, name: id === 'default' ? 'Default' : id })),
    supportsFreeform,
    source: 'static',
  };
}

function normalizeDynamicModels(modelsRaw: unknown): ProbedAgentModel[] | null {
  if (!Array.isArray(modelsRaw)) return null;
  const parsed = modelsRaw
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const id = typeof (m as any).id === 'string' ? String((m as any).id).trim() : '';
      const name = typeof (m as any).name === 'string' ? String((m as any).name).trim() : '';
      const description = typeof (m as any).description === 'string' ? String((m as any).description) : undefined;
      if (!id || !name) return null;
      return { id, name, ...(description ? { description } : {}) } satisfies ProbedAgentModel;
    })
    .filter(Boolean) as ProbedAgentModel[];

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

  return await new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const finish = (result: ReadonlyArray<ProbedAgentModel> | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(params.command, [...params.args], {
      cwd: params.cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
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

  const configOptions = configOptionsRaw.filter((c) => c && typeof c === 'object' && !Array.isArray(c)) as any[];
  if (configOptions.length === 0) return null;

  const candidate =
    configOptions.find((c) => typeof c.id === 'string' && String(c.id).trim().toLowerCase() === 'model') ??
    configOptions.find((c) => typeof c.name === 'string' && String(c.name).trim().toLowerCase() === 'model') ??
    null;
  if (!candidate) return null;

  const optionsRaw = Array.isArray(candidate.options) ? candidate.options : null;
  if (!optionsRaw) return null;

  const parsed = optionsRaw
    .map((opt: unknown) => {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null;
      const id = typeof (opt as any).value === 'string' ? String((opt as any).value).trim() : '';
      const name = typeof (opt as any).name === 'string' ? String((opt as any).name).trim() : '';
      const description = typeof (opt as any).description === 'string' ? String((opt as any).description) : undefined;
      if (!id || !name) return null;
      return { id, name, ...(description ? { description } : {}) } satisfies ProbedAgentModel;
    })
    .filter(Boolean) as ProbedAgentModel[];

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
  const backendAny = params.backend as any;
  if (typeof backendAny.startSession !== 'function') return null;

  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  await Promise.race([backendAny.startSession(), timeoutPromise]).finally(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  });

  if (typeof backendAny.getSessionModelState === 'function') {
    const state = backendAny.getSessionModelState();
    const modelsRaw = state?.availableModels;
    const models = normalizeDynamicModels(modelsRaw);
    if (models) return models;
  }

  if (typeof backendAny.getSessionConfigOptionsState === 'function') {
    const configOptions = backendAny.getSessionConfigOptionsState();
    const models = normalizeModelsFromConfigOptions(configOptions);
    if (models) return models;
  }

  return null;
}

export async function probeAgentModelsBestEffort(params: {
  agentId: CatalogAgentId;
  cwd: string;
  timeoutMs?: number;
}): Promise<ProbedAgentModelsResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const cacheKey = buildAgentModelsProbeCacheKey(params.agentId, cwd);

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

    // Prefer lightweight CLI preflight probes when the provider offers a `models` command.
    // This avoids needing to start a full ACP session just to populate a menu.
    const cliProbeArgsByAgent: Partial<Record<CatalogAgentId, ReadonlyArray<string>>> = {
      opencode: ['models'],
      kilo: ['models'],
      auggie: ['model', 'list'],
    };
    const cliProbeArgs = cliProbeArgsByAgent[params.agentId];
    if (Array.isArray(cliProbeArgs) && cliProbeArgs.length > 0) {
      const command = resolveCliPathOverride({ agentId: params.agentId }) ?? params.agentId;
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
      const disposable = backend as any;
      if (disposable && typeof disposable.dispose === 'function') {
        await disposable.dispose().catch(() => {});
      }
    }
  });
}
