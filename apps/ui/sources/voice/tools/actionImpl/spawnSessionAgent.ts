import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import { readBackendTargetRefV2, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { isAgentId } from '@/agents/registry/registryCore';

import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolvePreferredBackendTargetFromSettings } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromSettings';

export function resolveSpawnBackendTargetFromState(state: any): BackendTargetRefV1 {
  const settings = state?.settings ?? {};
  return resolvePreferredBackendTargetFromSettings({
    lastUsedAgent: settings.lastUsedAgent,
    lastUsedBackendTarget: settings.lastUsedBackendTarget,
    defaultBuiltInAgentId: DEFAULT_AGENT_ID as AgentId,
    backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
    acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
  });
}

export function resolveSpawnAgentIdFromState(state: any): AgentId {
  const backendTarget = resolveSpawnBackendTargetFromState(state);
  return resolvePersistedAgentIdForBackendTarget({
    backendTarget,
    persistedAgentId: state?.settings?.lastUsedAgent,
    selectedBuiltInAgentId: DEFAULT_AGENT_ID as AgentId,
  });
}

export function resolveVoiceToolSpawnBackendTarget(params: Readonly<{
  state: any;
  agentId?: string | null;
  backendTargetKey?: string | null;
}>):
  | Readonly<{ ok: true; backendTarget: BackendTargetRefV1 }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; agentId?: string; backendTargetKey?: string }> {
  const requestedAgentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
  const requestedBackendTargetKey = typeof params.backendTargetKey === 'string' ? params.backendTargetKey.trim() : '';

  if (requestedAgentId && !isAgentId(requestedAgentId)) {
    return { ok: false, errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }

  let parsedBackendTarget: BackendTargetRefV1 | null = null;
  if (requestedBackendTargetKey) {
    try {
      const canonicalBackendTarget = readBackendTargetRefV2(requestedBackendTargetKey);
      parsedBackendTarget = canonicalBackendTarget.sourceKind === 'configured'
        ? { kind: 'configuredAcpBackend', backendId: canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId }
        : { kind: 'builtInAgent', agentId: canonicalBackendTarget.backendId };
    } catch {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        errorMessage: 'invalid_parameters',
        ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
      };
    }
  }

  if (parsedBackendTarget && requestedAgentId) {
    const derivedAgentId = parsedBackendTarget.kind === 'builtInAgent' ? parsedBackendTarget.agentId : 'customAcp';
    if (requestedAgentId !== derivedAgentId) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        errorMessage: 'invalid_parameters',
        agentId: requestedAgentId,
        ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
      };
    }
  }

  if (requestedAgentId === 'customAcp' && !parsedBackendTarget) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: requestedAgentId };
  }

  if (parsedBackendTarget) {
    return { ok: true, backendTarget: parsedBackendTarget };
  }

  if (requestedAgentId) {
    return { ok: true, backendTarget: { kind: 'builtInAgent', agentId: requestedAgentId as AgentId } };
  }

  return { ok: true, backendTarget: resolveSpawnBackendTargetFromState(params.state) };
}
