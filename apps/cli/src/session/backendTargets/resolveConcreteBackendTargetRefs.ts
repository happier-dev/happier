import {
  convertBackendTargetRefV2ToV1,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
  type BackendTargetRefV2,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

export type ResolvedConcreteBackendTargetRefs = Readonly<{
  backendTargetV2: BackendTargetRefV2;
  backendTarget: BackendTargetRefV1;
}>;

function isConcreteBackendTargetV2(target: BackendTargetRefV2): boolean {
  const backendId = typeof target.backendId === 'string' ? target.backendId.trim() : '';
  if (!backendId || backendId === 'customAcp') {
    return false;
  }

  const configuredBackendId = typeof target.configuredBackendId === 'string' ? target.configuredBackendId.trim() : '';
  if (configuredBackendId === 'customAcp') {
    return false;
  }

  return true;
}

export function resolveConcreteBackendTargetRefs(
  input: BackendTargetRefV2Input | BackendTargetRefV1 | null | undefined,
): ResolvedConcreteBackendTargetRefs | null {
  if (input === null || input === undefined) {
    return null;
  }

  try {
    const backendTargetV2 = readBackendTargetRefV2(input as BackendTargetRefV2Input);
    if (!isConcreteBackendTargetV2(backendTargetV2)) {
      return null;
    }

    const backendTarget = convertBackendTargetRefV2ToV1(backendTargetV2);
    if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'customAcp') {
      return null;
    }

    return {
      backendTargetV2,
      backendTarget,
    };
  } catch {
    return null;
  }
}
