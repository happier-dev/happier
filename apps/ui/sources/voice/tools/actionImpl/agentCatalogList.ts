import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { buildBackendTargetKey } from '@happier-dev/protocol';
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

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function titleCaseId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function humanizeModelLabel(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  if (trimmed === 'default') return 'Default';
  const dottedVersions = trimmed.replace(/(\d)[-_](\d)/g, '$1.$2');
  const words = dottedVersions
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return trimmed;
  return words
    .map((word) => {
      if (/^\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
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

export async function listAgentModelsForVoiceTool(params: Readonly<{ agentId: string; machineId?: string; limit?: number }>): Promise<unknown> {
  const agentIdRaw = normalizeId(params.agentId);
  if (!agentIdRaw || !isAgentId(agentIdRaw)) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
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
      targetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId }),
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
      const list = await runDynamicModelProbeDedupe(cacheKey, async () => {
        const res = await machineCapabilitiesInvoke(
          machineId,
          {
            id: `cli.${agentId}` as any,
            method: 'probeModels',
            params: { timeoutMs: 15_000 },
          },
          { ...(serverId ? { serverId } : {}) },
        );

        if (!res.supported) return null;
        if (!res.response.ok) return null;

        const raw = res.response.result as any;
        const modelsRaw = raw?.availableModels;
        const supportsFreeformRaw = raw?.supportsFreeform;
        if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) return null;

        const parsed = {
          availableModels: modelsRaw
            .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m: any) => ({
              id: String(m.id),
              name: String(m.name),
              ...(typeof m.description === 'string' ? { description: m.description } : {}),
            })),
          supportsFreeform: Boolean(supportsFreeformRaw),
        };
        if (parsed.availableModels.length === 0) return null;
        return parsed;
      });

      const commitNowMs = Date.now();
      if (list) {
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

  const allowed = ['default', ...core.model.allowedModes].map((m) => String(m));
  const seen = new Set<string>();
  const items = allowed.filter((m) => {
    const id = m.trim();
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((modelId) => ({ modelId, label: humanizeModelLabel(modelId) }));

  return {
    agentId,
    items: limit ? items.slice(0, limit) : items,
    supportsFreeform: core.model.supportsFreeform === true,
    source: 'static' as const,
  };
}
