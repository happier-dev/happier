import { BackendTargetKeySchema, buildBackendTargetKey, parseBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

function normalizeBackendTargetKeyFromInput(entry: string): string | null {
  const parsed = BackendTargetKeySchema.safeParse(entry);
  if (parsed.success) {
    const backendTarget = parseBackendTargetKey(parsed.data);
    if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'customAcp') {
      return null;
    }
    return parsed.data;
  }

  if (entry === 'customAcp') {
    return null;
  }

  return buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry });
}

export function normalizeBackendTargetKeysFromCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeBackendTargetKeyFromInput(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function parseSingleBackendTargetFromFlag(value: string | null): BackendTargetRefV1 | null {
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(value);
  if (backendTargetKeys.length !== 1) {
    return null;
  }

  return parseBackendTargetKey(backendTargetKeys[0]);
}
