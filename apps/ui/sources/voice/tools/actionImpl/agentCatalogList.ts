import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { buildBackendTargetKey, parseBackendTargetKey } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
  readDynamicModelProbeCache,
  runDynamicModelProbeDedupe,
  writeDynamicModelProbeCacheError,
  writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function titleCaseId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveBackendCatalogItemsForVoiceTool(params: Readonly<{
  includeDisabled: boolean;
}>): Array<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId?: string;
  subtitle?: string | null;
  experimental?: boolean;
  connectedServiceId?: string | null;
  connectedServiceName?: string | null;
  flavorAliases?: readonly string[];
  supportsModelSelection?: boolean;
  supportsFreeformModels?: boolean;
}> {
  const stateAny: any = storage.getState();
  const backendEnabledByTargetKey: Record<string, boolean> | null | undefined = stateAny?.settings?.backendEnabledByTargetKey ?? null;
  const acpCatalogSettingsV1 = stateAny?.settings?.acpCatalogSettingsV1 ?? { v: 2, backends: [] };
  const enabledBuiltInAgentIds = params.includeDisabled
    ? Array.from(AGENT_IDS)
    : Array.from(AGENT_IDS).filter((id) => backendEnabledByTargetKey?.[buildBackendTargetKey({ kind: 'builtInAgent', agentId: id })] !== false);

  return getResolvedBackendCatalogEntries({
    enabledAgentIds: enabledBuiltInAgentIds,
    acpCatalogSettingsV1,
    backendEnabledByTargetKey: params.includeDisabled ? undefined : backendEnabledByTargetKey,
  })
    .map((entry) => {
      const enabled = backendEnabledByTargetKey?.[entry.targetKey] !== false;
      if (!params.includeDisabled && !enabled) return null;

      if (entry.builtInAgentId) {
        const core = getAgentCore(entry.builtInAgentId);
        return {
          targetKey: entry.targetKey,
          label: entry.title || titleCaseId(entry.builtInAgentId),
          subtitle: entry.subtitle,
          enabled,
          agentId: entry.builtInAgentId,
          experimental: core.availability.experimental === true,
          connectedServiceId: core.connectedService.id,
          connectedServiceName: core.connectedService.name,
          flavorAliases: core.flavorAliases,
          supportsModelSelection: core.model.supportsSelection === true,
          supportsFreeformModels: core.model.supportsFreeform === true,
        };
      }

      return {
        targetKey: entry.targetKey,
        label: entry.title,
        subtitle: entry.subtitle,
        enabled,
        agentId: 'customAcp',
        experimental: false,
        connectedServiceId: null,
        connectedServiceName: null,
        flavorAliases: [],
        supportsModelSelection: true,
        supportsFreeformModels: true,
      };
    })
    .filter(Boolean) as Array<{
      targetKey: string;
      label: string;
      enabled: boolean;
      agentId?: string;
      subtitle?: string | null;
      experimental?: boolean;
      connectedServiceId?: string | null;
      connectedServiceName?: string | null;
      flavorAliases?: readonly string[];
      supportsModelSelection?: boolean;
      supportsFreeformModels?: boolean;
    }>;
}

export async function listAgentBackendsForVoiceTool(params: Readonly<{ includeDisabled?: boolean; limit?: number }>): Promise<unknown> {
  const includeDisabled = params.includeDisabled === true;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const items = resolveBackendCatalogItemsForVoiceTool({ includeDisabled });

  return { items: limit ? items.slice(0, limit) : items };
}

