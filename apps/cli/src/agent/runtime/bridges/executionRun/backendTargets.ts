import { getBackendCatalogDefinition, legacyCustomAcpCompat, resolveAgentRoutingId, type AgentRoutingIdentityEntry } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { AgentExecutionTargetV1Schema, buildConfiguredAcpAgentSelectionV1, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { supportsAgentNativeFunctionTools } from '@happier-dev/protocol/plugins/contributions/agentSessionCapabilities';
import { BackendTargetKeyV2Schema, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, BackendTargetRefV2Input } from '@happier-dev/protocol';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveContributedAgentRoutingId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

type ExecutionRunAgentCatalog = ReturnType<typeof readAgentCatalogSnapshot>;
type ExecutionRunRoutingCatalog = Readonly<{ agentDefinitionsById: ReadonlyMap<string, AgentRoutingIdentityEntry> }>;

function readRequestedAgentTarget(
  input: BackendTargetRefV1 | BackendTargetRefV2Input,
): AgentExecutionTargetV1 | null {
  const agentTarget = AgentExecutionTargetV1Schema.safeParse(input);
  if (agentTarget.success) return agentTarget.data;

  if (typeof input !== 'string') return null;
  const keyedTarget = BackendTargetKeyV2Schema.safeParse(input);
  if (!keyedTarget.success) return null;
  const parsedTarget = parseBackendTargetKeyV2(keyedTarget.data);
  return parsedTarget.kind === 'agent' ? parsedTarget : null;
}

function resolveExecutionRunCanonicalBackendTargetKey(
  input: BackendTargetRefV1 | BackendTargetRefV2Input,
  catalog: ExecutionRunRoutingCatalog,
): string | null {
  const requestedAgentTarget = readRequestedAgentTarget(input);

  if (requestedAgentTarget) {
    // Comparing a complete identity does not admit an executable. A runner's
    // absent global catalog cannot invalidate its daemon-admitted Run target.
    return buildBackendTargetKeyV2(requestedAgentTarget);
  }

  try {
    const target = readBackendTargetRefV2(input);
    if (target.sourceKind !== 'configured' && !target.configuredBackendId) {
      const contribution = catalog.agentDefinitionsById.get(target.backendId);
      if (contribution?.identity) {
        return buildBackendTargetKeyV2({ kind: 'agent', identity: contribution.identity });
      }
    }
    return buildBackendTargetKeyV2(target);
  } catch {
    return null;
  }
}

/**
 * Lowers public identity to the runtime routing spelling, not executable
 * admission. The retained daemon snapshot admits the actual contribution;
 * a Session runner need not own an installed-plugin catalog to name it.
 */
export function resolveExecutionRunRuntimeBackendTarget(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
  catalog?: ExecutionRunRoutingCatalog,
): BackendTargetRefV1 | null {
  if (catalog) {
    const key = resolveExecutionRunCanonicalBackendTargetKey(backendTarget, catalog);
    const canonical = key ? readRequestedAgentTarget(key) : null;
    if (canonical && !canonical.definitionId) {
      const agentId = resolveAgentRoutingId(buildQualifiedPluginContributionKey(canonical.identity),
        catalog.agentDefinitionsById.values());
      if (agentId) return { kind: 'builtInAgent', agentId };
    }
  }
  const requestedAgentTarget = readRequestedAgentTarget(backendTarget);
  if (requestedAgentTarget) {
    try {
      // The Protocol compatibility owner knows bundled and configured refs.
      return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(requestedAgentTarget));
    } catch {
      // External Agents use exactly the projection owner's qualified spelling;
      // a bare localId is never an executable alias or an authority grant.
      return { kind: 'builtInAgent', agentId: resolveContributedAgentRoutingId({
        ...requestedAgentTarget.identity, provenance: 'external',
      }) };
    }
  }

  try {
    return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(backendTarget));
  } catch {
    return null;
  }
}

export function isExecutionRunConcreteBackendTarget(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): boolean {
  const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
  return !legacyCustomAcpCompat.isLegacyCustomAcpAgentId(canonicalBackendTarget.backendId);
}

export function resolveExecutionRunRuntimeBackendId(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): string {
  return resolveExecutionRunPublicBackendId(backendTarget);
}

/** Selects a fresh Run's Action carrier from its admitted Agent declaration. */
export function supportsExecutionRunNativeFunctionTools(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
  catalog: Pick<ExecutionRunAgentCatalog, 'agentDefinitionsById'> = readAgentCatalogSnapshot(),
): boolean {
  const target = resolveExecutionRunRuntimeBackendTarget(backendTarget);
  if (!target) return false;
  const identity = readRequestedAgentTarget(backendTarget)?.identity
    ?? (target.kind === 'configuredAcpBackend'
      ? buildConfiguredAcpAgentSelectionV1(target.backendId).agentTarget.identity : null);
  let contribution = identity ? undefined : catalog.agentDefinitionsById.get(
    resolveExecutionRunRuntimeBackendId(backendTarget),
  );
  if (identity) {
    for (const candidate of catalog.agentDefinitionsById.values()) {
      if (candidate.identity?.pluginId === identity.pluginId && candidate.identity.localId === identity.localId) {
        contribution = candidate;
        break;
      }
    }
  }
  return supportsAgentNativeFunctionTools({ sessions: readAgentSessionCapabilities(contribution?.richDefinition?.definition) });
}

/** The routing spelling of the one runtime lowering above, including external Agents. */
export function resolveExecutionRunPublicBackendId(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): string {
  const runtimeTarget = resolveExecutionRunRuntimeBackendTarget(backendTarget);
  if (!runtimeTarget) throw new Error('Invalid execution run backend target');
  return runtimeTarget.kind === 'configuredAcpBackend' ? runtimeTarget.backendId : runtimeTarget.agentId;
}

export function matchesExecutionRunLegacyBackendId(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
  backendId: string,
): boolean {
  const normalizedBackendId = String(backendId ?? '').trim();
  if (!normalizedBackendId) return false;

  const publicBackendId = resolveExecutionRunPublicBackendId(backendTarget);
  if (publicBackendId === normalizedBackendId) {
    const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
    if (canonicalBackendTarget.sourceKind === 'configured' && getBackendCatalogDefinition(normalizedBackendId)) {
      return false;
    }
    return true;
  }

  return readBackendTargetRefV2(backendTarget).sourceKind === 'configured'
    && legacyCustomAcpCompat.isLegacyCustomAcpAgentId(normalizedBackendId);
}

export function areExecutionRunBackendTargetsEqual(
  left: BackendTargetRefV1 | BackendTargetRefV2Input | null | undefined,
  right: BackendTargetRefV1 | BackendTargetRefV2Input | null | undefined,
): boolean {
  if (!left || !right) return false;
  const catalog = readAgentCatalogSnapshot();
  const leftKey = resolveExecutionRunCanonicalBackendTargetKey(left, catalog);
  const rightKey = resolveExecutionRunCanonicalBackendTargetKey(right, catalog);
  return leftKey !== null && leftKey === rightKey;
}
