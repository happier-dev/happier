import { getBackendCatalogDefinition, legacyCustomAcpCompat } from '@happier-dev/agents';
import {
  AgentExecutionTargetV1Schema,
  BackendTargetKeyV2Schema,
  buildBackendTargetKeyV2,
  parseQualifiedPluginContributionKey,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

function resolveExecutionRunCanonicalBackendTargetKey(
  input: BackendTargetRefV1 | BackendTargetRefV2Input,
  catalog: ReturnType<typeof readAgentCatalogSnapshot>,
): string | null {
  const agentTarget = AgentExecutionTargetV1Schema.safeParse(input);
  const keyedTarget = typeof input === 'string'
    ? BackendTargetKeyV2Schema.safeParse(input)
    : null;
  const keyedAgentIdentity = keyedTarget?.success && keyedTarget.data.startsWith('agent:')
    ? parseQualifiedPluginContributionKey(keyedTarget.data.slice('agent:'.length))
    : null;
  const requestedAgentIdentity = agentTarget.success ? agentTarget.data.identity : keyedAgentIdentity;

  if (requestedAgentIdentity) {
    const contribution = [...catalog.agentDefinitionsById.values()].find(
      (candidate) => candidate.identity?.pluginId === requestedAgentIdentity.pluginId
        && candidate.identity.localId === requestedAgentIdentity.localId,
    );
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