export async function listAgentModelsForVoiceTool(params: Readonly<{
  agentId?: string;
  machineId?: string;
  limit?: number;
  backendTargetKey?: string;
}>): Promise<unknown> {
  const backendTargetKey = normalizeId(params.backendTargetKey);
  let backendTarget: ReturnType<typeof parseBackendTargetKey> | null = null;
  if (backendTargetKey) {
    try {
      backendTarget = parseBackendTargetKey(backendTargetKey);
    } catch {
      return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }
  }
  const agentIdRaw = normalizeId(params.agentId)
    || (backendTarget?.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget?.kind === 'configuredAcpBackend' ? 'customAcp' : '');
  if (!agentIdRaw || !isAgentId(agentIdRaw)) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'builtInAgent' && agentIdRaw !== backendTarget.agentId) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (backendTarget && backendTarget.kind === 'configuredAcpBackend' && agentIdRaw !== 'customAcp') {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  if (agentIdRaw === 'customAcp' && !backendTarget) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: agentIdRaw };
  }
  const agentId = agentIdRaw as AgentId;
  const limitRaw = Number(params.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : null;
  const core = getAgentCore(agentId);
  if (core.model.supportsSelection !== true) {
    return {
      agentId,
      items: [{ modelId: 'default', label: 'Default' }].slice(0, limit ?? 1),
      supportsFreeform: false,
      source: 'static' as const,
    };
  }

  const machineId = normalizeId(params.machineId);
  if (machineId) {
    const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId,
      targetKey: backendTargetKey || buildBackendTargetKey({ kind: 'builtInAgent', agentId }),
      serverId,
      cwd: null,
    });

    const nowMs = Date.now();
    const cacheEntry = cacheKey ? readDynamicModelProbeCache(cacheKey) : null;
    const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
    if (cached && nowMs >= 0 && nowMs < cacheEntry!.expiresAt) {
      const dynamic = cached.availableModels.map((m) => ({
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
        agentId,
        machineId,
        items: limit ? items.slice(0, limit) : items,
        supportsFreeform: cached.supportsFreeform === true,
        source: 'preflight' as const,
      };
    }

    if (cacheKey) {
      const attempt = await runDynamicModelProbeDedupe<Readonly<{
        list: PreflightModelList;
        cacheable: boolean;
      }> | null>(cacheKey, async () => {
        const res = await machineCapabilitiesInvoke(
          machineId,
          {
            id: `cli.${agentId}` as any,
            method: 'probeModels',
            params: {
              timeoutMs: 15_000,
              ...(backendTarget ? { backendTarget } : {}),
            },
          },
          { ...(serverId ? { serverId } : {}) },
        );

        if (!res.supported) return null;
        if (!res.response.ok) return null;

        const list = parsePreflightModelListFromProbeModelsResult(res.response.result);
        if (!list) return null;
        const result = res.response.result;
        const source = result && typeof result === 'object' && !Array.isArray(result)
          ? (typeof (result as Record<string, unknown>).source === 'string' ? (result as Record<string, unknown>).source : null)
          : null;
        const cacheable = source !== 'static';
        return { list, cacheable };
      });

      const commitNowMs = Date.now();
      const list = attempt?.list ?? null;
      if (list && attempt?.cacheable !== false) {
        writeDynamicModelProbeCacheSuccess(cacheKey, list, commitNowMs);
        const dynamic = list.availableModels.map((m) => ({
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
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: list.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      if (list && attempt?.cacheable === false && !cached) {
        writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
        const dynamic = list.availableModels.map((m) => ({
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
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: list.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      if (cached) {
        writeDynamicModelProbeCacheSuccess(cacheKey, cached, commitNowMs);
        const dynamic = cached.availableModels.map((m) => ({
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
          agentId,
          machineId,
          items: limit ? items.slice(0, limit) : items,
          supportsFreeform: cached.supportsFreeform === true,
          source: 'preflight' as const,
        };
      }

      writeDynamicModelProbeCacheError(cacheKey, commitNowMs);
    }
  }

  const seen = new Set<string>();
  const items = [
    { modelId: 'default', label: 'Default' },
    ...getAgentStaticModels(agentId).map((model) => ({
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
    agentId,
    items: limit ? items.slice(0, limit) : items,
    supportsFreeform: core.model.supportsFreeform === true,
    source: 'static' as const,
  };
}
