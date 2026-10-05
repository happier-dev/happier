import { hasOwn } from './inputRecords.js';

/** The input facts consumed by incumbent built-in readers; free text cannot invalidate choices. */
export function projectInputOptionsDependencies(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const keys = ['sessionId', 'machineId', 'agentId', 'backendTargetKey', 'backendTargetKeys', 'executionTarget',
    'agentTarget', 'modelId', 'modelSelection', 'configuration', 'directory', 'path', 'selection', 'mcpSelection',
    'includeDisabled', 'includeUnavailable', 'limit', 'selectedPaths', 'selectedFiles', 'fieldPath', 'consumer'] as const;
  return Object.fromEntries(keys.filter((key) => hasOwn(input, key)).map((key) => [key, input[key]]));
}
