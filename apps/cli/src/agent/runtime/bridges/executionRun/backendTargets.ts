import { getBackendCatalogDefinition, isAgentId, legacyCustomAcpCompat } from '@happier-dev/agents';
import {
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

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
    if (canonicalBackendTarget.sourceKind === 'configured' && isAgentId(normalizedBackendId) && getBackendCatalogDefinition(normalizedBackendId)) {
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
  return buildBackendTargetKeyV2(readBackendTargetRefV2(left)) === buildBackendTargetKeyV2(readBackendTargetRefV2(right));
}

export function resolveExecutionRunBuiltInAgentId(
  backendTarget: BackendTargetRefV1 | BackendTargetRefV2Input,
): string | null {
  const canonicalBackendTarget = readBackendTargetRefV2(backendTarget);
  return canonicalBackendTarget.sourceKind === 'configured' ? null : canonicalBackendTarget.backendId;
}
