import { parseBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { normalizeBackendTargetKeysFromCsv } from './normalizeBackendTargetKeys';

export function parseSingleBackendTargetFromFlag(value: string | null): BackendTargetRefV1 | null {
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(value);
  if (backendTargetKeys.length !== 1) {
    return null;
  }

  return parseBackendTargetKey(backendTargetKeys[0]);
}
