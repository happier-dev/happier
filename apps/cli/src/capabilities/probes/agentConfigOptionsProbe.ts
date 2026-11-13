import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { AgentConfigOptionsProbeObservation } from '@happier-dev/protocol/capabilities';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { buildAgentProbeCacheKey } from './buildAgentProbeCacheKey';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import {
  normalizeProbedCatalogOption,
  type ProbedCatalogOption,
  type ProbedCatalogOptionValue,
} from './probedCatalogOption';
import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';
import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';
import { runPreflightSessionControlsProbe } from './runPreflightSessionControlsProbe';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { probeConfiguredAcpBackend } from './probeConfiguredAcpBackend';
import { probeAcpSessionControlsFromBackend } from './probeAcpCatalogs';
import { AcpCatalogUnavailableError } from '@/agent/acp/catalog/configured/resolveBackend';

export type ProbedAgentConfigOptionValue = ProbedCatalogOptionValue;

export type ProbedAgentConfigOption = ProbedCatalogOption;

export type ProbedAgentConfigOptionsResult = Readonly<AgentConfigOptionsProbeObservation & {
  agentId: CatalogAgentLookupId;
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
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.backendTarget?.kind === 'configuredAcpBackend') return false;
  return resolveAgentCliLaunchSpec(params.agentId, { processEnv: params.env ?? sessionProcessEnvironment() }) === null;
}

function normalizeDynamicConfigOptions(raw: unknown): Pick<ProbedAgentConfigOptionsResult, 'configOptions' | 'modelConfigOptionId' | 'refreshError' | 'refreshErrorMessage' | 'source'> | null {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const configOptionsRaw = record ? record.configOptions : raw;
  if (!Array.isArray(configOptionsRaw)) return null;

  const parsed: ProbedAgentConfigOption[] = [];
  for (const optionRaw of configOptionsRaw) {
    const normalized = normalizeProbedCatalogOption(optionRaw);
    if (normalized) parsed.push(normalized);
  }

  // If the probe returned entries but none were parseable, treat the payload as invalid so callers
  // can apply a short failure TTL instead of caching a silent fallback for a full day.
  if (parsed.length === 0 && configOptionsRaw.length > 0) return null;
  return { configOptions: parsed, source: record?.source === 'static' ? 'static' : 'dynamic',
    ...(record?.refreshError === true ? { refreshError: true } : {}),
    ...(typeof record?.refreshErrorMessage === 'string' ? { refreshErrorMessage: record.refreshErrorMessage } : {}),
    ...(typeof record?.modelConfigOptionId === 'string' && record.modelConfigOptionId.trim()
      ? { modelConfigOptionId: record.modelConfigOptionId } : {}) };
}

