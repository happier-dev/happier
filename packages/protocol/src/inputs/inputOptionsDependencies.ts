import { hasOwn } from './inputRecords.js';
import type { InputOptionsConsumerV1 } from './inputOptionsConsumer.js';

/** The input facts consumed by incumbent built-in readers; free text cannot invalidate choices. */
export function projectInputOptionsDependencies(input: Readonly<Record<string, unknown>>, consumer?: InputOptionsConsumerV1): Record<string, unknown> {
  // Widget drafts are already projected from declared non-secret bindings at the binder. Their
  // arbitrary typed fields can be option dependencies; the built-in Action shortlist cannot name them.
  if (consumer?.kind === 'widget') return { ...input };
  const keys = ['sessionId', 'machineId', 'agentId', 'backendTargetKey', 'backendTargetKeys', 'executionTarget',
    'agentTarget', 'modelId', 'modelSelection', 'configuration', 'directory', 'path', 'selection', 'mcpSelection',
    'includeDisabled', 'includeUnavailable', 'limit', 'selectedPaths', 'selectedFiles', 'fieldPath', 'consumer'] as const;
  return Object.fromEntries(keys.filter((key) => hasOwn(input, key)).map((key) => [key, input[key]]));
}
