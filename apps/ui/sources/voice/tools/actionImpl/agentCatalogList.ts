import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import {
    readBackendTargetRefV2,
    readLegacyConfiguredAcpBackendId,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';
import {
    getAgentStaticModels,
} from '@happier-dev/agents';
import {
    isLegacyCompatAgentType,
    LEGACY_COMPAT_PRIMARY_AGENT_ID,
} from '@/agents/backendCatalog/legacyCompatAgents';
import { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
  getResolvedBackendCatalogEntries,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type {
  MergedBackendProjectionEntry,
  MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
import {
  readDynamicModelProbeCache,
  runDynamicModelProbeDedupe,
  writeDynamicModelProbeCacheError,
  writeDynamicModelProbeCacheSuccess,
  writeDynamicModelProbeCacheTransientSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import { createUnavailablePreflightModelList, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

const CONFIGURED_ACP_CLI_CAPABILITY_ID = 'configuredAcp';

function resolvePluginRuntimeCarrierAgentId(providerAgentId: string | null | undefined): AgentId | null {
  return providerAgentId && isAgentId(providerAgentId) ? providerAgentId : null;
}

function resolveConfiguredAcpCompatProbeAgentId(params: Readonly<{
  backendTarget: BackendTargetRefV1 | null;
  providedAgentId: string;
}>): AgentId | null {
  if (params.backendTarget?.kind !== 'configuredAcpBackend') {
    return null;
  }
  if (params.providedAgentId) {
    const configuredCompatBackendId = readLegacyConfiguredAcpBackendId(params.providedAgentId);
    if (configuredCompatBackendId && configuredCompatBackendId === params.backendTarget.backendId) {
      return LEGACY_COMPAT_PRIMARY_AGENT_ID as AgentId;
    }
    return isLegacyCompatAgentType(params.providedAgentId) ? (LEGACY_COMPAT_PRIMARY_AGENT_ID as AgentId) : null;
  }
  return LEGACY_COMPAT_PRIMARY_AGENT_ID as AgentId;
}

function getAgentLookupStaticModels(agentId: AgentId): ReadonlyArray<Readonly<{
  id: string;
  name: string;
  description?: string;
}>> {
  return getAgentStaticModels(agentId);
}

function buildVoiceToolPreflightModelResult(params: Readonly<{
  shouldExposeAgentId: boolean;
  agentId: AgentId;
  machineId: string;
  list: PreflightModelList;
  limit: number | null;
}>): Readonly<{
  agentId?: AgentId;
  machineId: string;
  items: ReadonlyArray<Readonly<{
    modelId: string;
    label: string;
    description?: string;
  }>>;
  supportsFreeform: boolean;
  source: 'preflight' | 'unavailable';
  unavailable?: true;
}> {
  if (params.list.unavailable === true) {
    return {
      ...(params.shouldExposeAgentId ? { agentId: params.agentId } : {}),
      machineId: params.machineId,
      items: [],
      supportsFreeform: false,
      source: 'unavailable',
      unavailable: true,
    };
  }

  const dynamic = params.list.availableModels.map((m) => ({
    modelId: String(m.id),
    label: String(m.name),
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
  }));

  const withDefault = [{ modelId: 'default', label: 'Default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
  const seen = new Set<string>();
  const items = withDefault.filter((m) => {
    const id = String(m.modelId ?? '').trim();
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return {
    ...(params.shouldExposeAgentId ? { agentId: params.agentId } : {}),
    machineId: params.machineId,
    items: params.limit ? items.slice(0, params.limit) : items,
    supportsFreeform: params.list.supportsFreeform === true,
    source: 'preflight',
  };
}

type VoiceToolConnectedService = ReturnType<typeof getAgentCore>['uiConnectedService'];

type VoiceToolBackendCatalogItem = Readonly<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId?: string;
  subtitle?: string | null;
  experimental?: boolean;
  uiConnectedService?: VoiceToolConnectedService | null;
  flavorAliases?: readonly string[];
  supportsModelSelection?: boolean;
  supportsFreeformModels?: boolean;
}>;

function resolveBackendCatalogItemsForVoiceTool(params: Readonly<{
  includeDisabled: boolean;
  daemonMergedProjectionInputs: null | Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
  }>;
}>): VoiceToolBackendCatalogItem[] {
  const state = storage.getState();
  const backendEnabledByTargetKey = state.settings?.backendEnabledByTargetKey ?? null;
  const acpCatalogSettingsV1 = state.settings?.acpCatalogSettingsV1 ?? { v: 2, backends: [] };
  const enabledBuiltInAgentIds = params.includeDisabled
    ? Array.from(AGENT_IDS)
    : Array.from(AGENT_IDS).filter((id) => backendEnabledByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: id })] !== false);

  const items: VoiceToolBackendCatalogItem[] = [];
  for (const entry of getResolvedBackendCatalogEntries({
    enabledAgentIds: enabledBuiltInAgentIds,
    acpCatalogSettingsV1,
    backendEnabledByTargetKey: params.includeDisabled ? undefined : backendEnabledByTargetKey,
    mergedProviderProjectionById: params.daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
    mergedBackendProjectionById: params.daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    discoveredBackendIds: params.daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
  })) {
    const effectiveTargetKey = entry.backendTargetKey;
    const enabled = backendEnabledByTargetKey?.[effectiveTargetKey] !== false;
    if (!params.includeDisabled && !enabled) continue;

    if (entry.builtInAgentId) {
      const core = getAgentCore(entry.builtInAgentId);
      items.push({
        targetKey: effectiveTargetKey,
        label: entry.title,
        subtitle: entry.subtitle,
        enabled,
        agentId: entry.builtInAgentId,
        experimental: core.availability.experimental === true,
        uiConnectedService: core.uiConnectedService,
        flavorAliases: core.flavorAliases,
        supportsModelSelection: core.model.supportsSelection === true,
        supportsFreeformModels: core.model.supportsFreeform === true,
      });
      continue;
    }

    if (entry.kind === 'pluginBackend') {
      const carrierAgentId = resolvePluginRuntimeCarrierAgentId(entry.providerAgentId);
      items.push({
        targetKey: effectiveTargetKey,
        label: entry.title,
        subtitle: entry.subtitle,
        enabled,
        ...(carrierAgentId ? { agentId: carrierAgentId } : {}),
        experimental: false,
        uiConnectedService: null,
        flavorAliases: [],
        supportsModelSelection: carrierAgentId != null,
        supportsFreeformModels: carrierAgentId != null,
      });
      continue;
    }

    items.push({
      targetKey: effectiveTargetKey,
      label: entry.title,
      subtitle: entry.subtitle,
      enabled,
      experimental: false,
      uiConnectedService: null,
      flavorAliases: [],
      supportsModelSelection: true,
      supportsFreeformModels: true,
    });
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.enabled !== right.item.enabled) {
        return left.item.enabled ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export async function listAgentBackendsForVoiceTool(params: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>): Promise<unknown> {
  const includeDisabled = params.includeDisabled === true;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const machineId = normalizeId(params.machineId);
  const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
  const daemonMergedProjectionInputs = machineId
    ? await (async () => {
      const res = await machineContributionRegistryProjectionDescribe(machineId, { serverId, timeoutMs: 5_000 });
      if (res.supported !== true) return null;
      const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
      const discoveredBackendIds = Object.keys(adapted.mergedBackendProjectionById ?? {});
      return {
        mergedProviderProjectionById: adapted.mergedProviderProjectionById,
        mergedBackendProjectionById: adapted.mergedBackendProjectionById,
        discoveredBackendIds,
      };
    })()
    : null;
  const items = resolveBackendCatalogItemsForVoiceTool({ includeDisabled, daemonMergedProjectionInputs });

  return { items: limit ? items.slice(0, limit) : items };
}

export async function listAgentModelsForVoiceTool(params: Readonly<{
  agentId?: string;
  machineId?: string;
  limit?: number;
  backendTargetKey?: string;
}>): Promise<unknown> {
  const backendTargetKey = normalizeId(params.backendTargetKey);
  let backendTarget: BackendTargetRefV1 | null = null;
  if (backendTargetKey) {
    try {
      const canonicalBackendTarget = readBackendTargetRefV2(backendTargetKey);
      backendTarget = canonicalBackendTarget.sourceKind === 'configured'
        ? { kind: 'configuredAcpBackend', backendId: canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId }
        : { kind: 'builtInAgent', agentId: canonicalBackendTarget.backendId };
    } catch {
      return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
  }
  const providedAgentId = normalizeId(params.agentId);
  const requiresPluginCarrierAgent = backendTarget?.kind === 'builtInAgent' && !isAgentId(backendTarget.agentId);
  const compatConfiguredAcpProbeAgentId = resolveConfiguredAcpCompatProbeAgentId({
    backendTarget,
    providedAgentId,
  });
  const agentIdRaw = compatConfiguredAcpProbeAgentId
    || providedAgentId
    || (
      backendTarget?.kind === 'builtInAgent'
        ? (isAgentId(backendTarget.agentId) ? backendTarget.agentId : '')
        : compatConfiguredAcpProbeAgentId
          ? compatConfiguredAcpProbeAgentId
          : ''
    );
  if (requiresPluginCarrierAgent && !isAgentId(agentIdRaw)) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (!agentIdRaw || (!isAgentId(agentIdRaw) && !isLegacyCompatAgentType(agentIdRaw))) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'builtInAgent' && isAgentId(backendTarget.agentId) && agentIdRaw !== backendTarget.agentId) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'configuredAcpBackend' && !isLegacyCompatAgentType(agentIdRaw)) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (isLegacyCompatAgentType(agentIdRaw) && !backendTarget) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  const agentId = agentIdRaw as AgentId;
  const shouldExposeAgentId = !compatConfiguredAcpProbeAgentId;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const isLegacyCompatProbe = isLegacyCompatAgentType(agentIdRaw);
  let supportsSelection = true;
  let supportsFreeformFallback = true;
  if (!isLegacyCompatProbe) {
    const core = getAgentCore(agentId);
    supportsSelection = core?.model.supportsSelection === true;
    supportsFreeformFallback = core?.model.supportsFreeform === true;
  }

  if (supportsSelection !== true) {
    return {
      ...(shouldExposeAgentId ? { agentId } : {}),
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: false,
      source: 'static' as const,
    };
  }

  const machineId = normalizeId(params.machineId);
  if (machineId) {
    const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
    const canonicalTargetKeyForCache = backendTarget
      ? resolveBackendTargetKeyV2(backendTarget)
      : resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId });
    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId,
      targetKey: canonicalTargetKeyForCache,
      serverId,
      cwd: null,
    });

    const nowMs = Date.now();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
    const cachedCanPersist = cacheEntry?.kind === 'success' && cacheEntry.cacheable !== false;
    if (cached && nowMs >= 0 && nowMs < cacheEntry!.expiresAt) {
      return buildVoiceToolPreflightModelResult({
        shouldExposeAgentId,
        agentId,
        machineId,
        list: cached,
        limit,
      });
    }

    if (cacheKey) {
      const attempt = await runDynamicModelProbeDedupe<Readonly<{
        list: PreflightModelList;
        cacheable: boolean;
      }> | null>(cacheKey, async () => {
        const capabilityIdSuffix =
          backendTarget?.kind === 'configuredAcpBackend'
            ? CONFIGURED_ACP_CLI_CAPABILITY_ID
            : agentId;
        const capabilityId = buildProviderCliCapabilityId(capabilityIdSuffix);
        const res = await machineCapabilitiesInvoke(
          machineId,
          {
            id: capabilityId,
            method: 'probeModels',
            params: {
              timeoutMs: 15_000,
              ...(backendTarget ? { backendTarget } : {}),
            },
          },
          { ...(serverId ? { serverId } : {}) },
        );

        if (!res.supported) {
          return { list: createUnavailablePreflightModelList(), cacheable: false };
        }
        if (!res.response.ok) {
          return { list: createUnavailablePreflightModelList(), cacheable: false };
        }

        const list = parsePreflightModelListFromProbeModelsResult(res.response.result);
        if (!list) {
          return { list: createUnavailablePreflightModelList(), cacheable: false };
        }
        const result = res.response.result;
        const source = result && typeof result === 'object' && !Array.isArray(result)
          ? (typeof (result as Record<string, unknown>).source === 'string' ? (result as Record<string, unknown>).source : null)
          : null;
        const cacheable = source !== 'static' && source !== 'unavailable';
        return { list, cacheable };
      });

      const commitNowMs = Date.now();
      const list = attempt?.list ?? null;
      if (list && attempt?.cacheable !== false) {
        writeDynamicModelProbeCacheSuccess(cacheKey, list, commitNowMs);
        return buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list,
          limit,
        });
      }

      if (list && attempt?.cacheable === false && !cached) {
        writeDynamicModelProbeCacheTransientSuccess(cacheKey, list, commitNowMs);
        writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
        return buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list,
          limit,
        });
      }

      if (cached) {
        if (cachedCanPersist) {
          writeDynamicModelProbeCacheSuccess(cacheKey, cached, commitNowMs);
        }
        return buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list: cached,
          limit,
        });
      }

      writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
    }
  }

  if (isLegacyCompatProbe) {
    return {
      ...(shouldExposeAgentId ? { agentId } : {}),
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: supportsFreeformFallback,
      source: 'static' as const,
    };
  }

  const seen = new Set<string>();
  const items = [
    { modelId: 'default', label: 'Default' },
    ...getAgentLookupStaticModels(agentId).map((model) => ({
      modelId: String(model.id),
      label: String(model.name),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
    })),
  ].filter((item) => {
    const id = String(item.modelId ?? '').trim();
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return {
    ...(shouldExposeAgentId ? { agentId } : {}),
    items: limit ? items.slice(0, limit) : items,
    supportsFreeform: supportsFreeformFallback,
    source: 'static' as const,
  };
}
