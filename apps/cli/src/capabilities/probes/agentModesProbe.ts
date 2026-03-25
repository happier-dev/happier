import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend } from '@/agent/core';
import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { getAgentSessionModesKind } from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';
import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { z } from 'zod';

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
const ProbeNonEmptyStringSchema = z.string().trim().min(1);
const ProbeDescriptionSchema = z.string();
const ProbeModeInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});
const ProbeModeConfigCandidateSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  options: z.array(z.unknown()).optional(),
});
const ProbeModeChoiceInputSchema = z.object({
  value: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});

function buildStatic(agentId: CatalogAgentId): ProbedAgentModesResult {
  return { provider: agentId, availableModes: [], source: 'static' };
}

function normalizeDynamicModes(modesRaw: unknown): ProbedAgentMode[] | null {
  if (!Array.isArray(modesRaw)) return null;
  const parsed = modesRaw
    .map((modeRaw) => {
      const parsedMode = ProbeModeInputSchema.safeParse(modeRaw);
      if (!parsedMode.success) return null;

      return {
        id: parsedMode.data.id,
        name: parsedMode.data.name,
        ...(parsedMode.data.description ? { description: parsedMode.data.description } : {}),
      } satisfies ProbedAgentMode;
    })
    .filter((mode): mode is ProbedAgentMode => mode !== null);

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

  const configOptions = configOptionsRaw
    .map((optionRaw) => ProbeModeConfigCandidateSchema.safeParse(optionRaw))
    .filter((parsed): parsed is Extract<typeof parsed, { success: true }> => parsed.success)
    .map((parsed) => parsed.data);
  if (configOptions.length === 0) return null;

  const candidate =
    configOptions.find((option) => option.id?.trim().toLowerCase() === 'mode') ??
    configOptions.find((option) => option.name?.trim().toLowerCase() === 'mode') ??
    null;
  if (!candidate) return null;

  const optionsRaw = candidate.options ?? null;
  if (!optionsRaw) return null;

  const parsed = optionsRaw
    .map((optionRaw) => {
      const parsedOption = ProbeModeChoiceInputSchema.safeParse(optionRaw);
      if (!parsedOption.success) return null;

      return {
        id: parsedOption.data.value,
        name: parsedOption.data.name,
        ...(parsedOption.data.description ? { description: parsedOption.data.description } : {}),
      } satisfies ProbedAgentMode;
    })
    .filter((mode): mode is ProbedAgentMode => mode !== null);

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
  type ProbeModesBackend = AgentBackend & Partial<{
    getSessionModeState: () => { availableModes?: unknown } | null;
    getSessionConfigOptionsState: () => unknown;
  }>;

  const backend: ProbeModesBackend = params.backend;

  const timeoutMs = Math.max(250, params.timeoutMs);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`ACP startSession timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  await Promise.race([backend.startSession(), timeoutPromise]).finally(() => {
    if (timerId !== null) clearTimeout(timerId);
  });

  if (typeof backend.getSessionModeState === 'function') {
    const state = backend.getSessionModeState();
    const modesRaw = state?.availableModes;
    const modes = normalizeDynamicModes(modesRaw);
    if (modes) return modes;
  }

  if (typeof backend.getSessionConfigOptionsState === 'function') {
    const configOptions = backend.getSessionConfigOptionsState();
    const modes = normalizeModesFromConfigOptions(configOptions);
    if (modes) return modes;
  }

  return null;
}

export async function probeAgentModesBestEffort(params: {
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
}): Promise<ProbedAgentModesResult> {
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

  const cached = agentModesProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentModesProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentModesProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModesProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentModesProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);

    const entry = AGENTS[params.agentId];
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODES_TIMEOUT_MS;

    const preflightAdapter = entry?.getPreflightSessionControlsProbeAdapter
      ? await entry.getPreflightSessionControlsProbeAdapter().catch(() => null)
      : null;
    if (preflightAdapter?.probeModesRaw) {
      const probePreflightModesOnce = async (): Promise<ProbedAgentMode[] | null> => {
        const modesRaw = await preflightAdapter.probeModesRaw!({
          backendTarget: params.backendTarget,
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
        }).catch(() => null);
        return normalizeDynamicModes(modesRaw);
      };

      let modes = await probePreflightModesOnce();
      // If the provider marks the preflight probe as authoritative, retry once immediately to
      // avoid sticky "static fallback" UI states that require an explicit user refresh.
      if (!modes && preflightAdapter.failureCacheStrategy === 'retry') {
        modes = await probePreflightModesOnce();
      }
      if (modes) {
        const res: ProbedAgentModesResult = { ...fallback, availableModes: modes, source: 'dynamic' };
        agentModesProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
        return res;
      }
      if (preflightAdapter.failureCacheStrategy === 'retry') {
        agentModesProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
        return fallback;
      }
    }

    if (getAgentSessionModesKind(params.agentId) !== 'acpAgentModes') {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
      return fallback;
    }
    if (!entry?.getAcpBackendFactory) {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    }

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
        const modes = await probeModesFromAcpBackend({ backend: configuredBackend, timeoutMs }).catch(() => null);
        if (modes) {
          const res: ProbedAgentModesResult = { ...fallback, availableModes: modes, source: 'dynamic' };
          agentModesProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
          return res;
        }
        agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
        return fallback;
      }
    } catch {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    } finally {
      if (configuredBackend) {
        await configuredBackend.dispose().catch(() => {});
      }
    }

    const spawnValidation = await validateCatalogAcpProbeSpawn(params.agentId);
    if (!spawnValidation.ok) {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
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
      if (backend) {
        await backend.dispose().catch(() => {});
      }
    }
  });
}
