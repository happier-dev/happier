import { BackendTargetKeySchema, buildBackendTargetKey } from '@happier-dev/protocol';

export function normalizeBackendTargetKeysFromCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = BackendTargetKeySchema.safeParse(entry);
      if (parsed.success) return parsed.data;
      return buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry });
    });
}
