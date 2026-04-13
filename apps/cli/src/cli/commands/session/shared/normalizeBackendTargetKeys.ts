import { BackendTargetKeySchema, buildBackendTargetKey, parseBackendTargetKey } from '@happier-dev/protocol';

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
