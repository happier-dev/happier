import { AGENT_IDS, getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import {
    AgentsBackendsListOutputSchema,
    readBackendTargetRefV2,
    readLegacyConfiguredAcpBackendId,
    providerCatalogPermitsUnlistedModelIdV1,
    readProviderSettingsFromAccountSettingsV1,
    type AgentsBackendsListOutput,
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
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
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
import { describeProviderModels } from '@/providers/rpc/client';
import {
  buildSessionModelPickerSections,
  hiddenModelVisibilityKeys,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { isVoiceProvidersFeatureEnabledForSpawn } from './spawnSessionModelSelection';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

const CONFIGURED_ACP_CLI_CAPABILITY_ID = 'configuredAcp';

/**
 * The Agent id a catalog backend's model probe runs under.
 *
 * A backend that declares a bundled carrier keeps that carrier's CLI capability
 * (`cli.claude`). An externally installed Agent has no bundled carrier and
 * probes under its own projected id: `isBundledAgentId` answers only whether a
 * bundled fact exists and must never reject the Agent.
 */
function resolveBackendModelProbeAgentId(entry: Readonly<{
  catalogAgentId: string | null | undefined;
  agentId: string | null | undefined;
}>): AgentId | null {
  const carrierAgentId = normalizeId(entry.catalogAgentId);
  if (carrierAgentId && isBundledAgentId(carrierAgentId)) return carrierAgentId;
  const projectedAgentId = normalizeId(entry.agentId);
  return projectedAgentId ? (projectedAgentId as AgentId) : null;
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

type VoiceToolModelListResult = Readonly<{
  agentId?: AgentId;
  machineId?: string;
  items: ReadonlyArray<Readonly<{
    modelId: string;
    label: string;
    description?: string;
    providerConnectionId?: string | null;
    providerName?: string;
  }>>;
  supportsFreeform: boolean;
  source: 'preflight' | 'static' | 'unavailable';
  unavailable?: true;
}>;

async function projectVoiceToolProviderModels(params: Readonly<{
  base: VoiceToolModelListResult;
  agentTargetKey: string;
  machineId: string;
  serverId: string | null;
  limit: number | null;
}>): Promise<VoiceToolModelListResult> {
  const providersEnabled = await isVoiceProvidersFeatureEnabledForSpawn({ serverId: params.serverId });
  if (!providersEnabled) {
    return params.base;
  }

  let projection: Awaited<ReturnType<typeof describeProviderModels>>;
  try {
    projection = await describeProviderModels({
      machineId: params.machineId,
      serverId: params.serverId,
      agentTargetKey: params.agentTargetKey,
      mode: 'picker',
    });
  } catch {
    return params.base;
  }
  if (projection.status !== 'success') return params.base;

  const settings = readProviderSettingsFromAccountSettingsV1(storage.getState().settings).settings;
  const sections = buildSessionModelPickerSections({
    agentTargetKey: params.agentTargetKey,
    nativeModels: params.base.items.map((item) => ({
      value: item.modelId,
      label: item.label,
      ...(item.description ? { description: item.description } : {}),
    })),
    providerGroups: projection.groups,
    providerProjectionAuthoritative: true,
    hiddenNativeModelKeys: hiddenModelVisibilityKeys(settings, { providersFeatureEnabled: true }),
    canConfirmExperimental: false,
  });
  const connectionNameBySectionId = new Map(
    sections
      .filter((section) => section.id.startsWith('connection:'))
      .map((section) => [section.id, section.title ?? ''] as const),
  );
  const items = sections.flatMap((section) => section.options.flatMap((option) => {
    if (option.disabled === true) return [];
    const ref = option.value;
    const modelId = ref?.modelId ?? 'default';
    return [{
      modelId,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      providerConnectionId: ref?.providerConnectionId ?? null,
      ...(ref?.providerConnectionId
        ? { providerName: connectionNameBySectionId.get(section.id) ?? '' }
        : {}),
    }];
  }));
  const limitedItems = params.limit ? items.slice(0, params.limit) : items;
  const hasProviderModels = items.some((item) => item.providerConnectionId !== null);
  const supportsProviderFreeform = projection.groups.some((group) => (
    group.authorization.authorized
    && providerCatalogPermitsUnlistedModelIdV1({
      manualModelPolicy: group.manualModelPolicy,
      agentSupportsFreeformModelIds: group.supportsFreeformModelIds,
    })
  ));

  return {
    ...(params.base.agentId ? { agentId: params.base.agentId } : {}),
    machineId: params.machineId,
    items: limitedItems,
    supportsFreeform: params.base.supportsFreeform || supportsProviderFreeform,
    source: params.base.source,
    ...(!hasProviderModels && params.base.unavailable === true ? { unavailable: true as const } : {}),
  };
}

type VoiceToolBackendCatalogItem = AgentsBackendsListOutput['items'][number];

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

    const executionTarget = entry.backendTarget.kind === 'agent'
      ? entry.backendTarget
      : resolveAgentExecutionTargetForBackendTarget({
        backendTarget: entry.backendTarget,
        daemonMergedProjectionInputs: params.daemonMergedProjectionInputs,
      });

    if (entry.kind === 'builtInAgent' && entry.builtInAgentId) {
      items.push({
        targetKey: effectiveTargetKey,
        label: entry.title,
        enabled,
        agentId: entry.builtInAgentId,
        ...(executionTarget ? { identity: executionTarget.identity } : {}),
      });
      continue;
    }

    if (entry.kind === 'pluginBackend') {
      const probeAgentId = resolveBackendModelProbeAgentId(entry);
      items.push({
        targetKey: effectiveTargetKey,
        label: entry.title,
        enabled,
        ...(probeAgentId ? { agentId: probeAgentId } : {}),
        ...(executionTarget ? { identity: executionTarget.identity } : {}),
      });
      continue;
    }

    items.push({
      targetKey: effectiveTargetKey,
      label: entry.title,
      enabled,
      backendId: entry.backendId,
      ...(entry.subtitle ? { description: entry.subtitle } : {}),
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

export async function listAgentBackendsForVoiceTool(params: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>): Promise<AgentsBackendsListOutput> {
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

  return AgentsBackendsListOutputSchema.parse({
    items: limit ? items.slice(0, limit) : items,
  });
}

export async function listAgentModelsForVoiceTool(params: Readonly<{
  agentId?: string;
  machineId?: string;
  serverId?: string;
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
  const compatConfiguredAcpProbeAgentId = resolveConfiguredAcpCompatProbeAgentId({
    backendTarget,
    providedAgentId,
  });
  // An Agent id is open: an externally installed Agent names itself and the
  // machine capability probe owns whether that Agent can list models. Only an
  // absent id is unknown here.
  const agentIdRaw = compatConfiguredAcpProbeAgentId
    || providedAgentId
    || (backendTarget?.kind === 'builtInAgent' ? normalizeId(backendTarget.agentId) : '');
  if (!agentIdRaw) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'builtInAgent' && isBundledAgentId(backendTarget.agentId) && agentIdRaw !== backendTarget.agentId) {
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
  // Only a bundled Agent carries a build-time model fact. Without one the
  // machine capability probe answers whether this Agent supports selection, so
  // a missing bundled core must not be read as "no model selection".
  const bundledCore = isLegacyCompatProbe ? null : getAgentCore(agentId);
  const supportsSelection = bundledCore ? bundledCore.model.supportsSelection === true : true;
  const supportsFreeformFallback = bundledCore ? bundledCore.model.supportsFreeform === true : true;

  if (supportsSelection !== true) {
    return {
      ...(shouldExposeAgentId ? { agentId } : {}),
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: false,
      source: 'static' as const,
    };
  }

  const machineId = normalizeId(params.machineId);
  const serverId = normalizeId(params.serverId) || normalizeId(getActiveServerSnapshot()?.serverId) || null;
  const canonicalTargetKey = backendTarget
    ? resolveBackendTargetKeyV2(backendTarget)
    : resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId });
  const withProviderProjection = async (base: VoiceToolModelListResult): Promise<VoiceToolModelListResult> => (
    machineId
      ? projectVoiceToolProviderModels({
        base,
        agentTargetKey: canonicalTargetKey,
        machineId,
        serverId,
        limit,
      })
      : base
  );
  if (machineId) {
    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId,
      targetKey: canonicalTargetKey,
      providerConnectionId: null,
      serverId,
      cwd: null,
    });

    const nowMs = Date.now();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
    const cachedCanPersist = cacheEntry?.kind === 'success' && cacheEntry.cacheable !== false;
    if (cached && nowMs >= 0 && nowMs < cacheEntry!.expiresAt) {
      return await withProviderProjection(buildVoiceToolPreflightModelResult({
        shouldExposeAgentId,
        agentId,
        machineId,
        list: cached,
        limit,
      }));
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
        return await withProviderProjection(buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list,
          limit,
        }));
      }

      if (list && attempt?.cacheable === false && !cached) {
        writeDynamicModelProbeCacheTransientSuccess(cacheKey, list, commitNowMs);
        writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
        return await withProviderProjection(buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list,
          limit,
        }));
      }

      if (cached) {
        if (cachedCanPersist) {
          writeDynamicModelProbeCacheSuccess(cacheKey, cached, commitNowMs);
        }
        return await withProviderProjection(buildVoiceToolPreflightModelResult({
          shouldExposeAgentId,
          agentId,
          machineId,
          list: cached,
          limit,
        }));
      }

      writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
    }
  }

  if (isLegacyCompatProbe) {
    return await withProviderProjection({
      ...(shouldExposeAgentId ? { agentId } : {}),
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: supportsFreeformFallback,
      source: 'static' as const,
    });
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

  return await withProviderProjection({
    ...(shouldExposeAgentId ? { agentId } : {}),
    items: limit ? items.slice(0, limit) : items,
    supportsFreeform: supportsFreeformFallback,
    source: 'static' as const,
  });
}
