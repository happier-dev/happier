import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { AsyncTtlCache, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import {
  normalizeProbedCatalogOption,
  type ProbedCatalogOption,
  type ProbedCatalogOptionValue,
} from './probedCatalogOption';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { resolveProviderOwnedPreflightControlsProbeDecision } from './providerOwnedPreflightControlsProbePolicy';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';

export type ProbedAgentConfigOptionValue = ProbedCatalogOptionValue;

export type ProbedAgentConfigOption = ProbedCatalogOption;

export type ProbedAgentConfigOptionsResult = Readonly<{
  agentId: CatalogAgentLookupId;
  configOptions: ReadonlyArray<ProbedAgentConfigOption>;
  source: 'dynamic' | 'static' | 'unavailable';
}>;

const PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS = 24 * 60 * 60_000;
const PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS = 60_000;

const agentConfigOptionsProbeCache = new AsyncTtlCache<ProbedAgentConfigOptionsResult>({
  successTtlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS,
  errorTtlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS,
});
function buildStatic(agentId: CatalogAgentLookupId): ProbedAgentConfigOptionsResult {
  return { agentId, configOptions: [], source: 'static' };
}

function buildUnavailable(agentId: CatalogAgentLookupId): ProbedAgentConfigOptionsResult {
  return { agentId, configOptions: [], source: 'unavailable' };
}

function shouldFailClosedForMissingCli(params: {
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
}): boolean {
  if (params.backendTarget?.kind === 'configuredAcpBackend') return false;
  return resolveAgentCliLaunchSpec(params.agentId) === null;
}

function normalizeDynamicConfigOptions(configOptionsRaw: unknown): ProbedAgentConfigOption[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const parsed: ProbedAgentConfigOption[] = [];
  for (const optionRaw of configOptionsRaw) {
    const normalized = normalizeProbedCatalogOption(optionRaw);
    if (normalized) parsed.push(normalized);
  }

  // If the probe returned entries but none were parseable, treat the payload as invalid so callers
  // can apply a short failure TTL instead of caching a silent fallback for a full day.
  if (parsed.length === 0 && configOptionsRaw.length > 0) return null;
  return parsed;
}

export async function probeAgentConfigOptionsBestEffort(params: {
  agentId: CatalogAgentLookupId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials | null;
  env?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionCacheKey?: string | null;
}): Promise<ProbedAgentConfigOptionsResult> {
  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const probeVariant = await resolveAgentProbeVariant({
    agentId: params.agentId,
    probeKind: 'configOptions',
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

  const cached = agentConfigOptionsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentConfigOptionsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentConfigOptionsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    if (shouldFailClosedForMissingCli(params)) {
      const unavailable = buildUnavailable(params.agentId);
      agentConfigOptionsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return unavailable;
    }
    const preflightAdapter = await resolvePreflightSessionControlsProbeAdapter(params.agentId);
    if (preflightAdapter?.probeConfigOptionsRaw) {
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 15_000;

      const probePreflightConfigOptionsOnce = async (): Promise<ProbedAgentConfigOption[] | null> => {
        const configOptionsRaw = await withPreflightSessionControlsProbeEnvironment({
          agentId: params.agentId,
          processEnv: params.env ?? process.env,
          materializedEnv: params.materializedEnv,
        }, async ({ env }) => await preflightAdapter.probeConfigOptionsRaw!({
          backendTarget: params.backendTarget,
          probeKind: 'configOptions',
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
          env,
        })).catch(() => null);
        return normalizeDynamicConfigOptions(configOptionsRaw);
      };

      const probeResult = await runPreflightSessionControlsProbe({
        adapter: preflightAdapter,
        probeOnce: probePreflightConfigOptionsOnce,
      });

      const decision = resolveProviderOwnedPreflightControlsProbeDecision({
        probeResult,
        emptySuccess: 'success',
      });
      if (decision.kind === 'success') {
        const result: ProbedAgentConfigOptionsResult = { ...fallback, configOptions: decision.value, source: 'dynamic' };
        agentConfigOptionsProbeCache.setSuccess(cacheKey, result, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
        return result;
      }

      const result = buildUnavailable(params.agentId);
      agentConfigOptionsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return result;
    }

    agentConfigOptionsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
    return fallback;
  });
}
