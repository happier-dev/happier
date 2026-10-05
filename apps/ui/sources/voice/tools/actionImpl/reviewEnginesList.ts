import { AGENT_IDS } from '@/agents/catalog/catalog';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getMachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { storage } from '@/sync/domains/state/storage';
import { buildAvailableReviewEngineOptions, resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export async function listReviewEnginesForVoiceTool(params: Readonly<{ sessionId: string | null; includeDisabled?: boolean; scope?: 'paths' }>): Promise<unknown> {
  const sessionId = normalizeId(params.sessionId);
  if (!sessionId) {
    return { ok: false, errorCode: 'session_not_selected', errorMessage: 'session_not_selected' };
  }

  const state: any = storage.getState();
  const session = resolveVoiceContextSessionFromState(sessionId, state);
  const machineId = normalizeId(readMachineTargetForSession(sessionId)?.machineId)
    || normalizeId(session ? readSessionOwnerMetadataView(session)?.machineId : null);
  const serverId = (
    resolveSessionListPreferredServerIdFromState(state, sessionId)
    ?? normalizeId(getActiveServerSnapshot()?.serverId)
  ) || null;
  const machineCapabilitiesState = machineId ? getMachineCapabilitiesSnapshot(machineId, serverId) : null;
  const executionRunsBackends = extractExecutionRunsBackendsFromMachineCapabilitiesState(
    machineCapabilitiesState ? { snapshot: machineCapabilitiesState } : null,
  );

  const daemonMergedProjectionInputs = machineId
    ? await (async () => {
      const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId });
      if (!inputs) return null;
      return {
        mergedProviderProjectionById: inputs.mergedProviderProjectionById,
        mergedBackendProjectionById: inputs.mergedBackendProjectionById,
        discoveredBackendIds: inputs.discoveredBackendIds,
        pluginProjectionV2: inputs.pluginProjectionV2,
      };
    })()
    : null;

  const resolvedBackendEntries = getResolvedBackendCatalogEntries({
    enabledAgentIds: Array.from(AGENT_IDS),
    acpCatalogSettingsV1: state?.settings?.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
    mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
    mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    discoveredBackendIds: daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
  });
  const labelByAgentId = new Map<string, string>(
    resolvedBackendEntries
      .filter((entry) => entry.kind !== 'configuredBackend' && typeof entry.backendId === 'string' && entry.backendId.trim().length > 0)
      .map((entry) => [String(entry.backendId), entry.title] as const),
  );
  const enabledTargetKeyByEngineId = new Map<string, string>(
    resolvedBackendEntries
      .filter((entry) => typeof entry.backendId === 'string' && entry.backendId.trim().length > 0)
      .map((entry) => [
        String(entry.backendId),
        entry.backendTargetKey,
      ] as const),
  );

  const backendEnabledByTargetKey: Record<string, boolean> | null | undefined = state?.settings?.backendEnabledByTargetKey ?? null;
  const includeDisabled = params.includeDisabled === true;
  const agentIds = includeDisabled
    ? Array.from(AGENT_IDS)
    : Array.from(AGENT_IDS).filter((id) => backendEnabledByTargetKey?.[resolveBackendTargetKeyV2({ kind: 'backend', backendId: id })] !== false);
  const items = buildAvailableReviewEngineOptions({
    enabledAgentIds: agentIds,
    executionRunsBackends,
    scope: params.scope,
    resolveAgentLabel: (agentId) => labelByAgentId.get(agentId) ?? agentId,
  })
    .map((item) => {
      const defaultTargetKey = resolveBackendTargetKeyV2(resolveReviewEngineTarget(item.id));
      const effectiveTargetKey = enabledTargetKeyByEngineId.get(item.id) ?? defaultTargetKey;
      const currentAgent = readCurrentProjectedAgentCapabilities({
        projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        agentId: item.id,
      });
      return {
        engineId: item.id,
        label: labelByAgentId.get(item.id) ?? item.label,
        enabled: item.disabled !== true && backendEnabledByTargetKey?.[effectiveTargetKey] !== false,
        capabilities: { structuredNarration: currentAgent?.capabilities.structuredOutput?.formats.includes('json') === true },
      };
    })
    .filter((item) => includeDisabled || item.enabled);

  return { sessionId, items };
}
