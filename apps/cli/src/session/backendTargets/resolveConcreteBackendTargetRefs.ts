import {
  BackendTargetRefV2Schema,
  convertBackendTargetRefV2ToV1,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
  type BackendTargetRefV2,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import { isConcreteBackendTargetCompatId } from './compat/customAcp';

export type ResolvedConcreteBackendTargetRefs = Readonly<{
  backendTargetV2: BackendTargetRefV2;
  backendTarget: BackendTargetRefV1;
}>;

function isConcreteBackendTargetV2(target: BackendTargetRefV2): boolean {
  const backendId = typeof target.backendId === 'string' ? target.backendId.trim() : '';
  if (!isConcreteBackendTargetCompatId(backendId)) {
    return false;
  }

  const configuredBackendId = typeof target.configuredBackendId === 'string' ? target.configuredBackendId.trim() : '';
  if (configuredBackendId && !isConcreteBackendTargetCompatId(configuredBackendId)) {
    return false;
  }

  return true;
}

function normalizeBackendTargetV2(target: BackendTargetRefV2): BackendTargetRefV2 | null {
  const backendId = target.backendId.trim();
  const configuredBackendId = target.configuredBackendId?.trim();
  if (target.configuredBackendId !== undefined && !configuredBackendId) {
    return null;
  }
  if (target.sourceKind === 'configured' || configuredBackendId) {
    return {
      kind: 'backend',
      backendId,
      configuredBackendId: configuredBackendId && configuredBackendId.length > 0 ? configuredBackendId : backendId,
      sourceKind: 'configured',
    };
  }
  return {
    kind: 'backend',
    backendId,
    sourceKind: 'built_in',
  };
}

export function resolveConcreteBackendTargetRefV2(
  input: BackendTargetRefV2 | null | undefined,
): BackendTargetRefV2 | null {
  if (input === null || input === undefined) {
    return null;
  }

  try {
    const backendTargetV2 = normalizeBackendTargetV2(BackendTargetRefV2Schema.parse(input));
    return backendTargetV2 && isConcreteBackendTargetV2(backendTargetV2) ? backendTargetV2 : null;
  } catch {
    return null;
  }
}

export function resolveConcreteCompatBackendTargetRefs(
  input: BackendTargetRefV2Input | BackendTargetRefV1 | null | undefined,
): ResolvedConcreteBackendTargetRefs | null {
  if (input === null || input === undefined) {
    return null;
  }

  let backendTargetV2: BackendTargetRefV2;
  try {
    const normalizedBackendTargetV2 = normalizeBackendTargetV2(
      readBackendTargetRefV2(input as BackendTargetRefV2Input),
    );
    if (!normalizedBackendTargetV2) {
      return null;
    }
    backendTargetV2 = normalizedBackendTargetV2;
  } catch {
    return null;
  }

  if (!isConcreteBackendTargetV2(backendTargetV2)) {
    return null;
  }

  const backendTarget = convertBackendTargetRefV2ToV1(backendTargetV2);
  if (backendTarget.kind === 'builtInAgent' && !isConcreteBackendTargetCompatId(backendTarget.agentId)) {
    return null;
  }

  return {
    backendTargetV2,
    backendTarget,
  };
}
