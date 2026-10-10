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
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export async function listReviewEnginesForVoiceTool(params: Readonly<{ sessionId: string | null; machineId?: string; includeDisabled?: boolean; scope?: 'paths'; serverId?: string; acpCatalogSnapshot?: AcpCatalogSnapshotV1; backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null }>): Promise<unknown> {
  const detached = params.sessionId === null;
  const sessionId = normalizeId(params.sessionId) || null;
  if (!sessionId && !detached) {
    return { ok: false, errorCode: 'session_not_selected', errorMessage: 'session_not_selected' };
  }

  const state = storage.getState();
  const session = sessionId ? resolveVoiceContextSessionFromState(sessionId, state) : null;
  const machineId = detached ? normalizeId(params.machineId)
    : normalizeId(sessionId ? readMachineTargetForSession(sessionId)?.machineId : null)
      || normalizeId(session ? readSessionOwnerMetadataView(session)?.machineId : null);
  if (detached && !machineId) return { ok: false, errorCode: 'machine_not_selected', errorMessage: 'machine_not_selected' };
  if (detached && !normalizeId(params.serverId)) return { ok: false, errorCode: 'server_not_selected', errorMessage: 'server_not_selected' };
  const preferredServerId = sessionId ? resolveSessionListPreferredServerIdFromState(state, sessionId) : null;
  if (params.serverId && preferredServerId && !areServerProfileIdentifiersEquivalent(params.serverId, preferredServerId)) {
    return { ok: false, errorCode: 'action_account_scope_changed', errorMessage: 'action_account_scope_changed' };
  }
  const serverId = (
    params.serverId ?? preferredServerId
    ?? normalizeId(getActiveServerSnapshot()?.serverId)
  ) || null;
  const scopedCatalog = state.settingsScope && serverId && areServerProfileIdentifiersEquivalent(state.settingsScope.serverId, serverId)
    ? getAcpCatalogSnapshot(state.settingsScope)?.catalog : null;
  const acpCatalogSnapshot = params.acpCatalogSnapshot ?? scopedCatalog;
  if (!acpCatalogSnapshot || acpCatalogSnapshot.status !== 'ready') {
    return { ok: false, errorCode: 'acp_catalog_unavailable', errorMessage: acpCatalogSnapshot && acpCatalogSnapshot.status !== 'loading' ? acpCatalogSnapshot.reason : 'loading' };
  }
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
    acpCatalogSnapshot,
    mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
    mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    discoveredBackendIds: daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
  });
  const labelByAgentId = new Map<string, string>(
    resolvedBackendEntries
      .filter((entry) => typeof entry.backendId === 'string' && entry.backendId.trim().length > 0)
      .flatMap((entry) => [[String(entry.backendId), entry.title] as const, [entry.backendTargetKey, entry.title] as const]),
  );
  const enabledTargetKeyByEngineId = new Map<string, string>(
    resolvedBackendEntries
      .filter((entry) => typeof entry.backendId === 'string' && entry.backendId.trim().length > 0)
      .map((entry) => [
        String(entry.backendId),
        entry.backendTargetKey,
      ] as const),
  );

  const backendEnabledByTargetKey = params.backendEnabledByTargetKey === undefined ? state.settings?.backendEnabledByTargetKey ?? null : params.backendEnabledByTargetKey;
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
