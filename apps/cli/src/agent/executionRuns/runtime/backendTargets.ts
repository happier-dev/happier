import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

export function resolveExecutionRunRuntimeBackendId(backendTarget: BackendTargetRefV1): string {
  return backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp';
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
