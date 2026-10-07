import { AGENT_IDS, getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { AgentsBackendsListOutputSchema, type AgentsBackendsListOutput } from '@happier-dev/protocol/actions/agentBackendInventory';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import { providerCatalogPermitsUnlistedModelIdV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { readProviderSettingsFromAccountSettingsV1 } from '@happier-dev/protocol/providers/settings/readFromAccountSettingsV1';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import {
    getAgentStaticModels,
} from '@happier-dev/agents';
import {
    isLegacyCompatAgentType,
    LEGACY_COMPAT_PRIMARY_AGENT_ID,
} from '@/agents/backendCatalog/legacyCompatAgents';
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
import { discoverMachineModels } from '@/sync/ops/modelDiscovery';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { createUnavailablePreflightModelList, type PreflightModelList } from '@/sync/domains/models/modelOptions';
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
  refreshError?: true;
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
    const providerConnectionId = ref && 'providerConnectionId' in ref
      ? ref.providerConnectionId
      : null;
    return [{
      modelId,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      providerConnectionId,
      ...(providerConnectionId
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
    ...(params.base.refreshError ? { refreshError: true as const } : {}),
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
      const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId });
      if (!inputs) return null;
      return {
        mergedProviderProjectionById: inputs.mergedProviderProjectionById,
        mergedBackendProjectionById: inputs.mergedBackendProjectionById,
        discoveredBackendIds: inputs.discoveredBackendIds,
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
  const selection = resolveActionBackendTargetSelection({
    agentId: normalizeId(params.agentId) || undefined,
    backendTargetKey: backendTargetKey || undefined,
  });
  if (!selection.ok) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
  }
  const backendTarget = selection.selection.backendTarget;
  const providedAgentId = selection.selection.agentId ?? '';
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
  const supportsSelection = bundledCore?.model?.supportsSelection !== false;
  const supportsFreeformFallback = bundledCore?.model?.supportsFreeform === true;

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
  const canonicalTargetKey = selection.selection.backendTargetKey
    ?? (backendTarget
      ? resolveBackendTargetKeyV2(backendTarget)
      : resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId }));
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

    if (cacheKey && bundledCore?.model?.dynamicProbe !== 'static-only') {
      const entry = await discoverMachineModels({
        cacheKey,
        agentType: backendTarget?.kind === 'configuredAcpBackend' ? CONFIGURED_ACP_CLI_CAPABILITY_ID : agentId,
        machineId,
        serverId,
        backendTarget,
        capabilityParams: { timeoutMs: 15_000 },
      });
      const failed = entry?.kind === 'error' || (entry?.kind === 'success' && entry.errorUpdatedAt !== undefined);
      const list = entry?.kind === 'success' ? entry.value : createUnavailablePreflightModelList();
      return await withProviderProjection({
        ...buildVoiceToolPreflightModelResult({ shouldExposeAgentId, agentId, machineId, list, limit }),
        ...(failed ? { refreshError: true as const } : {}),
      });
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
