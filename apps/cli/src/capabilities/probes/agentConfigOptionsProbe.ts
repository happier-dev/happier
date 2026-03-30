import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { z } from 'zod';

export type ProbedAgentConfigOptionValue = string | number | boolean | null;

export type ProbedAgentConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: ProbedAgentConfigOptionValue;
  options?: ReadonlyArray<Readonly<{
    value: ProbedAgentConfigOptionValue;
    name: string;
    description?: string;
  }>>;
}>; 

type ProbedAgentConfigChoice = NonNullable<ProbedAgentConfigOption['options']>[number];

export type ProbedAgentConfigOptionsResult = Readonly<{
  provider: CatalogAgentId;
  configOptions: ReadonlyArray<ProbedAgentConfigOption>;
  source: 'dynamic' | 'static';
}>;

const PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS = 60_000;

const agentConfigOptionsProbeCache = new AsyncTtlCache<ProbedAgentConfigOptionsResult>({
  successTtlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS,
});
const ProbeNonEmptyStringSchema = z.string().trim().min(1);
const ProbeDescriptionSchema = z.string();
const ProbeOptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ProbeConfigChoiceInputSchema = z.object({
  value: z.unknown().optional(),
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
});
const ProbeConfigOptionInputSchema = z.object({
  id: ProbeNonEmptyStringSchema,
  name: ProbeNonEmptyStringSchema,
  description: ProbeDescriptionSchema.optional(),
  type: ProbeNonEmptyStringSchema,
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).optional(),
});

function buildStatic(agentId: CatalogAgentId): ProbedAgentConfigOptionsResult {
  return { provider: agentId, configOptions: [], source: 'static' };
}

function normalizeProbeConfigOptionValue(value: unknown): ProbedAgentConfigOptionValue {
  const parsed = ProbeOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeProbeConfigChoice(choiceRaw: unknown): ProbedAgentConfigChoice | null {
  const parsed = ProbeConfigChoiceInputSchema.safeParse(choiceRaw);
  if (!parsed.success) return null;

  return {
    value: normalizeProbeConfigOptionValue(parsed.data.value),
    name: parsed.data.name,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
  };
}

function normalizeDynamicConfigOptions(configOptionsRaw: unknown): ProbedAgentConfigOption[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const parsed: ProbedAgentConfigOption[] = [];
  for (const optionRaw of configOptionsRaw) {
    const parsedOption = ProbeConfigOptionInputSchema.safeParse(optionRaw);
    if (!parsedOption.success) continue;

    const options = parsedOption.data.options
      ?.map((choiceRaw) => normalizeProbeConfigChoice(choiceRaw))
      .filter((choice): choice is ProbedAgentConfigChoice => choice !== null);

    parsed.push({
      id: parsedOption.data.id,
      name: parsedOption.data.name,
      type: parsedOption.data.type,
      currentValue: normalizeProbeConfigOptionValue(parsedOption.data.currentValue),
      ...(parsedOption.data.description ? { description: parsedOption.data.description } : {}),
      ...(options ? { options } : {}),
    });
  }

  // If the probe returned entries but none were parseable, treat the payload as invalid so callers
  // can apply a short failure TTL instead of caching a silent fallback for a full day.
  if (parsed.length === 0 && configOptionsRaw.length > 0) return null;
  return parsed;
}

export async function probeAgentConfigOptionsBestEffort(params: {
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
}): Promise<ProbedAgentConfigOptionsResult> {
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

  const cached = agentConfigOptionsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentConfigOptionsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentConfigOptionsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    const entry = AGENTS[params.agentId];

    const preflightAdapter = entry?.getPreflightSessionControlsProbeAdapter
      ? await entry.getPreflightSessionControlsProbeAdapter().catch(() => null)
      : null;
    if (preflightAdapter?.probeConfigOptionsRaw) {
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 15_000;

      const probePreflightConfigOptionsOnce = async (): Promise<ProbedAgentConfigOption[] | null> => {
        const configOptionsRaw = await preflightAdapter.probeConfigOptionsRaw!({
          backendTarget: params.backendTarget,
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
        }).catch(() => null);
        return normalizeDynamicConfigOptions(configOptionsRaw);
      };

      let configOptions = await probePreflightConfigOptionsOnce();
      // If the provider marks the preflight probe as authoritative, retry once immediately to
      // avoid sticky "static fallback" UI states that require an explicit user refresh.
      if (!configOptions && preflightAdapter.failureCacheStrategy === 'retry') {
        configOptions = await probePreflightConfigOptionsOnce();
      }

      if (configOptions) {
        const result: ProbedAgentConfigOptionsResult = { ...fallback, configOptions, source: 'dynamic' };
        agentConfigOptionsProbeCache.setSuccess(cacheKey, result, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
        return result;
      }

      if (preflightAdapter.failureCacheStrategy === 'retry') {
        // For providers where this probe is the primary/authoritative source, cache an error so
        // subsequent calls retry instead of freezing the static fallback.
        agentConfigOptionsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
        return fallback;
      }

      // The dynamic probe ran but returned invalid/unparseable data. Never cache that outcome as a
      // 24h "success" fallback; use the short failure TTL so we can recover quickly without
      // re-running the probe on every request.
      agentConfigOptionsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return fallback;
    }

    agentConfigOptionsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
    return fallback;
  });
}
