import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import {
    readBackendTargetRefV2,
    readLegacyConfiguredAcpBackendId,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { isAgentId } from '@/agents/registry/registryCore';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';

import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

export function resolveSpawnBackendTargetFromState(
  state: any,
  opts?: Readonly<{ daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null }>,
): BackendTargetRefV2 {
  const settings = state?.settings ?? {};
  return resolvePreferredBackendTargetFromProjection({
    lastUsedAgent: settings.lastUsedAgent,
    lastUsedBackendTarget: settings.lastUsedBackendTarget,
    defaultBuiltInAgentId: DEFAULT_AGENT_ID as AgentId,
    backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
    acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
    daemonMergedProjectionInputs: opts?.daemonMergedProjectionInputs ?? null,
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
  daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null;
}>):
  | Readonly<{ ok: true; backendTarget: BackendTargetRefV2 }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; agentId?: string; backendTargetKey?: string }> {
  const requestedAgentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
  const requestedBackendTargetKey = typeof params.backendTargetKey === 'string' ? params.backendTargetKey.trim() : '';
  const requestedConfiguredCompatBackendId = readLegacyConfiguredAcpBackendId(requestedAgentId);

  const isLegacyCompatCarrier = isLegacyCompatAgentType(requestedAgentId) || Boolean(requestedConfiguredCompatBackendId);

  if (requestedAgentId && !isAgentId(requestedAgentId) && !isLegacyCompatCarrier) {
    return { ok: false, errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }

  let parsedBackendTarget: BackendTargetRefV2 | null = null;
  if (requestedBackendTargetKey) {
    try {
      const canonicalBackendTarget = readBackendTargetRefV2(requestedBackendTargetKey);
      const isConfiguredTarget = Boolean(canonicalBackendTarget.configuredBackendId);
      const isCanonicalBackendKey = requestedBackendTargetKey.startsWith('backend:');
      const requiresExplicitRuntimeCarrier =
        isCanonicalBackendKey
        && !isConfiguredTarget
        && !isAgentId(canonicalBackendTarget.backendId);

      if (isConfiguredTarget) {
        const configuredBackendId = canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId;
        const isMatchingConfiguredCompatCarrier = requestedConfiguredCompatBackendId === configuredBackendId;
        // Configured backend targets must not accept the bare legacy `customAcp` carrier (or any other
        // non-matching id). Only the explicit compat-encoded configured carrier (`acp:<backendId>`)
        // is accepted as ingress, and only when it matches the configured backend id.
        if (requestedAgentId) {
          if (!requestedConfiguredCompatBackendId || !isMatchingConfiguredCompatCarrier) {
            return {
              ok: false,
              errorCode: 'invalid_parameters',
              errorMessage: 'invalid_parameters',
              agentId: requestedAgentId,
              backendTargetKey: requestedBackendTargetKey,
            };
          }
        }
        parsedBackendTarget = canonicalBackendTarget;
      } else {
        if (!requiresExplicitRuntimeCarrier && requestedAgentId && requestedAgentId !== canonicalBackendTarget.backendId) {
          return {
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'invalid_parameters',
            agentId: requestedAgentId,
            ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
          };
        }
        parsedBackendTarget = canonicalBackendTarget;
      }
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
    if (parsedBackendTarget.configuredBackendId) {
      const configuredBackendId = parsedBackendTarget.configuredBackendId ?? parsedBackendTarget.backendId;
      // For configured backends, accept only the explicit compat-encoded configured carrier.
      if (requestedConfiguredCompatBackendId !== configuredBackendId) {
        return {
          ok: false,
          errorCode: 'invalid_parameters',
          errorMessage: 'invalid_parameters',
          agentId: requestedAgentId,
          ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
        };
      }
    } else if (!isAgentId(parsedBackendTarget.backendId)) {
      // For non-built-in backends, the caller must supply an explicit runtime carrier agent id.
      if (!isAgentId(requestedAgentId) || isLegacyCompatAgentType(requestedAgentId)) {
        return {
          ok: false,
          errorCode: 'invalid_parameters',
          errorMessage: 'invalid_parameters',
          ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
        };
      }
    } else if (requestedAgentId !== parsedBackendTarget.backendId) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        errorMessage: 'invalid_parameters',
        agentId: requestedAgentId,
        ...(requestedBackendTargetKey ? { backendTargetKey: requestedBackendTargetKey } : {}),
      };
    }
  }

  if ((isLegacyCompatAgentType(requestedAgentId) || requestedConfiguredCompatBackendId) && !parsedBackendTarget) {
    return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', agentId: requestedAgentId };
  }

  if (parsedBackendTarget) {
    return { ok: true, backendTarget: parsedBackendTarget };
  }

  if (requestedAgentId) {
    return { ok: true, backendTarget: { kind: 'backend', backendId: requestedAgentId } };
  }

  return {
    ok: true,
    backendTarget: resolveSpawnBackendTargetFromState(params.state, {
      daemonMergedProjectionInputs: params.daemonMergedProjectionInputs ?? null,
    }),
  };
}
