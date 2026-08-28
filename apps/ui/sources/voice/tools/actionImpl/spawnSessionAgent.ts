import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import {
    buildQualifiedPluginContributionKey,
    readBackendTargetRefV2,
    readLegacyConfiguredAcpBackendId,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { isBundledAgentId } from '@/agents/registry/registryCore';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';

import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export function resolveSpawnBackendTargetFromState(
  state: any,
  opts?: Readonly<{ daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null }>,
): BackendTargetRefV2 {
  const settings = state?.settings ?? {};
  const preferredTarget = resolvePreferredBackendTargetFromProjection({
    lastUsedAgent: settings.lastUsedAgent,
    lastUsedBackendTarget: settings.lastUsedBackendTarget,
    defaultBuiltInAgentId: DEFAULT_AGENT_ID as AgentId,
    backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
    acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
    daemonMergedProjectionInputs: opts?.daemonMergedProjectionInputs ?? null,
  });
  return resolveOperationalBackendTargetForAgentSelection({
    backendTarget: preferredTarget,
    mergedProviderProjectionById: opts?.daemonMergedProjectionInputs?.mergedProviderProjectionById,
  }) ?? {
    kind: 'backend',
    backendId: preferredTarget.kind === 'agent'
      ? buildQualifiedPluginContributionKey(preferredTarget.identity)
      : preferredTarget.backendId,
  };
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

  // Agent identity is open: an installed Agent legitimately carries an id outside the bundled
  // set, so existence is decided by the daemon that owns the installed catalog, never by
  // `isBundledAgentId` here. This resolver only checks that the requested id and an explicit
  // backend target key describe the same target.
  let parsedBackendTarget: BackendTargetRefV2 | null = null;
  if (requestedBackendTargetKey) {
    try {
      const canonicalBackendTarget = readBackendTargetRefV2(requestedBackendTargetKey);
      const isConfiguredTarget = Boolean(canonicalBackendTarget.configuredBackendId);
      const isCanonicalBackendKey = requestedBackendTargetKey.startsWith('backend:');
      const requiresExplicitRuntimeCarrier =
        isCanonicalBackendKey
        && !isConfiguredTarget
        && !isBundledAgentId(canonicalBackendTarget.backendId);

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
    } else if (!isBundledAgentId(parsedBackendTarget.backendId)) {
      // A non-bundled backend either runs itself — an installed Agent whose id IS the backend id —
      // or is carried by an explicit bundled runtime carrier Agent. `isBundledAgentId` selects the
      // carrier form; it never decides whether the installed Agent exists.
      const runsItself = requestedAgentId === parsedBackendTarget.backendId;
      const hasBundledRuntimeCarrier =
        isBundledAgentId(requestedAgentId) && !isLegacyCompatAgentType(requestedAgentId);
      if (!runsItself && !hasBundledRuntimeCarrier) {
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

  if (isLegacyCompatCarrier && !parsedBackendTarget) {
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
