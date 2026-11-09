import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { hasOwn } from './inputRecords.js';
import type { InputOptionsConsumerV1 } from './inputOptionsConsumer.js';
import { readInputPath } from './inputPredicates.js';

/** The input facts consumed by incumbent built-in readers; free text cannot invalidate choices. */
export function projectInputOptionsDependencies(input: Readonly<Record<string, unknown>>, consumer?: InputOptionsConsumerV1, actionId?: string | null): Record<string, unknown> {
  // Contributed Action dependencies are plugin-defined, like widget bindings;
  // a host-maintained key list cannot describe their partial input schemas.
  if (parseQualifiedPluginActionId(actionId)) return { ...input };
  // Widget drafts are already projected from declared non-secret bindings at the binder. Their
  // arbitrary typed fields can be option dependencies; the built-in Action shortlist cannot name them.
  if (consumer?.kind === 'widget') return { ...input };
  const keys = ['sessionId', 'homeId', 'machineId', 'machine', 'agentId', 'backendTargetKey', 'backendTargetKeys', 'executionTarget',
    'agentTarget', 'modelId', 'modelSelection', 'configuration', 'directory', 'path', 'selection', 'capabilitySelection',
    'profileId', 'connectedServices', 'runtimeDescriptorV1', 'probe',
    'includeDisabled', 'includeUnavailable', 'limit', 'selectedPaths', 'selectedFiles', 'fieldPath', 'consumer',
    'query', 'period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis', 'breakdown'] as const;
  const dependencies: Record<string, unknown> = Object.fromEntries(keys.filter((key) => hasOwn(input, key)).map((key) => [key, input[key]]));
  if (Array.isArray(input.targets)) {
    const homeId = readInputPath(input, 'targets.0.homeId');
    const machineId = readInputPath(input, 'targets.0.machineId');
    dependencies.targets = input.targets.length === 0 ? [] : [{
      ...(typeof homeId === 'string' ? { homeId } : {}),
      ...(typeof machineId === 'string' ? { machineId } : {}),
    }];
  }
  return dependencies;
}
