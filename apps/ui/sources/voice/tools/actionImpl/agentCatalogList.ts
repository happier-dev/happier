import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';

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
    const res = await machineCapabilitiesInvoke(
      machineId,
      {
        id: `cli.${agentId}` as any,
        method: 'probeModels',
        params: { timeoutMs: 3500 },
      },
      { timeoutMs: 3500, ...(serverId ? { serverId } : {}) },
    );

    if (res.supported && res.response.ok) {
      const raw = res.response.result as any;
      const modelsRaw = raw?.availableModels;
      const supportsFreeformRaw = raw?.supportsFreeform;
      if (Array.isArray(modelsRaw) && modelsRaw.length > 0) {
        const dynamic = modelsRaw
          .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
          .map((m: any) => ({
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
          supportsFreeform: Boolean(supportsFreeformRaw),
          source: 'preflight' as const,
        };
      }
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
