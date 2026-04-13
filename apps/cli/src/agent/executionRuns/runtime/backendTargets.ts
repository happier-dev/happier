import { getBackendDefinition, type AgentId } from '@happier-dev/agents';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

export function isExecutionRunConcreteBackendTarget(backendTarget: BackendTargetRefV1): boolean {
  if (backendTarget.kind === 'builtInAgent') {
    return backendTarget.agentId !== 'customAcp';
  }
  return backendTarget.backendId !== 'customAcp';
}

export function resolveExecutionRunRuntimeBackendId(backendTarget: BackendTargetRefV1): string {
  return resolveExecutionRunPublicBackendId(backendTarget);
}

export function resolveExecutionRunPublicBackendId(backendTarget: BackendTargetRefV1): string {
  return backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget.backendId;
}

export function matchesExecutionRunLegacyBackendId(
  backendTarget: BackendTargetRefV1,
  backendId: string,
): boolean {
  const normalizedBackendId = String(backendId ?? '').trim();
  if (!normalizedBackendId) return false;

  const publicBackendId = resolveExecutionRunPublicBackendId(backendTarget);
  if (publicBackendId === normalizedBackendId) {
    if (backendTarget.kind === 'configuredAcpBackend' && getBackendDefinition(normalizedBackendId as AgentId)) {
      return false;
    }
    return true;
  }

  return backendTarget.kind === 'configuredAcpBackend' && normalizedBackendId === 'customAcp';
}

export function areExecutionRunBackendTargetsEqual(
  left: BackendTargetRefV1 | null | undefined,
  right: BackendTargetRefV1 | null | undefined,
): boolean {
  if (!left || !right) return false;
  return buildBackendTargetKey(left) === buildBackendTargetKey(right);
}

export function resolveExecutionRunBuiltInAgentId(backendTarget: BackendTargetRefV1): string | null {
  return backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : null;
}
