import { withCodexAppServerClient } from '@/backends/codex/appServer/client/withCodexAppServerClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import type { CatalogAgentId } from '@/backends/types';
import { resolveCodexSessionBackendMode } from '@happier-dev/agents';
import { AsyncTtlCache, buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

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

function buildAgentConfigOptionsProbeCacheKey(agentId: CatalogAgentId, cwd: string, backendTarget?: BackendTargetRefV1, variant?: string): string {
  const normalizedCwd = String(cwd ?? '').trim();
  const targetKey = backendTarget ? buildBackendTargetKey(backendTarget) : `agent:${agentId}`;
  return `${targetKey}:${normalizedCwd}:${variant ?? 'default'}`;
}

function resolveProbeVariant(agentId: CatalogAgentId, accountSettings?: Readonly<Record<string, unknown>> | null): string {
  if (agentId !== 'codex') return `${agentId}:default`;
  return `codex:${resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'default'}`;
}

function buildStatic(agentId: CatalogAgentId): ProbedAgentConfigOptionsResult {
  return { provider: agentId, configOptions: [], source: 'static' };
}

function normalizeDynamicConfigOptions(configOptionsRaw: unknown): ProbedAgentConfigOption[] | null {
  if (!Array.isArray(configOptionsRaw)) return null;

  const parsed = configOptionsRaw
    .map((optionRaw) => {
      if (!optionRaw || typeof optionRaw !== 'object' || Array.isArray(optionRaw)) return null;
      const option = optionRaw as Record<string, unknown>;
      const id = typeof option.id === 'string' ? option.id.trim() : '';
      const name = typeof option.name === 'string' ? option.name.trim() : '';
      const type = typeof option.type === 'string' ? option.type.trim() : '';
      if (!id || !name || !type) return null;
      const description = typeof option.description === 'string' ? option.description : undefined;
      const currentValue =
        typeof option.currentValue === 'string'
        || typeof option.currentValue === 'number'
        || typeof option.currentValue === 'boolean'
        || option.currentValue === null
          ? option.currentValue
          : null;
      const options = Array.isArray(option.options)
        ? option.options
            .map((choiceRaw) => {
              if (!choiceRaw || typeof choiceRaw !== 'object' || Array.isArray(choiceRaw)) return null;
              const choice = choiceRaw as Record<string, unknown>;
              const choiceName = typeof choice.name === 'string' ? choice.name.trim() : '';
              if (!choiceName) return null;
              const value =
                typeof choice.value === 'string'
                || typeof choice.value === 'number'
                || typeof choice.value === 'boolean'
                || choice.value === null
                  ? choice.value
                  : null;
              const choiceDescription = typeof choice.description === 'string' ? choice.description : undefined;
              const normalizedChoice: ProbedAgentConfigChoice = {
                value,
                name: choiceName,
                ...(choiceDescription ? { description: choiceDescription } : {}),
              };
              return normalizedChoice;
            })
            .filter(Boolean) as NonNullable<ProbedAgentConfigOption['options']>
        : undefined;

      return {
        id,
        name,
        type,
        currentValue,
        ...(description ? { description } : {}),
        ...(options ? { options } : {}),
      } satisfies ProbedAgentConfigOption;
    })
    .filter(Boolean) as ProbedAgentConfigOption[];

  return parsed;
}

async function probeConfigOptionsFromCodexAppServer(params: Readonly<{
  cwd: string;
}>): Promise<ReadonlyArray<ProbedAgentConfigOption> | null> {
  const controls = await withCodexAppServerClient({
    cwd: params.cwd,
    run: async (client) => readCodexAppServerSessionControls({ client }),
  });
  return normalizeDynamicConfigOptions(controls.configOptions);
}

export async function probeAgentConfigOptionsBestEffort(params: {
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
}): Promise<ProbedAgentConfigOptionsResult> {
  void params.timeoutMs;
  void params.credentials;

  const nowMs = Date.now();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : process.cwd();
  const probeVariant = resolveProbeVariant(params.agentId, params.accountSettings);
  const cacheKey = buildAgentConfigOptionsProbeCacheKey(params.agentId, cwd, params.backendTarget, probeVariant);

  const cached = agentConfigOptionsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentConfigOptionsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentConfigOptionsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    const codexBackendMode = params.agentId === 'codex'
      ? resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null })
      : null;
    if (params.agentId === 'codex' && codexBackendMode === 'appServer') {
      const configOptions = await probeConfigOptionsFromCodexAppServer({ cwd }).catch(() => null);
      if (configOptions) {
        const result: ProbedAgentConfigOptionsResult = { ...fallback, configOptions, source: 'dynamic' };
        agentConfigOptionsProbeCache.setSuccess(cacheKey, result, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
        return result;
      }
      agentConfigOptionsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return fallback;
    }

    agentConfigOptionsProbeCache.setSuccess(cacheKey, fallback, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
    return fallback;
  });
}
