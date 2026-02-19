import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
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

export async function listAgentBackendsForVoiceTool(params: Readonly<{ includeDisabled?: boolean }>): Promise<unknown> {
  const includeDisabled = params.includeDisabled === true;
  const stateAny: any = storage.getState();
  const backendEnabledById: Record<string, boolean> | null | undefined = stateAny?.settings?.backendEnabledById ?? null;
  const ids = Array.from(AGENT_IDS).filter((id) => includeDisabled || backendEnabledById?.[id] !== false);

  const items = ids.map((id) => {
    const core = getAgentCore(id);
    const enabled = backendEnabledById?.[id] !== false;
    return {
      agentId: id,
      label: titleCaseId(id),
      enabled,
      experimental: core.availability.experimental === true,
      connectedServiceId: core.connectedService.id,
      connectedServiceName: core.connectedService.name,
      flavorAliases: core.flavorAliases,
      supportsModelSelection: core.model.supportsSelection === true,
      supportsFreeformModels: core.model.supportsFreeform === true,
    };
  });

  return { items };
}

export async function listAgentModelsForVoiceTool(params: Readonly<{ agentId: string; machineId?: string }>): Promise<unknown> {
  const agentIdRaw = normalizeId(params.agentId);
  if (!agentIdRaw || !isAgentId(agentIdRaw)) {
    return { ok: false, errorCode: 'unknown_agent', errorMessage: 'unknown_agent', agentId: agentIdRaw };
  }
  const agentId = agentIdRaw as AgentId;
  const core = getAgentCore(agentId);
  if (core.model.supportsSelection !== true) {
    return { agentId, items: [{ modelId: 'default', label: 'default' }], supportsFreeform: false, source: 'static' as const };
  }

  const machineId = normalizeId(params.machineId);
  if (machineId) {
    const serverId = normalizeId(getActiveServerSnapshot()?.serverId) || null;
    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId,
      agentType: agentId,
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

      const withDefault = [{ modelId: 'default', label: 'default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
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
        items,
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

        const withDefault = [{ modelId: 'default', label: 'default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
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
          items,
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
        const withDefault = [{ modelId: 'default', label: 'default' }, ...dynamic.filter((m) => m.modelId !== 'default')];
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
          items,
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
  }).map((modelId) => ({ modelId, label: modelId }));

  return { agentId, items, supportsFreeform: core.model.supportsFreeform === true, source: 'static' as const };
}
