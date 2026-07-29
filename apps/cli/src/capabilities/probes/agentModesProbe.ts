import type { AcpProbeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { getAgentSessionModesKind, isAgentId, legacyCustomAcpCompat } from '@happier-dev/agents';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { probeConfiguredAcpBackend } from './probeConfiguredAcpBackend';
import { resolveProviderOwnedPreflightControlsProbeDecision } from './providerOwnedPreflightControlsProbePolicy';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { z } from 'zod';

export type ProbedAgentMode = Readonly<{ id: string; name: string; description?: string }>;

export type ProbedAgentModesResult = Readonly<{
  agentId: CatalogAgentLookupId;
  availableModes: ReadonlyArray<ProbedAgentMode>;
  source: 'dynamic' | 'static' | 'unavailable';
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

function buildStatic(agentId: CatalogAgentLookupId): ProbedAgentModesResult {
  return { agentId, availableModes: [], source: 'static' };
}

function buildUnavailable(agentId: CatalogAgentLookupId): ProbedAgentModesResult {
  return { agentId, availableModes: [], source: 'unavailable' };
}

function shouldFailClosedForMissingCli(params: {
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
}): boolean {
  if (params.backendTarget?.kind === 'configuredAcpBackend') return false;
  return resolveAgentCliLaunchSpec(params.agentId) === null;
}

function resolveAgentSessionModesKindForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentSessionModesKind(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return 'acpAgentModes' as const;
  }
  throw new Error(`Unsupported agent session modes lookup id '${agentId}'`);
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
  backend: AcpProbeBackend;
  timeoutMs: number;
}): Promise<ReadonlyArray<ProbedAgentMode> | null> {
  const backend = params.backend;

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
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  connectedServices?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<ProbedAgentModesResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const probeVariant = await resolveAgentProbeVariant({
    agentId: params.agentId,
    probeKind: 'modes',
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
  });
  const cacheKey = buildAgentProbeCacheKey({
    agentId: params.agentId,
    cwd,
    backendTarget: params.backendTarget,
    variant: probeVariant,
    connectedServices: params.connectedServices,
  });

  const cached = agentModesProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentModesProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentModesProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentModesProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentModesProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    if (shouldFailClosedForMissingCli(params)) {
      const unavailable = buildUnavailable(params.agentId);
      agentModesProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return unavailable;
    }

    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODES_TIMEOUT_MS;

    const preflightAdapter = await resolvePreflightSessionControlsProbeAdapter(params.agentId);
    if (preflightAdapter?.probeModesRaw) {
      const probePreflightModesOnce = async (): Promise<ProbedAgentMode[] | null> => {
        const modesRaw = await withPreflightSessionControlsProbeEnvironment({
          agentId: params.agentId,
          probeKind: 'modes',
          cwd,
          connectedServices: params.connectedServices,
          credentials: params.credentials ?? null,
          accountSettings: params.accountSettings ?? null,
          processEnv: params.env ?? process.env,
        }, async ({ env }) => await preflightAdapter.probeModesRaw!({
          backendTarget: params.backendTarget,
          probeKind: 'modes',
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
          env,
        })).catch(() => null);
        return normalizeDynamicModes(modesRaw);
      };

      const probeResult = await runPreflightSessionControlsProbe({
        adapter: preflightAdapter,
        probeOnce: probePreflightModesOnce,
      });
      const decision = resolveProviderOwnedPreflightControlsProbeDecision({
        probeResult,
        emptySuccess: 'unavailable',
      });
      if (decision.kind === 'success') {
        const res: ProbedAgentModesResult = { ...fallback, availableModes: decision.value, source: 'dynamic' };
        agentModesProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
        return res;
      }
      const res = buildUnavailable(params.agentId);
      agentModesProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return res;
    }

    try {
      const configuredAcpProbe = await probeConfiguredAcpBackend({
        agentId: params.agentId,
        backendTarget: params.backendTarget,
        cwd,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        onBackend: async (backend) => await probeModesFromAcpBackend({ backend, timeoutMs }).catch(() => null),
      });
      if (configuredAcpProbe.kind === 'present') {
        const modes = configuredAcpProbe.result;
        if (modes) {
          const res: ProbedAgentModesResult = { ...fallback, availableModes: modes, source: 'dynamic' };
          agentModesProbeCache.setSuccess(cacheKey, res, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
          return res;
        }
        agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
        return fallback;
      }

      if (resolveAgentSessionModesKindForLookupId(params.agentId) !== 'acpAgentModes') {
        agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_SUCCESS_TTL_MS });
        return fallback;
      }
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    } catch {
      agentModesProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_MODES_FAILURE_TTL_MS });
      return fallback;
    }
  });
}
