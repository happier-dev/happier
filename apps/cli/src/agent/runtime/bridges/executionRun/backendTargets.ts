import { getBackendCatalogDefinition, legacyCustomAcpCompat } from '@happier-dev/agents';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { BackendTargetKeyV2Schema, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, BackendTargetRefV2Input } from '@happier-dev/protocol';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

type ExecutionRunAgentCatalog = ReturnType<typeof readAgentCatalogSnapshot>;

function readRequestedAgentIdentity(
  input: BackendTargetRefV1 | BackendTargetRefV2Input,
): Readonly<{ pluginId: string; localId: string }> | null {
  const agentTarget = AgentExecutionTargetV1Schema.safeParse(input);
  if (agentTarget.success) return agentTarget.data.identity;

  if (typeof input !== 'string') return null;
  const keyedTarget = BackendTargetKeyV2Schema.safeParse(input);
  if (!keyedTarget.success) return null;
  const parsedTarget = parseBackendTargetKeyV2(keyedTarget.data);
  return parsedTarget.kind === 'agent' ? parsedTarget.identity : null;
}

function resolveExecutionRunAgentRoutingId(
  identity: Readonly<{ pluginId: string; localId: string }>,
  catalog: ExecutionRunAgentCatalog,
): string | null {
  for (const [routingId, contribution] of catalog.agentDefinitionsById) {
    if (
      contribution.identity?.pluginId === identity.pluginId
      && contribution.identity.localId === identity.localId
    ) return routingId;
  }
  return null;
}

function resolveExecutionRunCanonicalBackendTargetKey(
  input: BackendTargetRefV1 | BackendTargetRefV2Input,
  catalog: ExecutionRunAgentCatalog,
): string | null {
  const requestedAgentIdentity = readRequestedAgentIdentity(input);

  if (requestedAgentIdentity) {
    const routingId = resolveExecutionRunAgentRoutingId(requestedAgentIdentity, catalog);
    const contribution = routingId ? catalog.agentDefinitionsById.get(routingId) : null;
    return contribution?.identity
      ? buildBackendTargetKeyV2({ kind: 'agent', identity: contribution.identity })
      : null;
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
 * Resolves the stable public Agent identity against the one current plugin
 * catalog, then lowers it to the execution-run runtime's retained V1 target.
 * A missing identity fails closed instead of being guessed from localId.
 */
export function resolveExecutionRunRuntimeBackendTarget(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): BackendTargetRefV1 | null {
  const requestedAgentIdentity = readRequestedAgentIdentity(backendTarget);
  if (requestedAgentIdentity) {
    const routingId = resolveExecutionRunAgentRoutingId(
      requestedAgentIdentity,
      readAgentCatalogSnapshot(),
    );
    return routingId
      ? { kind: 'builtInAgent', agentId: routingId }
      : null;
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

export function resolveExecutionRunPublicBackendId(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): string {
  const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
  return canonicalBackendTarget.sourceKind === 'configured'
    ? canonicalBackendTarget.configuredBackendId ?? canonicalBackendTarget.backendId
    : canonicalBackendTarget.backendId;
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
