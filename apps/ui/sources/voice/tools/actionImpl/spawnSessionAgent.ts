import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import type { AgentId } from '@/agents/catalog/catalog';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2, type BackendTargetRefV2Input, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { agentRoutingIdAddressesContributionIdentityV1, buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';

import { isBundledAgentId } from '@/agents/registry/registryCore';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';

import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';

/**
 * The one operational backend target for a selected Agent.
 *
 * A qualified Agent selection is routed through the host catalog, which owns
 * the identity→routing-id projection. When no current projection names it, the
 * qualified contribution key is itself a lossless routing id — the canonical
 * key owner maps `backend:<pluginId>/<localId>` straight back to the identity —
 * so the selection is preserved rather than collapsed or dropped.
 */
function resolveOperationalBackendTarget(
  target: PersistedBackendTargetRefV2,
  daemonMergedProjectionInputs?: DaemonMergedProjectionInputs | null,
): BackendTargetRefV2 {
  return resolveOperationalBackendTargetForAgentSelection({
    backendTarget: target,
    mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById,
  }) ?? {
    kind: 'backend',
    backendId: target.kind === 'agent'
      ? buildQualifiedPluginContributionKey(target.identity)
      : target.backendId,
  };
}

/**
 * Reads a requested target key without requiring host catalog resolution, so a
 * qualified external Agent keeps its exact `{ pluginId, localId }` identity
 * instead of failing closed on the Protocol reader's bundled-only mapping.
 */
function readRequestedBackendTarget(backendTargetKey: string): PersistedBackendTargetRefV2 {
  const canonicalKey = BackendTargetKeyV2Schema.safeParse(backendTargetKey);
  return canonicalKey.success
    ? parseBackendTargetKeyV2(canonicalKey.data)
    : readBackendTargetRefV2(backendTargetKey as BackendTargetRefV2Input);
}

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
    acpCatalogSnapshot: getAcpCatalogSnapshot(state?.settingsScope)?.catalog,
    daemonMergedProjectionInputs: opts?.daemonMergedProjectionInputs ?? null,
  });
  return resolveOperationalBackendTarget(preferredTarget, opts?.daemonMergedProjectionInputs);
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
  // Set only when the request named a qualified Agent contribution outright.
  // That key already carries the exact routing authority, so its validation and
  // its operational projection are both owned above rather than re-derived from
  // the flat backend id below.
  let requestedAgentIdentity: PluginContributionIdentityV1 | null = null;
  if (requestedBackendTargetKey) {
    try {
      const requestedTarget = readRequestedBackendTarget(requestedBackendTargetKey);
      requestedAgentIdentity = requestedTarget.kind === 'agent' ? requestedTarget.identity : null;
      const canonicalBackendTarget = resolveOperationalBackendTarget(
        requestedTarget,
        params.daemonMergedProjectionInputs ?? null,
      );
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
      } else if (requestedAgentIdentity) {
        // A qualified key names the Agent exactly. An accompanying Agent id is
        // accepted only when it addresses that same identity — its projected
        // routing id, its local id, or the qualified key itself.
        if (
          requestedAgentId
          && requestedAgentId !== canonicalBackendTarget.backendId
          && !agentRoutingIdAddressesContributionIdentityV1(requestedAgentId, requestedAgentIdentity)
        ) {
          return {
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'invalid_parameters',
            agentId: requestedAgentId,
            backendTargetKey: requestedBackendTargetKey,
          };
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

  if (parsedBackendTarget && requestedAgentId && !requestedAgentIdentity) {
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

  try {
    return {
      ok: true,
      backendTarget: resolveSpawnBackendTargetFromState(params.state, {
        daemonMergedProjectionInputs: params.daemonMergedProjectionInputs ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'acp_catalog_unavailable') {
      return { ok: false, errorCode: 'acp_catalog_unavailable', errorMessage: 'acp_catalog_unavailable' };
    }
    throw error;
  }
}
