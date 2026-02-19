import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { getAgentSessionModesKind } from '@happier-dev/agents';
import { AsyncTtlCache } from '@happier-dev/protocol';

export type ProbedAgentMode = Readonly<{ id: string; name: string; description?: string }>;

export type ProbedAgentModesResult = Readonly<{
  provider: CatalogAgentId;
  availableModes: ReadonlyArray<ProbedAgentMode>;
  source: 'dynamic' | 'static';
}>;

const DEFAULT_PROBE_MODES_TIMEOUT_MS = 15_000;
const PROBE_MODES_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_MODES_FAILURE_TTL_MS = 60_000;

const agentModesProbeCache = new AsyncTtlCache<ProbedAgentModesResult>({
  successTtlMs: PROBE_MODES_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_MODES_FAILURE_TTL_MS,
});

function buildAgentModesProbeCacheKey(agentId: CatalogAgentId, cwd: string): string {
  const normalizedCwd = String(cwd ?? '').trim();
  return `${agentId}:${normalizedCwd}`;
}

function buildStatic(agentId: CatalogAgentId): ProbedAgentModesResult {
  return { provider: agentId, availableModes: [], source: 'static' };
}

function normalizeDynamicModes(modesRaw: unknown): ProbedAgentMode[] | null {
  if (!Array.isArray(modesRaw)) return null;
  const parsed = modesRaw
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const id = typeof (m as any).id === 'string' ? String((m as any).id).trim() : '';
      const name = typeof (m as any).name === 'string' ? String((m as any).name).trim() : '';
      const description = typeof (m as any).description === 'string' ? String((m as any).description) : undefined;
      if (!id || !name) return null;
      return { id, name, ...(description ? { description } : {}) } satisfies ProbedAgentMode;
    })
    .filter(Boolean) as ProbedAgentMode[];

  if (parsed.length === 0) return null;

  const seen = new Set<string>();
  return parsed.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function normalizeModesFromConfigOptions(configOptionsRaw: unknown): ProbedAgentMode[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const configOptions = configOptionsRaw.filter((c) => c && typeof c === 'object' && !Array.isArray(c)) as any[];
  if (configOptions.length === 0) return null;

  const candidate =
    configOptions.find((c) => typeof c.id === 'string' && String(c.id).trim().toLowerCase() === 'mode') ??
    configOptions.find((c) => typeof c.name === 'string' && String(c.name).trim().toLowerCase() === 'mode') ??
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
      return { id, name, ...(description ? { description } : {}) } satisfies ProbedAgentMode;
    })
    .filter(Boolean) as ProbedAgentMode[];

  if (parsed.length === 0) return null;

  const seen = new Set<string>();
  return parsed.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export async function probeModesFromAcpBackend(params: {
  backend: AgentBackend;
  timeoutMs: number;
}): Promise<ReadonlyArray<ProbedAgentMode> | null> {
  const backendAny = params.backend as any;
  if (typeof backendAny.startSession !== 'function') return null;

  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  await Promise.race([backendAny.startSession(), timeoutPromise]).finally(() => {
    if (timerId !== null) clearTimeout(timerId);
  });

  if (typeof backendAny.getSessionModeState === 'function') {
    const state = backendAny.getSessionModeState();
    const modesRaw = state?.availableModes;
    const modes = normalizeDynamicModes(modesRaw);
    if (modes) return modes;
  }

  if (typeof backendAny.getSessionConfigOptionsState === 'function') {
    const configOptions = backendAny.getSessionConfigOptionsState();
    const modes = normalizeModesFromConfigOptions(configOptions);
    if (modes) return modes;
  }

  return null;
}

export async function probeAgentModesBestEffort(params: {
  agentId: CatalogAgentId;
  cwd: string;
  timeoutMs?: number;
}): Promise<ProbedAgentModesResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const cacheKey = buildAgentModesProbeCacheKey(params.agentId, cwd);

  const cached = agentModesProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentModesProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentModesProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModesProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentModesProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    if (getAgentSessionModesKind(params.agentId as any) !== 'acpAgentModes') {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
      return fallback;
    }

    const entry = AGENTS[params.agentId];
    if (!entry?.getAcpBackendFactory) {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    }

    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODES_TIMEOUT_MS;

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

      const modes = await probeModesFromAcpBackend({ backend, timeoutMs }).catch(() => null);
      if (!modes) {
        agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
        return fallback;
      }

      const res: ProbedAgentModesResult = { ...fallback, availableModes: modes, source: 'dynamic' };
      agentModesProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
      return res;
    } catch {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    } finally {
      const disposable = backend as any;
      if (disposable && typeof disposable.dispose === 'function') {
        await disposable.dispose().catch(() => {});
      }
    }
  });
}

