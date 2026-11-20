import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { hasOwn } from './inputRecords.js';
import type { InputOptionsConsumerV1 } from './inputOptionsConsumer.js';
import { writeInputPath } from './inputFieldRuntime.js';
import { readInputPath, type InputPath } from './inputPredicates.js';

/** Retain declared option operands and the custody that authorizes the read. */
export function projectInputOptionsDependencies(input: Readonly<Record<string, unknown>>, consumer?: InputOptionsConsumerV1,
  actionId?: string | null, declaredPaths?: readonly InputPath[]): Record<string, unknown> {
  if (parseQualifiedPluginActionId(actionId)) {
    if (declaredPaths === undefined) return { ...input };
    let projected: Record<string, unknown> = {};
    for (const path of ['credentialRef', 'credentialPrincipal', 'providerAccountId', 'providerIdentity.providerAccountId', ...declaredPaths]) {
      const value = readInputPath(input, path);
      if (value !== undefined) projected = writeInputPath(projected, path, value);
    }
    return projected;
  }
  // Widget drafts are already projected from declared non-secret bindings at the binder. Their
  // arbitrary typed fields can be option dependencies; the built-in Action shortlist cannot name them.
  if (consumer?.kind === 'widget') return { ...input };
  const keys = ['sessionId', 'homeId', 'machineId', 'machine', 'agentId', 'backendTargetKey', 'backendTargetKeys', 'executionTarget',
    'agentTarget', 'modelId', 'modelSelection', 'configuration', 'configId', 'directory', 'path', 'selection', 'capabilitySelection',
    'profileId', 'connectedServices', 'runtimeDescriptorV1', 'probe',
    'includeDisabled', 'includeUnavailable', 'limit', 'scope', 'selectedPaths', 'selectedFiles', 'fieldPath', 'consumer',
    'query', 'period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis', 'breakdown', 'environment'] as const;
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