export async function probeAgentConfigOptionsBestEffort(params: {
  agentId: CatalogAgentLookupId;
  registrySnapshot?: Parameters<typeof withPreflightSessionControlsProbeEnvironment>[0]['registrySnapshot'];
  catalogEntry?: AgentCatalogEntry | null;
  runtimeCacheKey?: string;
  signal?: AbortSignal;
  deadlineSignal?: AbortSignal;
  cleanupScope?: PreflightCatalogCleanupScope;
  backendTarget?: BackendTargetRefV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
  cwd: string;
  timeoutMs?: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  secretSources?: Parameters<typeof probeConfiguredAcpBackend>[0]['secretSources'];
  pluginSettings?: AgentCliSessionCommandPluginSettingsV1;
  credentials?: StoredCredentials | null;
  env?: NodeJS.ProcessEnv;
  materializedEnv?: Readonly<Record<string, string>>;
  acquireEnvironment?: PreflightSessionControlsProbeParams['acquireEnvironment'];
  commandArgsSuffix?: readonly string[];
  modelId?: string;
  connectedServiceSelectionCacheKey?: string | null;
  profileCacheKey?: string | null;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
}): Promise<ProbedAgentConfigOptionsResult> {
  const nowMs = Date.now();
  const env = params.env ?? sessionProcessEnvironment();
  const cwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : sessionWorkingDirectory();
  const probeVariant = await resolveAgentProbeVariant({
    agentId: params.agentId,
    catalogEntry: params.catalogEntry,
    runtimeCacheKey: params.runtimeCacheKey,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
    runtimeKindOverride: params.runtimeKindOverride,
    probeKind: 'configOptions',
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
    acpCatalogSnapshot: params.acpCatalogSnapshot,
    pluginSettings: params.pluginSettings,
    env,
  });
  const cacheKey = buildAgentProbeCacheKey({
    agentId: params.agentId,
    cwd,
    backendTarget: params.backendTarget,
    variant: probeVariant,
    connectedServiceSelection: params.connectedServiceSelectionCacheKey,
    profile: params.profileCacheKey,
    modelId: params.modelId,
    configOptionOverrides: params.configOptionOverrides,
  });

  const cached = agentConfigOptionsProbeCache.get(cacheKey);
  if (cached?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached, nowMs)) return cached.value;

  return await agentConfigOptionsProbeCache.runDedupe(cacheKey, async () => {
    const cached2 = agentConfigOptionsProbeCache.get(cacheKey);
    const nowMs2 = Date.now();
    if (cached2?.kind === 'success' && agentConfigOptionsProbeCache.isFresh(cached2, nowMs2)) return cached2.value;

    const fallback = buildStatic(params.agentId);
    const configured = await probeConfiguredAcpBackend({
      agentId: params.agentId, backendTarget: params.backendTarget, cwd,
      accountSettings: params.accountSettings, credentials: params.credentials,
      acpCatalogSnapshot: params.acpCatalogSnapshot, savedSecretOperationContext: params.savedSecretOperationContext,
      machineAdmission: params.machineAdmission, secretSources: params.secretSources,
      processEnv: env, acquireEnvironment: params.acquireEnvironment, signal: params.signal, cleanupScope: params.cleanupScope,
      onBackend: async (backend) => {
        return normalizeDynamicConfigOptions(await probeAcpSessionControlsFromBackend({ backend,
          timeoutMs: params.timeoutMs ?? 15_000, signal: params.signal, configOptionOverrides: params.configOptionOverrides }));
      },
    }).catch((error: unknown) => {
      if (error instanceof AcpCatalogUnavailableError) throw error;
      return { kind: 'present' as const, result: null };
    });
    if (configured.kind === 'present') {
      if (configured.result) {
        const result: ProbedAgentConfigOptionsResult = { ...fallback, ...configured.result, source: 'dynamic' };
        agentConfigOptionsProbeCache.setSuccess(cacheKey, result, { nowMs: nowMs2,
          ttlMs: result.refreshError ? PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS : PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
        return result;
      }
      agentConfigOptionsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return buildUnavailable(params.agentId);
    }
    const preflightAdapter = await resolvePreflightSessionControlsProbeAdapter(params.agentId, params.catalogEntry);
    // A declared preflight hook resolves and checks its own executable; its
    // transport may differ from the Agent's interactive CLI.
    if (!preflightAdapter?.probeConfigOptionsRaw && shouldFailClosedForMissingCli({ ...params, env })) {
      const unavailable = buildUnavailable(params.agentId);
      agentConfigOptionsProbeCache.setError(cacheKey, { nowMs: nowMs2, ttlMs: PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS });
      return unavailable;
    }
    if (preflightAdapter?.probeConfigOptionsRaw) {
      const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 15_000;

      const probePreflightConfigOptionsOnce = async () => {
        const configOptionsRaw = await withPreflightSessionControlsProbeEnvironment({
          registrySnapshot: params.registrySnapshot ?? readCurrentContributionRegistry(),
          catalogEntry: params.catalogEntry,
          agentId: params.agentId,
          processEnv: env,
          materializedEnv: params.materializedEnv, acquireEnvironment: params.acquireEnvironment,
        }, async ({ env, acquireEnvironment }) => await preflightAdapter.probeConfigOptionsRaw!({
          backendTarget: params.backendTarget,
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.deadlineSignal ? { deadlineSignal: params.deadlineSignal } : {}),
          ...(params.cleanupScope ? { cleanupScope: params.cleanupScope } : {}),
          commandArgsSuffix: params.commandArgsSuffix,
          runtimeDescriptorV1: params.runtimeDescriptorV1,
          runtimeKindOverride: params.runtimeKindOverride,
          probeKind: 'configOptions',
          cwd,
          timeoutMs,
          accountSettings: params.accountSettings ?? null,
          pluginSettings: params.pluginSettings,
          configOptionOverrides: params.configOptionOverrides,
          env,
          acquireEnvironment,
        })).catch(() => null);
        return normalizeDynamicConfigOptions(configOptionsRaw);
      };

      const probeResult = await runPreflightSessionControlsProbe({
        adapter: preflightAdapter,
        probeOnce: probePreflightConfigOptionsOnce,
      });

      if (probeResult.kind === 'success') {
        const result: ProbedAgentConfigOptionsResult = { ...fallback, ...probeResult.value };
        agentConfigOptionsProbeCache.setSuccess(cacheKey, result, { nowMs: nowMs2,
          ttlMs: result.refreshError ? PROBE_CONFIG_OPTIONS_FAILURE_TTL_MS : PROBE_CONFIG_OPTIONS_SUCCESS_TTL_MS });
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
